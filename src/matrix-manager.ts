// 动态矩阵管理器（v1.3）：会话注册表、state 目录 watch、重算编排、探针差集
// [2026-08-29]-[修复复审P1-首轮时序：system.transform 早于 chat.params（opencode session/llm/request.ts:69-73 vs 114-121），
// 首轮注册表为空 → 壳子代理被误注入调度员规程。修=监听 session.created 预注册（agent 名记录）+
// 分类只按 agent 名：注入壳名集合∪内部代理，不依赖注册表时序]
import { watch, statSync, type FSWatcher } from "node:fs"
import { readJson, writeJsonAtomic, paths, nowIso, appendStatusLog } from "./state"
import { readConfigured, computeActivation, sameActivation, sortUnique, desktopDatPath, tuiModelPath, watchDirs } from "./activation"
import type { ActivationState, MatrixRunMode, ModelKey } from "./types"
import type { ShellDefinition } from "./catalog"

// 内部代理（title/compaction/summary）：有 agent 字段但不计入会话模型
export const INTERNAL_AGENTS = new Set(["title", "compaction", "summary"])
/** 监听的目标文件名（watchDirs[0]=global.dat 目录；watchDirs[1]=stateRoot） */
const WATCH_FILENAMES = new Set(["opencode.global.dat", "model.json"])

export interface SessionInfo {
  agent: string
  modelKey: ModelKey | null
  isShell: boolean
  updatedAt: number
}

export interface MatrixManagerOptions {
  stateRoot: string
  mode: Exclude<MatrixRunMode, "legacy">
  superset: readonly ShellDefinition[]
  /** config 钩子成功注入的壳名集合（isShell 判定唯一真源，禁启发式） */
  injectedNames: ReadonlySet<string>
  /** 超集内已知 provider（超集外→restartRequired） */
  knownProviders: ReadonlySet<string>
  watchEnabled?: boolean
  debounceMs?: number
  pollMs?: number
  /** 重算回调：清横幅缓存＋提交探针差集；source 区分触发面（config=可见集/favorites 变化） */
  onRecompute?: (state: ActivationState, newTargets: string[], source: RecomputeSource) => void
}

/** 重算触发源：config=配置面文件变化（desktop 可见集开关/TUI favorites 增删）；
 *  session=会话模型切换/删除；startup=config 钩子直调首轮 */
export type RecomputeSource = "config" | "session" | "startup"

export const WATCH_DEBOUNCE_MS = 500
// [2026-09-02]-[30s→2s：实测 fs.watch 事件在 opencode 宿主进程内不投递（独立 Bun 脚本同目录正常，
// 插件内真实 favorites 变更 22s 后才被 30s 轮询兜住），mtime 轮询是实际生效路径；statSync×2/2s 成本
// 可忽略，2s 轮询+500ms debounce ≈ favorites 变更 2.5s 内生效]-[favorites/可见集变更即时可见]
export const WATCH_POLL_MS = 2_000
const PARSE_RETRY_MS = 150
const PARSE_RETRIES = 2

export class MatrixManager {
  readonly sessions = new Map<string, SessionInfo>()
  private readonly opts: Required<Pick<MatrixManagerOptions, "watchEnabled" | "debounceMs" | "pollMs">> & MatrixManagerOptions
  private readonly shellsByModel = new Map<ModelKey, ShellDefinition[]>()
  private readonly defByName = new Map<string, ShellDefinition>()
  private current_: ActivationState
  private lastActiveKeys = new Set<string>()
  private watchers: FSWatcher[] = []
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private lastMtimes: [number, number] = [0, 0]
  private stopped = false
  private pendingSource: RecomputeSource = "startup"
  // [2026-09-02]-[config 源净零反馈节流：favorites 增删复原/仅 recent 变更时 mtime 变化会触发重算，
  // 但激活集无变化＝完全静默，用户以为监听失效；10s 节流防连续开关刷屏]
  private lastConfigNoopNoticeMs = 0

  constructor(options: MatrixManagerOptions) {
    this.opts = { watchEnabled: true, debounceMs: WATCH_DEBOUNCE_MS, pollMs: WATCH_POLL_MS, ...options }
    for (const d of this.opts.superset) {
      const mk = `${d.provider}/${d.modelId}` as ModelKey
      const list = this.shellsByModel.get(mk) ?? []
      list.push(d)
      this.shellsByModel.set(mk, list)
      this.defByName.set(d.name, d)
    }
    this.current_ = computeActivation({
      generation: 0, mode: this.opts.mode, configStatus: "empty",
      configured: [], sessionModels: [],
      shellsByModel: this.shellsByModel, knownProviders: this.opts.knownProviders,
    })
  }

  /** session.created 预注册：事件先于首轮 chat.params/transform，保证 transform 首轮即可按 agent 名分类 */
  noteSessionCreated(sessionID: string | undefined, agent: string | undefined): boolean {
    if (this.stopped || !sessionID || !agent) return false
    if (this.sessions.has(sessionID)) return false
    this.sessions.set(sessionID, { agent, modelKey: null, isShell: this.opts.injectedNames.has(agent), updatedAt: Date.now() })
    return true
  }

  /** chat.params 分类（agent 名唯一真源）：注入壳名集合→isShell；title/compaction/summary→忽略；
   *  其余（含用户自定义 subagent）→按主会话注册。返回是否影响激活矩阵 */
  noteChatParams(sessionID: string | undefined, agent: string | undefined, modelKey: ModelKey | null): boolean {
    if (this.stopped || !sessionID || !agent) return false
    if (INTERNAL_AGENTS.has(agent)) return false
    const isShell = this.opts.injectedNames.has(agent)
    const prev = this.sessions.get(sessionID)
    this.sessions.set(sessionID, { agent, modelKey, isShell, updatedAt: Date.now() })
    // 壳会话不进激活矩阵；只有非壳会话模型变化才需重算
    return !isShell && modelKey !== null && (prev?.modelKey ?? null) !== modelKey
  }

  /** session.deleted：删除会话注册表项。返回是否有非壳模型被移除（需重算） */
  noteSessionDeleted(sessionID: string): boolean {
    const prev = this.sessions.get(sessionID)
    this.sessions.delete(sessionID)
    return Boolean(prev && !prev.isShell && prev.modelKey)
  }

  /** 非壳会话模型并集（即时快照） */
  sessionModelKeys(): ModelKey[] {
    const out = new Set<string>()
    for (const s of this.sessions.values()) {
      if (!s.isShell && s.modelKey) out.add(s.modelKey)
    }
    return sortUnique([...out] as ModelKey[])
  }

  isShellSession(sessionID: string): boolean {
    return this.sessions.get(sessionID)?.isShell ?? false
  }

  /** transform 阶段系统注入跳过判定：壳会话 ∪ 内部代理（title/compaction/summary）——
   *  按预注册/注册表中的 agent 名分类，首轮（session.created 预注册）即生效 */
  skipSystemInjection(sessionID: string): boolean {
    const s = this.sessions.get(sessionID)
    return Boolean(s && (s.isShell || INTERNAL_AGENTS.has(s.agent)))
  }

  snapshot(): ActivationState {
    return this.current_
  }

  /** 当前激活组合 matrixKey 集（-ro 别名与 rw 共享 key，天然去重） */
  activeMatrixKeys(): string[] {
    const out = new Set<string>()
    for (const name of this.current_.activeShells) {
      const d = this.defByName.get(name)
      if (d) out.add(d.matrixKey)
    }
    return [...out].sort()
  }

  /** 同步重算：读配置面→并集→落盘；状态等价短路（不 bump generation/不清缓存）
   *  [2026-08-29]-[修复复审P1-写入竞态：本方法全同步（读-算-写无 await）→进程内天然原子；
   *  model-matrix.json 读改写同步完成（进程内原子）；探针异步写经 withPathLock 串行＋完成时代数校验丢弃，
   *  二者交错由代数校验兜底；跨进程靠唯一 tmp+rename 不损坏文件]-
   *  [2026-08-29]-[触发源透传：watch/轮询=config、chat.params/session.deleted=session、直调=startup；
   *  供 onRecompute 按源决定探针范围（config→全量激活组合，其余→仅新增）] */
  recompute(configured?: { configStatus: ActivationState["configStatus"]; models: ModelKey[] }, source: RecomputeSource = "startup"): ActivationState {
    const read = configured ?? readConfigured(this.opts.stateRoot, this.opts.mode)
    const next = computeActivation({
      generation: this.current_.generation + 1,
      mode: this.opts.mode,
      configStatus: read.configStatus,
      configured: read.models,
      sessionModels: this.sessionModelKeys(),
      shellsByModel: this.shellsByModel,
      knownProviders: this.opts.knownProviders,
    })
    if (sameActivation(this.current_, next)) {
      // [2026-09-02]-[配置面净零变更反馈：mtime 变了但 favorites/可见集内容与激活集无变化时，
      // 此前无 gen bump/无通知/无侧栏重写＝用户视角的"没反应"；config 源时给一条节流状态日志，
      // 任何收藏区操作都有可感知回执；session/startup 源属内部调度保持静默]
      if (source === "config" && Date.now() - this.lastConfigNoopNoticeMs > 10_000) {
        this.lastConfigNoopNoticeMs = Date.now()
        appendStatusLog(`favorites/可见集已扫描：激活集无变化（gen=${this.current_.generation}，未重算未重探）`)
      }
      return this.current_
    }
    if (next.invalidConfigured.length > 0) {
      // [2026-09-01]-[加固：favorites/可见集里存在 provider 已知但 modelId 查无壳的脏数据（如手滑收藏
      // "provider/not-a-model"），此前静默丢弃无处诊断；sameActivation 已短路去重，此处只在真变化时记一次，不刷屏]
      appendStatusLog(`可见集/收藏含无效模型（provider 已知但无此 modelId，未生成壳）：${next.invalidConfigured.join("、")}`)
    }
    const prevKeys = new Set(this.lastActiveKeys)
    const activeKeys = new Set(this.activeMatrixKeysOf(next))
    const newTargets = [...activeKeys].filter((k) => !prevKeys.has(k)).sort()
    this.lastActiveKeys = new Set([...prevKeys, ...activeKeys])
    this.current_ = next
    try {
      writeJsonAtomic(paths().activeMatrix, { ...next, updated_at: nowIso() })
      // model-matrix.json 增 active_keys/target_generation（同步读改写保探针字段；探针完成后按代数校验丢弃）
      const m = readJson<Record<string, unknown>>(paths().matrix)
      writeJsonAtomic(paths().matrix, { ...(m ?? {}), active_keys: [...activeKeys], target_generation: next.generation })
    } catch (exc) {
      appendStatusLog(`激活矩阵落盘 fail-open: ${exc}`)
    }
    try {
      this.opts.onRecompute?.(next, newTargets, source)
    } catch (exc) {
      appendStatusLog(`激活矩阵回调 fail-open: ${exc}`)
    }
    return next
  }

  private activeMatrixKeysOf(state: ActivationState): string[] {
    const out = new Set<string>()
    for (const name of state.activeShells) {
      const d = this.defByName.get(name)
      if (d) out.add(d.matrixKey)
    }
    return [...out]
  }

  /** 异步重算（watch/轮询/会话触发）：unreadable 带短重试（原子 rename 竞态兜底） */
  async recomputeWithRetry(): Promise<ActivationState> {
    let read = this.readConfiguredSafe()
    for (let i = 0; i < PARSE_RETRIES && read.configStatus === "unreadable"; i++) {
      await new Promise((r) => setTimeout(r, PARSE_RETRY_MS))
      read = this.readConfiguredSafe()
    }
    return this.recompute(read, this.pendingSource)
  }

  private readConfiguredSafe(): { configStatus: ActivationState["configStatus"]; models: ModelKey[] } {
    try {
      return readConfigured(this.opts.stateRoot, this.opts.mode)
    } catch (exc) {
      appendStatusLog(`配置面读取 fail-open（视为 empty）: ${exc}`)
      return { configStatus: "empty", models: [] }
    }
  }

  private targetFiles(): [string, string] {
    // [2026-08-29]-[修复复审P1-双根路径：global.dat 在 stateRoot 父目录（userData），model.json 在 stateRoot]
    return [desktopDatPath(this.opts.stateRoot), tuiModelPath(this.opts.stateRoot)]
  }

  /** 启动 watch（两目录级，缺失目录静默跳过）＋mtime 轮询兜底 */
  start(): void {
    if (this.stopped || !this.opts.watchEnabled) return
    // [2026-08-29]-[修复复审P1-双根路径：拆分 watch stateRoot 父目录（global.dat）与 stateRoot（model.json）]
    const dirs = watchDirs(this.opts.stateRoot)
    for (const dir of dirs) {
      try {
        const w = watch(dir, { recursive: false }, (_event, filename) => {
          if (!filename) return this.scheduleRecompute()
          if (WATCH_FILENAMES.has(String(filename))) this.scheduleRecompute()
        })
        // [2026-09-02]-[运行异常落日志：此前纯静默吞掉，宿主内 fs.watch 不投递时无从诊断]-[可观测性]
        w.on("error", (exc) => appendStatusLog(`fs.watch(${dir}) 异常，mtime 轮询兜底: ${exc}`))
        this.watchers.push(w)
      } catch (exc) {
        // 目录缺失（另一端形态天然无此文件）→静默跳过轮询兜底；目录存在却启动失败（如 fd 耗尽）→落日志
        try {
          if (statSync(dir).isDirectory()) appendStatusLog(`fs.watch(${dir}) 启动失败，mtime 轮询兜底: ${exc}`)
        } catch { /* 目录缺失：预期内静默 */ }
      }
    }
    this.refreshMtimes()
    this.pollTimer = setInterval(() => {
      try {
        const [a, b] = this.targetFiles()
        const now: [number, number] = [fileMtimeOf(a), fileMtimeOf(b)]
        if (now[0] !== this.lastMtimes[0] || now[1] !== this.lastMtimes[1]) {
          this.lastMtimes = now
          this.scheduleRecompute()
        }
      } catch { /* fail-open */ }
    }, this.opts.pollMs)
    unref(this.pollTimer)
  }

  private refreshMtimes(): void {
    const [a, b] = this.targetFiles()
    this.lastMtimes = [fileMtimeOf(a), fileMtimeOf(b)]
  }

  /** [2026-08-29]-[触发源参数：watch/轮询默认 config（可见集开关/favorites 增删→全量重探）；
   *  会话源由 chat.params/session.deleted 显式传 session（只探新增）] */
  scheduleRecompute(delay?: number, source: RecomputeSource = "config"): void {
    if (this.stopped) return
    this.pendingSource = source
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      this.recomputeWithRetry().catch((exc) => appendStatusLog(`重算 fail-open: ${exc}`))
      this.refreshMtimes()
    }, delay ?? this.opts.debounceMs)
    unref(this.debounceTimer)
  }

  stop(): void {
    this.stopped = true
    for (const w of this.watchers) {
      try {
        w.close()
      } catch { /* fail-open */ }
    }
    this.watchers = []
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.debounceTimer = null
    this.pollTimer = null
  }
}

function fileMtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

function unref(t: unknown): void {
  if (t && typeof t === "object" && "unref" in (t as any)) (t as any).unref()
}
