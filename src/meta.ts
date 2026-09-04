// [2026-09-04]-[English localization: translate comments and deny/hint messages; no logic change]
// ROUTE_META parser (pure function, zero dependencies; behavior contract locked by 27 fixtures)
// Behavior contract of the 27 fixtures: first-4000-char window, JSON/k=v dual format, six-key whitelist,
// lowercase values, hard validation of legal values, missing required fields (source/role/capability) = bad META.
import { META_KEYS, META_LEGAL, META_REQUIRED, META_SAMPLE } from "./types"
import type { Meta, MetaErr, MetaKey } from "./types"

export function parseRouteMeta(prompt: unknown): [Meta | null, MetaErr | null] {
  if (typeof prompt !== "string" || !prompt) return [null, "missing"]
  // [2026-09-01]-[LLMs occasionally wrap the protocol line in Markdown decoration; strip the semantic-free
  //  decoration so valid metadata is not wrongly rejected.]
  const m = /^[ \t]*(?:>[ \t]*|[-*+][ \t]+)?`?ROUTE_META`?(?:[ \t]*:[ \t]*|[ \t]+)(.+)$/m.exec(prompt.slice(0, 4000))
  if (!m) return [null, "missing"]
  const raw = m[1]!.trim()
  let meta: Record<string, unknown> | null = null
  try {
    const v = JSON.parse(raw)
    if (v && typeof v === "object" && !Array.isArray(v)) meta = v
  } catch {
    const pairs: Record<string, string> = {}
    let ok = true
    for (const tok of raw.split(/\s+/)) {
      const idx = tok.indexOf("=")
      if (idx <= 0 || idx === tok.length - 1) {
        ok = false
        break
      }
      pairs[tok.slice(0, idx)] = tok.slice(idx + 1)
    }
    meta = ok && Object.keys(pairs).length > 0 ? pairs : null
  }
  if (!meta || typeof meta !== "object") return [null, "malformed"]
  const out: Meta = {}
  for (const k of META_KEYS) {
    const v = meta[k]
    if (typeof v === "string" && v.trim()) (out as any)[k] = v.trim().toLowerCase()
  }
  if (Object.keys(out).length === 0) return [null, "malformed"]
  for (const k of Object.keys(out) as MetaKey[]) {
    if (!META_LEGAL[k].includes((out as any)[k])) {
      return [null, { kind: "invalid", field: k, value: (out as any)[k] }]
    }
  }
  for (const k of META_REQUIRED) {
    if (!(k in out)) return [null, { kind: "required", field: k }]
  }
  return [out, null]
}

export function metaErrorHint(err: MetaErr | null): string {
  if (err === null) return ""
  if (err === "missing") return `missing ROUTE_META line (must always be carried at the top of the delegation prompt); META format sample: ${META_SAMPLE}`
  if (err === "malformed") return `ROUTE_META line malformed (must be single-line JSON or space-separated k=v); META format sample: ${META_SAMPLE}`
  const kind = err.kind
  if (kind === "invalid") {
    const legal = META_LEGAL[err.field as MetaKey].join("/")
    return `ROUTE_META.${err.field}='${err.value}' is invalid (legal values: ${legal}); META format sample: ${META_SAMPLE}`
  }
  const legal = META_LEGAL[err.field as MetaKey].join("/")
  return `ROUTE_META missing required field ${err.field} (required, legal values: ${legal}); META format sample: ${META_SAMPLE}`
}
