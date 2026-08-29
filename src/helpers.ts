// 事件/参数形状提取纯函数（供 hook 单测与入口内部使用）
// [2026-08-29]-[从 index.ts 迁出：opencode legacy 插件加载器会把入口模块的每个函数导出
//  当插件工厂调用并塞进 hooks（返回 null 即崩 provider.list/config 钩子），入口只允许导出插件函数]-[修复启动报错]
import type { ModelKey } from "./types"

// [2026-08-29]-[修复复审P1-chat.params 形状：input.model 是 Model 对象（plugin/src/index.ts:248，
//  schema model.ts:16 providerID + id），provider 是 ProviderContext 对象——非字符串]
export function chatParamsModelKey(input: unknown): ModelKey | null {
  const m = (input as any)?.model
  const providerID = typeof m?.providerID === "string" ? m.providerID : ""
  const id = typeof m?.id === "string" ? m.id : ""
  return providerID && id ? (`${providerID}/${id}` as ModelKey) : null
}

// [2026-08-29]-[修复复审P1-session.deleted 形状：事件 properties 为 {info:{id,...}}（sdk types.gen.ts:576-580）；
//  保留 .sessionID/.session.id 兜底链兼容旧形状]
export function sessionDeletedId(properties: unknown): string | null {
  const p = (properties ?? {}) as any
  const id = p?.info?.id ?? p?.sessionID ?? p?.session?.id
  return typeof id === "string" && id ? id : null
}

/** session.created 事件 → {id, agent}（properties.info；agent 供预注册分类）
 *  注：sdk types.gen.ts 的 Session 类型缺 agent 字段，但运行时 SessionSchema.Info 含 agent（clone schema/src/session.ts:224-238），此处按运行时形状实现 */
export function sessionCreatedInfo(properties: unknown): { id: string; agent: string } | null {
  const info = (properties as any)?.info
  const id = info?.id
  const agent = info?.agent
  return typeof id === "string" && id && typeof agent === "string" && agent ? { id, agent } : null
}
