// 厂商无关失败分类层（纯函数，无依赖）
// [2026-08-29]-[泛化失败分类：瞬时 429 与真额度用尽口径分离；不再硬编码三池，任何厂商错误串可归类]
// 匹配顺序即优先级：先 specialize（not_found/rate_limit/quota）后 generic（auth/server/network）。
export type FailureCategory =
  | "rate_limit"
  | "quota"
  | "auth"
  | "not_found"
  | "server"
  | "network"
  | "unknown"

export function classifyFailure(reason: string): FailureCategory {
  const s = String(reason ?? "").toLowerCase()

  // not_found（模型名失效/已下线：永久类，触发模型退休）
  if (
    /\b404\b/.test(s) || /not found/.test(s) || /does not exist/.test(s) ||
    /no such model/.test(s) || /unknown model/.test(s) || /invalid model/.test(s) ||
    /decommissioned/.test(s) || /已下线/.test(s)
  ) return "not_found"

  // rate_limit（瞬时限流：短 TTL 内存隔离，绝不判池耗尽）
  if (
    /\b429\b/.test(s) || /rate limit/.test(s) || /too many requests/.test(s) ||
    /throttl/.test(s) || /requests per/.test(s)
  ) return "rate_limit"

  // quota（真额度用尽）
  if (
    /\b402\b/.test(s) || /payment required/.test(s) || /insufficient (balance|credit|funds)/.test(s) ||
    /余额不足/.test(s) || /配额(不足|已用完|超限)/.test(s) ||
    /(monthly|weekly|daily).*(limit|exhaust|quota)/.test(s) ||
    /quota.*(exceed|limit|exhaust)/.test(s) || /exceeded.*(quota|limit)/.test(s) ||
    /credit|billing/.test(s)
  ) return "quota"
  // 403 特殊：仅同串含 quota/balance/credit/billing/limit 才判 quota，否则归 auth
  if (/\b403\b/.test(s)) {
    return /quota|balance|credit|billing|limit/.test(s) ? "quota" : "auth"
  }

  // auth（鉴权失效）
  if (
    /\b401\b/.test(s) || /unauthorized/.test(s) || /invalid api key/.test(s) ||
    /authentication/.test(s) || /forbidden/.test(s) || /api key (invalid|expired)/.test(s)
  ) return "auth"

  // server（服务端 5xx / 过载）
  if (
    /\b5\d\d\b/.test(s) || /internal server error/.test(s) || /bad gateway/.test(s) ||
    /service unavailable/.test(s) || /overloaded/.test(s) || /capacity/.test(s) || /upstream/.test(s)
  ) return "server"

  // network（连接/传输层）
  if (
    /timeout/.test(s) || /econnrefused/.test(s) || /enotfound/.test(s) || /econnreset/.test(s) ||
    /eai_again/.test(s) || /ssl|tls/.test(s) || /fetch failed/.test(s) || /network/.test(s)
  ) return "network"

  return "unknown"
}
