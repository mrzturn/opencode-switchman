// ROUTE_META 解析器（纯函数零依赖；行为契约由 27 项 fixture 锁死）
// 27 项 fixture 的行为契约：前 4000 字符窗口、JSON/k=v 双格式、六键白名单、值小写、
// 合法值硬校验、安全字段（source/role/capability）缺失即坏 META。
import { META_KEYS, META_LEGAL, META_REQUIRED, META_SAMPLE } from "./types"
import type { Meta, MetaErr, MetaKey } from "./types"

export function parseRouteMeta(prompt: unknown): [Meta | null, MetaErr | null] {
  if (typeof prompt !== "string" || !prompt) return [null, "missing"]
  const m = /^ROUTE_META[ \t]+(.+)$/m.exec(prompt.slice(0, 4000))
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
  if (err === "missing") return `缺 ROUTE_META 行（委派 prompt 前部须固定携带）；META 格式样例：${META_SAMPLE}`
  if (err === "malformed") return `ROUTE_META 行格式坏（须单行 JSON 或 k=v 空格分隔）；META 格式样例：${META_SAMPLE}`
  const kind = err.kind
  if (kind === "invalid") {
    const legal = META_LEGAL[err.field as MetaKey].join("/")
    return `ROUTE_META.${err.field}='${err.value}' 非法（合法值：${legal}）；META 格式样例：${META_SAMPLE}`
  }
  const legal = META_LEGAL[err.field as MetaKey].join("/")
  return `ROUTE_META 缺安全字段 ${err.field}（必填，合法值：${legal}）；META 格式样例：${META_SAMPLE}`
}
