// [2026-09-04]-[图片中继纯函数：主会话模型无视觉时，把消息里的图片部件替换为「落盘路径+读图指引」
//  文本部件（vision 壳/MCP 视觉工具按路径接力），宿主不再对无视觉模型注入图片而报错。
//  writeFile 注入便于测试；默认写盘器自建目录。fail-open 语义由调用方（index.ts transform 钩子）保证]
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

export interface RelayImageOpts {
  /** true=有视觉不动；false=无视觉需中继；null=元数据未知 → fail-open 不动 */
  modelVision: boolean | null
  /** vision lane 链首候选壳名（null=只保留路径与 MCP 指引） */
  visionHead: string | null
  /** data URL 落盘目录（调用方按 sessionID 划分） */
  writeDir: string
  /** 写盘注入（测试用）；缺省=mkdir + writeFileSync */
  writeFile?: (path: string, bytes: Uint8Array) => Promise<void> | void
}

export interface RelayImageResult {
  parts: unknown[]
  changed: boolean
  /** 本次中继涉及的图片路径列表（落盘或原值引用） */
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
  /** data: URL / http(s) URL / 本地路径；防御式部件可能为空串 */
  url: string
  /** 防御式部件可能直接携带字节 */
  bytes: Uint8Array | null
}

/** 防御式图片部件识别：type==="file" 且 mime 以 image/ 开头，或 type==="image"（任意宿主形状） */
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
    return `[opencode-switchman] 本会话模型无视觉输入，图片未直接注入（避免宿主报错）。已落盘：\n${list}\n请读图：委派 vision 壳 ${visionHead}（ROUTE_META {"lane":"vision","role":"observer","modality":"image","capability":"ro","source":"auto"}，prompt 中给上述路径）；或调用 MCP 视觉工具传路径。`
  }
  return `[opencode-switchman] 本会话模型无视觉输入，图片未直接注入（避免宿主报错）。已落盘：\n${list}\n请读图：调用 MCP 视觉工具传路径。`
}

/**
 * 主流程：modelVision 非 false 或无图片部件 → 原样返回（changed=false）。
 * 有图片部件：data URL 解 base64 落盘 `<writeDir>/<part.id>.<ext>`；本地路径/http URL 用原值；
 * 全部图片部件替换为第一个命中位置上的单个文本部件（含全部路径与读图指引）。
 * 单张写盘失败 → 保留原部件（该图不进指引），其余继续。
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
      path = ref // 已是 http URL：原值
    } else if (ref) {
      path = ref.startsWith("file://") ? ref.slice("file://".length) : ref // 本地路径：原值
    }
    if (bytes && bytes.byteLength > 0 && path) {
      try {
        await write(path, bytes)
      } catch {
        out.push(parts[i]) // 写盘失败 fail-open：保留原部件
        continue
      }
    } else if (!ref) {
      out.push(parts[i]) // 既无引用也无字节：原样保留
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
