// [2026-09-04]-[English localization: translate CLI messages and comments; no logic change]
// Event/parameter shape extraction pure functions (for hook unit tests and entry internals)
// [2026-08-29]-[Moved out of index.ts: the opencode legacy plugin loader calls every exported function of the entry module
//  as a plugin factory and stuffs them into hooks (returning null crashes the provider.list/config hooks); the entry may only export plugin functions]-[fixed startup error]
import type { ModelKey } from "./types"

// [2026-08-29]-[Fix review P1 chat.params shape: input.model is a Model object (plugin/src/index.ts:248,
//  schema model.ts:16 providerID + id) and provider is a ProviderContext object — not strings]
export function chatParamsModelKey(input: unknown): ModelKey | null {
  const m = (input as any)?.model
  const providerID = typeof m?.providerID === "string" ? m.providerID : ""
  const id = typeof m?.id === "string" ? m.id : ""
  return providerID && id ? (`${providerID}/${id}` as ModelKey) : null
}

// [2026-08-29]-[Fix review P1 session.deleted shape: event properties are {info:{id,...}} (sdk types.gen.ts:576-580);
//  keeps the .sessionID/.session.id fallback chain for older shapes]
export function sessionDeletedId(properties: unknown): string | null {
  const p = (properties ?? {}) as any
  const id = p?.info?.id ?? p?.sessionID ?? p?.session?.id
  return typeof id === "string" && id ? id : null
}

/** session.created event → {id, agent} (properties.info; agent used for pre-registration classification)
 *  Note: the sdk types.gen.ts Session type lacks the agent field, but the runtime SessionSchema.Info contains it (clone schema/src/session.ts:224-238); implemented per the runtime shape here */
export function sessionCreatedInfo(properties: unknown): { id: string; agent: string } | null {
  const info = (properties as any)?.info
  const id = info?.id
  const agent = info?.agent
  return typeof id === "string" && id && typeof agent === "string" && agent ? { id, agent } : null
}
