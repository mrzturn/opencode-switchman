// [2026-09-06]-[tmux pane mirroring: dispatched subagent sessions become live `opencode attach` panes stacked in
//  a right-hand column of the home tmux window. Layout: main pane left (100-rightPct), subagent column right,
//  up to maxPanes visible (default 3, evenly stacked); extra dispatches wait in a FIFO queue and take over the
//  first freed pane; each completion shrinks the column back (3→2 even halves → 1 full → 0 = main pane alone).
//  The window is only ever split at the HOME PANE (never the whole window), so user sidebars and the status line
//  stay untouched. Everything is fail-open: any tmux/IO error only logs and never blocks dispatch.]
import { execFile } from "node:child_process"
import type { TmuxOptions } from "./types"

export interface TmuxResolvedOptions {
  enabled: boolean
  rightPct: number
  maxPanes: number
  mini: boolean
}

/** Pane title marker prefix + start-command sniff used to find our leftovers (restart sweep) */
export const TMUX_PANE_MARKER = "swm:"

function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

/** Resolve the attach origin from the plugin serverUrl, falling back to the OPENCODE_PORT env; null = not a local http server */
export function serverOriginOf(serverUrl: unknown, envPort?: string): string | null {
  try {
    const raw = typeof serverUrl === "string" ? serverUrl : serverUrl instanceof URL ? serverUrl.toString() : ""
    if (raw.startsWith("http://127.0.0.1") || raw.startsWith("http://localhost")) {
      const u = new URL(raw)
      return u.origin
    }
  } catch { /* fall through */ }
  const port = typeof envPort === "string" && /^\d+$/.test(envPort) ? envPort : ""
  return port ? `http://127.0.0.1:${port}` : null
}

/** Pure argv builders (unit-tested without tmux; executed via execFile, no shell on our side) */
export function splitPaneArgs(o: { target: string; dir: string; axis: "h" | "v"; size: string; before?: boolean }): string[] {
  return ["split-window", "-d", "-P", "-F", "#{pane_id}", ...(o.before ? ["-b"] : []), ...(o.axis === "h" ? ["-h"] : ["-v"]), "-l", o.size, "-c", o.dir, "-t", o.target]
}

export function respawnPaneArgs(o: { target: string; dir: string; command: string }): string[] {
  return ["respawn-pane", "-k", "-c", o.dir, "-t", o.target, o.command]
}

export function killPaneArgs(target: string): string[] {
  return ["kill-pane", "-t", target]
}

export function resizePaneArgs(o: { target: string; height: number }): string[] {
  return ["resize-pane", "-t", o.target, "-y", String(Math.max(1, Math.floor(o.height)))]
}

export function selectPaneArgs(target: string): string[] {
  return ["select-pane", "-t", target]
}

export function setPaneTitleArgs(o: { target: string; title: string }): string[] {
  return ["select-pane", "-T", o.title, "-t", o.target]
}

export function displayFormatArgs(o: { target: string; format: string }): string[] {
  return ["display-message", "-p", "-t", o.target, o.format]
}

export function listPanesArgs(target: string): string[] {
  return ["list-panes", "-t", target, "-F", "#{pane_id}\t#{pane_title}\t#{pane_start_command}"]
}

/** The command each subagent pane runs: a live TUI attached to the running server, opened on the child session */
export function viewerCommand(o: { origin: string; sessionId: string; dir: string; mini: boolean; bin?: string }): string {
  const bin = o.bin && o.bin.trim() ? o.bin.trim() : "opencode"
  return `${bin} attach ${o.origin} -s ${o.sessionId}${o.mini ? " --mini" : ""} --dir ${shq(o.dir)}`
}

export function defaultsOf(o: TmuxOptions | undefined): TmuxResolvedOptions {
  return {
    enabled: o?.enabled !== false,
    rightPct: typeof o?.rightPct === "number" && Number.isInteger(o.rightPct) && o.rightPct >= 10 && o.rightPct <= 90 ? o.rightPct : 60,
    maxPanes: typeof o?.maxPanes === "number" && Number.isInteger(o.maxPanes) && o.maxPanes >= 1 && o.maxPanes <= 4 ? o.maxPanes : 3,
    mini: o?.mini === true,
  }
}

export interface TmuxPaneManagerDeps {
  env?: Record<string, string | undefined>
  options: () => TmuxOptions | undefined
  serverOrigin: string
  dir: string
  bin?: string
  exec?: (args: string[]) => Promise<string>
  log?: (message: string) => void
}

interface Child { id: string; agent: string; main: string }
interface Slot { pane: string; child: Child }

/**
 * Serialized (promise-chained) tmux pane manager. One instance per plugin process; all mutators enqueue jobs so
 * concurrent session events never interleave tmux operations. Inert until init() proves the home pane exists.
 */
export class TmuxPaneManager {
  private env: Record<string, string | undefined>
  private optionsOf: () => TmuxResolvedOptions
  private origin: string
  private dir: string
  private bin?: string
  private exec: (args: string[]) => Promise<string>
  private log: (message: string) => void

  private home = ""
  private win = ""
  private ready = false
  private slots: Slot[] = []
  private queue: Child[] = []
  private children = new Map<string, Child>()
  private chain: Promise<unknown> = Promise.resolve()
  private pollTimer: ReturnType<typeof setInterval> | null = null

  constructor(deps: TmuxPaneManagerDeps) {
    this.env = deps.env ?? process.env
    this.optionsOf = () => defaultsOf(deps.options())
    this.origin = deps.serverOrigin
    this.dir = deps.dir
    this.bin = deps.bin
    this.exec =
      deps.exec ??
      ((args) =>
        new Promise<string>((resolve, reject) => {
          execFile("tmux", args, { timeout: 5_000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))))
        }))
    this.log = deps.log ?? (() => {})
  }

  /** Probe the home pane + window, sweep leftovers from a previous run; never throws */
  async init(): Promise<void> {
    try {
      const opts = this.optionsOf()
      if (!opts.enabled) return
      if (!this.origin) return
      if (!this.env.TMUX || !this.env.TMUX_PANE) return
      this.home = this.env.TMUX_PANE
      this.win = (await this.exec(displayFormatArgs({ target: this.home, format: "#{window_id}" }))).trim()
      if (!this.win.startsWith("@")) return
      await this.sweepLeftovers()
      this.ready = true
    } catch (exc) {
      this.ready = false
      this.log(`tmux pane mirroring disabled (init failed): ${exc instanceof Error ? exc.message : exc}`)
    }
  }

  /** Kill panes this plugin left behind before a restart (title marker or attach start-command in the home window) */
  private async sweepLeftovers(): Promise<void> {
    try {
      const out = await this.exec(listPanesArgs(this.home))
      for (const line of out.split("\n")) {
        const [pane, title, startCommand] = line.split("\t")
        if (!pane || pane === this.home) continue
        const ours = (title ?? "").startsWith(TMUX_PANE_MARKER) || /opencode attach -s ses_/.test(startCommand ?? "")
        if (ours) await this.exec(killPaneArgs(pane)).catch(() => {})
      }
    } catch { /* best effort */ }
  }

  tracking(childSessionId: string): boolean {
    return this.children.has(childSessionId)
  }

  /** A subagent session started (event-driven; job chained so ordering is deterministic) */
  noteChild(mainSessionId: string, childSessionId: string, agent: string): void {
    this.children.set(childSessionId, { id: childSessionId, agent, main: mainSessionId })
    this.enqueue(async () => {
      if (!this.ready || !this.optionsOf().enabled) return
      // [2026-09-06 fix]-[resume re-display: sweep dead panes BEFORE the duplicate check — a user-closed viewer of
      //  this same child lingers in slots up to one poll period (4s) and would otherwise swallow the re-display]
      await this.dropDeadSlots()
      if (this.queue.some((c) => c.id === childSessionId) || this.slots.some((s) => s.child.id === childSessionId)) return
      await this.displayChild({ id: childSessionId, agent, main: mainSessionId })
    })
  }

  /** A subagent session finished its loop (or was deleted): promote a queued child or shrink the column */
  noteChildEnd(childSessionId: string): void {
    this.children.delete(childSessionId)
    this.enqueue(async () => {
      if (!this.ready) return
      const qi = this.queue.findIndex((c) => c.id === childSessionId)
      if (qi >= 0) {
        this.queue.splice(qi, 1)
        return
      }
      const si = this.slots.findIndex((s) => s.child.id === childSessionId)
      if (si < 0) return
      const slot = this.slots[si]
      const next = this.queue.shift()
      if (next) {
        // pane count stays at max: the freed pane is respawned with the next queued child
        await this.spawnViewer(slot.pane, next)
        slot.child = next
      } else {
        // the ended child's own pane leaves the layout (never kill a pane showing a still-running child)
        await this.withFocus(() => this.removeSlot(si))
      }
    })
  }

  /** Test/diagnostic snapshot */
  stats(): { ready: boolean; panes: number; queued: number; tracked: number } {
    return { ready: this.ready, panes: this.slots.length, queued: this.queue.length, tracked: this.children.size }
  }

  /** Awaitable for tests: resolves after every enqueued job so far has settled */
  flush(): Promise<unknown> {
    return this.chain
  }

  private enqueue(job: () => Promise<void>): void {
    this.chain = this.chain
      .then(job)
      .catch((exc) => this.log(`tmux pane mirroring op failed (continuing): ${exc instanceof Error ? exc.message : exc}`))
  }

  /** Show a child in a new right-column pane (grow by one) or queue it when the column is full */
  private async displayChild(child: Child): Promise<void> {
    await this.dropDeadSlots()
    const max = this.optionsOf().maxPanes
    if (this.slots.length >= max) {
      this.queue.push(child)
      this.log(`tmux pane mirroring: column full (${this.slots.length} panes), queued ses_${child.id.slice(-6)} (${child.agent})`)
      return
    }
    await this.withFocus(async () => {
      const pane = await this.growByOne()
      if (!pane) return
      this.slots.push({ pane, child })
      await this.spawnViewer(pane, child)
    })
    this.syncPoll()
  }

  private async growByOne(): Promise<string> {
    const opts = this.optionsOf()
    if (this.slots.length === 0) {
      const out = await this.exec(splitPaneArgs({ target: this.home, dir: this.dir, axis: "h", size: `${opts.rightPct}%` }))
      return out.trim()
    }
    const last = this.slots[this.slots.length - 1].pane
    const out = await this.exec(splitPaneArgs({ target: last, dir: this.dir, axis: "v", size: "50%" }))
    const pane = out.trim()
    // keep the column visually even: after the split, pull the top pane down to 1/N of the column height
    const n = this.slots.length + 1
    if (n >= 3) {
      // [2026-09-06]-[live-test fix: the new pane is not in this.slots yet (pushed by the caller after this returns),
      //  so measure it explicitly — without it total under-counts and the top pane resize lands on a wrong height]
      const heights = await this.measureAll()
      const newH = Number((await this.exec(displayFormatArgs({ target: pane, format: "#{pane_height}" }))).trim())
      const total = heights.reduce((a, b) => a + b, 0) + (Number.isFinite(newH) && newH > 0 ? newH : 0)
      if (total > 0 && this.slots.length > 0) {
        await this.exec(resizePaneArgs({ target: this.slots[0].pane, height: Math.floor(total / n) })).catch(() => {})
      }
    }
    return pane
  }

  /**
   * Remove one slot from the layout: kill its pane (space merges into the sibling), then re-even the survivors
   * (3→2 halves, 4→3 thirds, ...). 1 or 0 remaining panes need no geometry. Called inside withFocus.
   */
  private async removeSlot(si: number): Promise<void> {
    const slot = this.slots[si]
    this.slots.splice(si, 1)
    if (await this.paneExists(slot.pane)) await this.exec(killPaneArgs(slot.pane)).catch(() => {})
    if (this.slots.length >= 2) {
      const total = (await this.measureAll()).reduce((a, b) => a + b, 0)
      if (total > 0) {
        await this.exec(resizePaneArgs({ target: this.slots[0].pane, height: Math.floor(total / this.slots.length) })).catch(() => {})
      }
    }
    if (this.slots.length === 0) this.log("tmux pane mirroring: all subagent panes closed, main pane restored")
    this.syncPoll()
  }

  /** Spawn the attach viewer into a pane and label it */
  private async spawnViewer(pane: string, child: Child): Promise<void> {
    const opts = this.optionsOf()
    const cmd = viewerCommand({ origin: this.origin, sessionId: child.id, dir: this.dir, mini: opts.mini, bin: this.bin })
    await this.exec(respawnPaneArgs({ target: pane, dir: this.dir, command: cmd }))
    await this.exec(setPaneTitleArgs({ target: pane, title: `${TMUX_PANE_MARKER}${child.agent}` })).catch(() => {})
    this.log(`tmux pane mirroring: ses_${child.id.slice(-6)} (${child.agent}) displayed in pane ${pane}`)
  }

  /** Drop slots whose pane vanished (viewer exited / user killed the pane); queued children then backfill */
  private async dropDeadSlots(): Promise<void> {
    let dropped = false
    for (const slot of [...this.slots]) {
      if (!(await this.paneExists(slot.pane))) {
        this.slots = this.slots.filter((s) => s !== slot)
        dropped = true
      }
    }
    if (dropped) {
      this.log("tmux pane mirroring: detected closed pane(s), reconciling layout")
      while (this.slots.length < this.optionsOf().maxPanes && this.queue.length > 0) {
        const next = this.queue.shift()
        if (next) await this.displayChild(next)
      }
      if (this.slots.length === 0) this.log("tmux pane mirroring: all subagent panes closed, main pane restored")
    }
  }

  private async paneExists(pane: string): Promise<boolean> {
    try {
      const out = await this.exec(displayFormatArgs({ target: pane, format: "#{pane_id}" }))
      return out.trim() === pane
    } catch {
      return false
    }
  }

  private async measureAll(): Promise<number[]> {
    const heights: number[] = []
    for (const slot of this.slots) {
      try {
        const h = Number((await this.exec(displayFormatArgs({ target: slot.pane, format: "#{pane_height}" }))).trim())
        heights.push(Number.isFinite(h) && h > 0 ? h : 0)
      } catch {
        heights.push(0)
      }
    }
    return heights
  }

  /** Preserve the window's active pane across structural ops (splits/kills move focus) */
  private async withFocus(job: () => Promise<void>): Promise<void> {
    if (!this.win) return job()
    const saved = await this.exec(displayFormatArgs({ target: this.win, format: "#{pane_id}" })).catch(() => "")
    await job()
    const now = await this.exec(displayFormatArgs({ target: this.win, format: "#{pane_id}" })).catch(() => "")
    if (saved && now && saved !== now) await this.exec(selectPaneArgs(saved)).catch(() => {})
  }

  /** Poll while panes are open: a viewer can exit on its own (user quit / server switch) — self-heal the layout */
  private syncPoll(): void {
    const need = this.slots.length > 0 || this.queue.length > 0
    if (need && !this.pollTimer) {
      this.pollTimer = setInterval(() => {
        this.enqueue(async () => {
          if (!this.ready) return
          await this.dropDeadSlots()
          if (this.slots.length === 0 && this.queue.length === 0) this.syncPoll()
        })
      }, 4_000)
      // never hold the process open just for polling
      const t = this.pollTimer as unknown as { unref?: () => void }
      t.unref?.()
    } else if (!need && this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }
}
