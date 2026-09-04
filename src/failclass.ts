// [2026-09-04]-[English localization: translate comments; no logic change]
// Vendor-agnostic failure classification layer (pure function, no dependencies)
// [2026-08-29]-[generalized failure classification: transient 429 vs genuinely exhausted quota are kept apart; no pool
//  hardcoding — any vendor's error string can be classified]
// Matching order = priority: specialized first (not_found/rate_limit/quota), then generic (auth/server/network).
// Note: the Chinese patterns below (已下线/余额不足/配额…) classify upstream provider error text, not this plugin's own copy.
export type FailureCategory =
  | "rate_limit"
  | "quota"
  | "auth"
  | "not_found"
  | "server"
  | "network"
  // [2026-09-01]-[config-layer failures separated from transient failures: unregistered shell = dispatch layer
  //  (no isolation, no breaker); incompatible endpoint = permanent config error (long-TTL isolation; a 30-minute retry is pointless)]
  | "shell_injection"
  | "endpoint"
  | "unknown"

export function classifyFailure(reason: string): FailureCategory {
  const s = String(reason ?? "").toLowerCase()

  // not_found (model name invalid / decommissioned: permanent class, triggers model retirement)
  if (
    /\b404\b/.test(s) || /not found/.test(s) || /does not exist/.test(s) ||
    /no such model/.test(s) || /unknown model/.test(s) || /invalid model/.test(s) ||
    /decommissioned/.test(s) || /已下线/.test(s)
  ) return "not_found"

  // shell_injection (shell not registered as an opencode agent: dispatch/injection-layer failure, unrelated to model
  //  health — no isolation, no breaker; a probe-ok model must not be poisoned for 30 minutes by a gating miss)
  if (/unknown agent type/.test(s) || /not a valid agent/.test(s) || /no such agent/.test(s)) return "shell_injection"

  // endpoint (model exists but endpoint/shape incompatible: permanent config-layer error, short-cycle retries are
  //  pointless → long-TTL isolation)
  if (
    /not accessible via/.test(s) || /completions endpoint/.test(s) ||
    /does not support/.test(s) || /unsupported (model|endpoint)/.test(s)
  ) return "endpoint"

  // rate_limit (transient throttling: short-TTL in-memory isolation; never verdict a pool as exhausted)
  if (
    /\b429\b/.test(s) || /rate limit/.test(s) || /too many requests/.test(s) ||
    /throttl/.test(s) || /requests per/.test(s)
  ) return "rate_limit"

  // quota (genuinely exhausted quota)
  if (
    /\b402\b/.test(s) || /payment required/.test(s) || /insufficient (balance|credit|funds)/.test(s) ||
    /余额不足/.test(s) || /配额(不足|已用完|超限)/.test(s) ||
    /(monthly|weekly|daily).*(limit|exhaust|quota)/.test(s) ||
    /quota.*(exceed|limit|exhaust)/.test(s) || /exceeded.*(quota|limit)/.test(s) ||
    /credit|billing/.test(s)
  ) return "quota"
  // 403 special case: verdict quota only when the same string also contains quota/balance/credit/billing/limit; otherwise auth
  if (/\b403\b/.test(s)) {
    return /quota|balance|credit|billing|limit/.test(s) ? "quota" : "auth"
  }

  // auth (authentication failure)
  if (
    /\b401\b/.test(s) || /unauthorized/.test(s) || /invalid api key/.test(s) ||
    /authentication/.test(s) || /forbidden/.test(s) || /api key (invalid|expired)/.test(s)
  ) return "auth"

  // server (server-side 5xx / overload)
  if (
    /\b5\d\d\b/.test(s) || /internal server error/.test(s) || /bad gateway/.test(s) ||
    /service unavailable/.test(s) || /overloaded/.test(s) || /capacity/.test(s) || /upstream/.test(s)
  ) return "server"

  // network (connection/transport layer)
  if (
    /timeout/.test(s) || /econnrefused/.test(s) || /enotfound/.test(s) || /econnreset/.test(s) ||
    /eai_again/.test(s) || /ssl|tls/.test(s) || /fetch failed/.test(s) || /network/.test(s)
  ) return "network"

  return "unknown"
}
