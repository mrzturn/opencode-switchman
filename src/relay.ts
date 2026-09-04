// [2026-09-04]-[image relay pure functions: when the main session model has no vision, replace image parts in the message with a
//  "persisted paths + image-reading guidance" text part (vision shells/MCP vision tools pick up by path), so the host no longer
//  errors injecting images into a non-vision model.
//  writeFile injection eases testing; the default writer creates directories itself. fail-open semantics are guaranteed by the caller (index.ts transform hook)]
// [2026-09-04]-[English localization: translate runtime messages and comments; no logic change]
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

export interface RelayImageOpts {
  /** true = has vision, leave as-is; false = no vision, relay needed; null = metadata unknown → fail-open, leave as-is */
  modelVision: boolean | null
  /** vision lane chain-head candidate shell name (null = keep only paths and MCP guidance) */
  visionHead: string | null
  /** directory where data URLs are persisted (caller partitions by sessionID) */
  writeDir: string
  /** writer injection (for tests); default = mkdir + writeFileSync */
  writeFile?: (path: string, bytes: Uint8Array) => Promise<void> | void
}

export interface RelayImageResult {
  parts: unknown[]
  changed: boolean
  /** image paths involved in this relay (persisted or referenced by original value) */
  paths: string[]
}

const IMAGE_EXT_FALLBACK = "png"

function extOfMime(mime: string): string {
  const sub = String(mime ?? "").split("/")[1]?.split(";")[0]?.replace(/[^a-z0-9]/gi, "") ?? ""
  return sub || IMAGE_EXT_FALLBACK
}

function parseDataUrl(url: string): { mime: string; bytes: Uint8Array } | null {
  const m = /^data:([^;,]*)?;base64,(.+)$/s.exec(url)
  if (!m) return null
  try {
    return { mime: m[1] || "image/png", bytes: new Uint8Array(Buffer.from(m[2]!, "base64")) }
  } catch {
    return null
  }
}

async function defaultWriteFile(path: string, bytes: Uint8Array): Promise<void> {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, bytes)
}

interface ImageHit {
  id: string
  sessionID?: string
  messageID?: string
  mime: string
  /** data: URL / http(s) URL / local path; defensive parts may carry an empty string */
  url: string
  /** defensive parts may carry raw bytes directly */
  bytes: Uint8Array | null
}

/** Defensive image-part detection: type==="file" with mime starting image/, or type==="image" (any host shape) */
function imageOf(part: unknown): ImageHit | null {
  const p = part as any
  if (!p || typeof p !== "object") return null
  if (p.type === "file") {
    const mime = typeof p.mime === "string" ? p.mime : ""
    if (!mime.startsWith("image/")) return null
    return { id: String(p.id ?? ""), sessionID: p.sessionID, messageID: p.messageID, mime, url: String(p.url ?? ""), bytes: null }
  }
  if (p.type === "image") {
    const url = typeof p.url === "string" && p.url ? p.url
      : typeof p.imageURL === "string" && p.imageURL ? p.imageURL
        : typeof p.image === "string" && p.image ? p.image : ""
    const mime = typeof p.mime === "string" && p.mime ? p.mime : "image/png"
    const bytes = p.data instanceof Uint8Array ? p.data : null
    if (!url && !bytes) return null
    return { id: String(p.id ?? ""), sessionID: p.sessionID, messageID: p.messageID, mime, url, bytes }
  }
  return null
}

function guidanceText(paths: string[], visionHead: string | null): string {
  const list = paths.join("\n")
  if (visionHead) {
    return `[opencode-switchman] This session's model has no vision input; images were not injected directly (avoids host errors). Persisted to disk:\n${list}\nTo read them: delegate the vision shell ${visionHead} (ROUTE_META {"lane":"vision","role":"observer","modality":"image","capability":"ro","source":"auto"}, include the paths above in the prompt), or call an MCP vision tool with these paths.`
  }
  return `[opencode-switchman] This session's model has no vision input; images were not injected directly (avoids host errors). Persisted to disk:\n${list}\nTo read them: call an MCP vision tool with these paths.`
}

/**
 * Main flow: modelVision not false, or no image parts → return as-is (changed=false).
 * With image parts: data URLs are base64-decoded and persisted to `<writeDir>/<part.id>.<ext>`; local paths/http URLs keep the original value;
 * all image parts are replaced by a single text part at the first hit position (carrying all paths and reading guidance).
 * A single write failure → keep the original part (that image stays out of the guidance), the rest continue.
 */
export async function relayImageParts(parts: unknown[], opts: RelayImageOpts): Promise<RelayImageResult> {
  if (opts.modelVision !== false) return { parts, changed: false, paths: [] }
  if (!Array.isArray(parts)) return { parts, changed: false, paths: [] }
  const write = opts.writeFile ?? defaultWriteFile
  const out: unknown[] = []
  const saved: string[] = []
  let insertAt = -1
  let sid: string | undefined
  let mid: string | undefined
  let idSeed = ""
  for (let i = 0; i < parts.length; i++) {
    const hit = imageOf(parts[i])
    if (!hit) {
      out.push(parts[i])
      continue
    }
    let path: string | null = null
    let bytes: Uint8Array | null = hit.bytes
    let ref = hit.url
    if (ref.startsWith("data:")) {
      const parsed = parseDataUrl(ref)
      if (parsed) {
        bytes = parsed.bytes
        path = join(opts.writeDir, `${hit.id || `img-${saved.length + 1}`}.${extOfMime(parsed.mime)}`)
        ref = path
      }
    } else if (/^https?:\/\//i.test(ref)) {
      path = ref // already an http URL: keep the original value
    } else if (ref) {
      path = ref.startsWith("file://") ? ref.slice("file://".length) : ref // local path: keep the original value
    }
    if (bytes && bytes.byteLength > 0 && path) {
      try {
        await write(path, bytes)
      } catch {
        out.push(parts[i]) // write failure fail-open: keep the original part
        continue
      }
    } else if (!ref) {
      out.push(parts[i]) // neither reference nor bytes: keep as-is
      continue
    }
    if (path) {
      if (insertAt < 0) {
        insertAt = i
        sid = hit.sessionID
        mid = hit.messageID
        idSeed = hit.id || "relay"
      }
      saved.push(path)
    }
  }
  if (saved.length === 0) return { parts, changed: false, paths: [] }
  const textPart: Record<string, unknown> = {
    id: `${idSeed}-swm-relay`,
    type: "text",
    text: guidanceText(saved, opts.visionHead),
    synthetic: true,
  }
  if (sid) textPart.sessionID = sid
  if (mid) textPart.messageID = mid
  out.splice(insertAt, 0, textPart)
  return { parts: out, changed: true, paths: saved }
}
