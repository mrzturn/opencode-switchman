// [2026-09-04]-[auto-handover 核心抽出：TUI 手动 /handover 与主插件 tool.execute.after 自动触发共用。
//  纯逻辑无 UI：fork 全量备份（不传 messageID=复制全部消息）→ 备份标题加 [backup] → summarize
//  压缩当前会话（沿用最后一条 assistant 的 provider/model）→ 不切换会话（区别于内置 /fork）。
//  压缩后 agent 循环下一步经 filterCompactedEffect 重读消息（宿主 prompt.ts while 循环），
//  任务以「摘要+保留尾巴」上下文自动继续——宿主设计内行为，无竞态（钩子在工具路径内被 await 串行）]
export interface HandoverPort {
  /** 全量 fork：返回新会话 { id, title }；失败返回 null */
  forkFull(sessionID: string, directory: string): Promise<{ id: string; title: string | undefined } | null>
  /** 改标题（[backup] 标记；失败 fail-open 不阻断压缩） */
  setTitle(sessionID: string, directory: string, title: string): Promise<boolean>
  /** 取最后一条 assistant 消息的 provider/model（压缩用；无则跳过压缩） */
  lastAssistantModel(sessionID: string, directory: string): Promise<{ providerID: string; modelID: string } | null>
  /** 压缩（summarize）：返回是否成功 */
  compact(sessionID: string, directory: string, model: { providerID: string; modelID: string }): Promise<boolean>
}

export interface HandoverResult {
  ok: boolean
  /** 备份会话 ID（fork 成功时存在） */
  backupID?: string
  /** 是否完成当前会话压缩 */
  compacted: boolean
  message: string
}

/** 备份标题：fork 计数后缀（orig (fork #N)）保证多次备份唯一 */
export function backupTitle(forkTitle: string | undefined, sessionID: string): string {
  return `[backup] ${forkTitle ?? sessionID}`
}

export async function runHandover(port: HandoverPort, sessionID: string, directory: string): Promise<HandoverResult> {
  try {
    const forked = await port.forkFull(sessionID, directory)
    if (!forked?.id) return { ok: false, compacted: false, message: `session.fork 失败（未返回新会话）` }
    const marked = await port.setTitle(forked.id, directory, backupTitle(forked.title, sessionID)).catch(() => false)
    const model = await port.lastAssistantModel(sessionID, directory)
    const compacted = model ? await port.compact(sessionID, directory, model) : false
    const mark = marked ? "（[backup] 标记）" : ""
    return {
      ok: true,
      backupID: forked.id,
      compacted,
      message: compacted
        ? `已全量备份为会话 ${forked.id.slice(0, 8)}…${mark}并压缩当前会话`
        : `已全量备份为会话 ${forked.id.slice(0, 8)}…${mark}；未取到模型信息，跳过当前会话压缩`,
    }
  } catch (exc) {
    return { ok: false, compacted: false, message: `handover 失败：${exc instanceof Error ? exc.message : String(exc)}` }
  }
}

/** v1 SDK 适配器（主插件 input.client，path/query/body 风格；RequestResult fields 非抛错） */
export function v1HandoverPort(client: {
  session: {
    fork(opts: any): Promise<any>
    update(opts: any): Promise<any>
    messages(opts: any): Promise<any>
    summarize(opts: any): Promise<any>
  }
}): HandoverPort {
  return {
    async forkFull(sessionID, directory) {
      const res = await client.session.fork({ path: { id: sessionID }, query: { directory } })
      const data = res?.data
      return data?.id ? { id: String(data.id), title: typeof data.title === "string" ? data.title : undefined } : null
    },
    async setTitle(sessionID, directory, title) {
      const res = await client.session.update({ path: { id: sessionID }, query: { directory }, body: { title } })
      return !res?.error
    },
    async lastAssistantModel(sessionID, directory) {
      const res = await client.session.messages({ path: { id: sessionID }, query: { directory } }).catch(() => null)
      const rows: any[] = Array.isArray(res?.data) ? res.data : []
      for (const row of [...rows].reverse()) {
        const info = row?.info ?? row
        if (info?.providerID && info?.modelID) return { providerID: String(info.providerID), modelID: String(info.modelID) }
      }
      return null
    },
    async compact(sessionID, directory, model) {
      const res = await client.session.summarize({
        path: { id: sessionID },
        query: { directory },
        body: { providerID: model.providerID, modelID: model.modelID },
      })
      return !res?.error
    },
  }
}
