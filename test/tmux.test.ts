// [2026-09-06]-[tmux pane mirroring behavioral contract: argv builders + TmuxPaneManager layout state machine
//  (grow 1→2→3, FIFO queue beyond max, slot refill on completion, shrink 3→2→1→0, focus preservation, inert
//  outside tmux, dead-pane self-heal). All tmux IO faked; no real tmux needed]
import { describe, expect, test } from "bun:test"
import {
  TmuxPaneManager,
  TMUX_PANE_MARKER,
  defaultsOf,
  killPaneArgs,
  listPanesArgs,
  resizePaneArgs,
  respawnPaneArgs,
  serverOriginOf,
  setPaneTitleArgs,
  splitPaneArgs,
  viewerCommand,
} from "../src/tmux"
import type { TmuxOptions } from "../src/types"

describe("tmux argv builders", () => {
  test("splitPaneArgs: horizontal first split takes rightPct, keeps focus, prints pane id", () => {
    expect(splitPaneArgs({ target: "%0", dir: "/p", axis: "h", size: "60%" })).toEqual([
      "split-window", "-d", "-P", "-F", "#{pane_id}", "-h", "-l", "60%", "-c", "/p", "-t", "%0",
    ])
  })
  test("splitPaneArgs: vertical stack split + optional -b", () => {
    expect(splitPaneArgs({ target: "%2", dir: "/p", axis: "v", size: "50%" })).toEqual([
      "split-window", "-d", "-P", "-F", "#{pane_id}", "-v", "-l", "50%", "-c", "/p", "-t", "%2",
    ])
    expect(splitPaneArgs({ target: "%2", dir: "/p", axis: "v", size: "50%", before: true }).includes("-b")).toBe(true)
  })
  test("viewerCommand: attach + session + quoted dir; mini flag", () => {
    expect(viewerCommand({ origin: "http://127.0.0.1:50307", sessionId: "ses_a", dir: "/my proj", mini: false, bin: "opencode" }))
      .toBe("opencode attach http://127.0.0.1:50307 -s ses_a --dir '/my proj'")
    expect(viewerCommand({ origin: "http://127.0.0.1:1", sessionId: "ses_a", dir: "/p", mini: true }).includes(" --mini")).toBe(true)
  })
  test("misc argv builders", () => {
    expect(killPaneArgs("%3")).toEqual(["kill-pane", "-t", "%3"])
    expect(respawnPaneArgs({ target: "%3", dir: "/p", command: "opencode attach http://x -s ses_a" })).toEqual([
      "respawn-pane", "-k", "-c", "/p", "-t", "%3", "opencode attach http://x -s ses_a",
    ])
    expect(resizePaneArgs({ target: "%3", height: 12.7 })).toEqual(["resize-pane", "-t", "%3", "-y", "12"])
    expect(setPaneTitleArgs({ target: "%3", title: "swm:tester" })).toEqual(["select-pane", "-T", "swm:tester", "-t", "%3"])
    expect(listPanesArgs("%0")).toEqual(["list-panes", "-t", "%0", "-F", "#{pane_id}\t#{pane_title}\t#{pane_start_command}"])
  })
  test("serverOriginOf: local http origins pass, OPENCODE_PORT fallback, remote/missing rejected", () => {
    expect(serverOriginOf("http://127.0.0.1:50307/foo")).toBe("http://127.0.0.1:50307")
    expect(serverOriginOf(new URL("http://localhost:4096"))).toBe("http://localhost:4096")
    expect(serverOriginOf("https://remote.example.com", "50307")).toBe("http://127.0.0.1:50307")
    expect(serverOriginOf(undefined)).toBeNull()
    expect(serverOriginOf("https://remote.example.com")).toBeNull()
  })
  test("defaultsOf clamps bad values", () => {
    expect(defaultsOf(undefined)).toEqual({ enabled: true, rightPct: 60, maxPanes: 3, mini: false })
    expect(defaultsOf({ rightPct: 5, maxPanes: 99 } as TmuxOptions)).toEqual({ enabled: true, rightPct: 60, maxPanes: 3, mini: false })
    expect(defaultsOf({ rightPct: 70, maxPanes: 2, mini: true, enabled: false } as TmuxOptions)).toEqual({ enabled: false, rightPct: 70, maxPanes: 2, mini: true })
  })
})

type Deps = ConstructorParameters<typeof TmuxPaneManager>[0]

/** Fake tmux: records argv; split-window mints %N ids; display-message echoes the target (pane exists) */
function fakeExec(log: string[][], o: { heights?: number[]; deadPanes?: Set<string>; activeSeq?: string[] } = {}) {
  let next = 1
  let activeQuery = 0
  return async (args: string[]) => {
    log.push(args)
    const cmd = args[0]
    if (cmd === "display-message") {
      const fmt = args[args.length - 1]
      const target = args[args.indexOf("-t") + 1] ?? ""
      if (o.deadPanes?.has(target)) throw new Error(`can't find pane: ${target}`)
      if (fmt === "#{window_id}") return "@1"
      if (fmt === "#{pane_height}") return String(o.heights?.[0] ?? 30)
      if (fmt === "#{pane_id}" && target === "@1") return o.activeSeq ? o.activeSeq[Math.min(activeQuery++, o.activeSeq.length - 1)] : target
      return target
    }
    if (cmd === "list-panes") return "%0\tmain\t"
    if (cmd === "split-window") return `%${next++}`
    return ""
  }
}

function manager(log: string[][], opts: Partial<TmuxOptions> = {}, execOpts: Parameters<typeof fakeExec>[1] = {}): TmuxPaneManager {
  const full: TmuxOptions = { enabled: true, rightPct: 60, maxPanes: 3, mini: false, ...opts }
  return new TmuxPaneManager({
    env: { TMUX: "/tmp/sock,1,0", TMUX_PANE: "%0" },
    options: () => full,
    serverOrigin: "http://127.0.0.1:50307",
    dir: "/proj",
    exec: fakeExec(log, execOpts),
    log: () => {},
  })
}

const calls = (log: string[][], cmd: string) => log.filter((a) => a[0] === cmd)

async function inited(m: TmuxPaneManager, log: string[][]): Promise<TmuxPaneManager> {
  await m.init()
  log.length = 0
  return m
}

describe("TmuxPaneManager lifecycle", () => {
  test("inert outside tmux (no TMUX env): init not ready, dispatches are no-ops", async () => {
    const log: string[][] = []
    const m = new TmuxPaneManager({
      env: {},
      options: () => ({ enabled: true, rightPct: 60, maxPanes: 3, mini: false }),
      serverOrigin: "http://127.0.0.1:1",
      dir: "/p",
      exec: fakeExec(log),
      log: () => {},
    })
    await m.init()
    m.noteChild("main", "ses_a", "glm-mx-53f-low")
    await m.flush()
    expect(m.stats().ready).toBe(false)
    expect(log).toEqual([])
  })

  test("disabled via options: inert even inside tmux", async () => {
    const log: string[][] = []
    const m = await inited(manager(log, { enabled: false }), log)
    m.noteChild("main", "ses_a", "glm-mx-53f-low")
    await m.flush()
    expect(m.stats().panes).toBe(0)
    expect(log).toEqual([])
  })

  test("first dispatch: split home pane -h 60%, spawn attach viewer, label the pane", async () => {
    const log: string[][] = []
    const m = await inited(manager(log), log)
    m.noteChild("main", "ses_abc", "glm-mx-53f-low")
    await m.flush()
    expect(m.stats().panes).toBe(1)
    const splits = calls(log, "split-window")
    expect(splits.length).toBe(1)
    expect(splits[0]).toEqual(splitPaneArgs({ target: "%0", dir: "/proj", axis: "h", size: "60%" }))
    const resawns = calls(log, "respawn-pane")
    expect(resawns.length).toBe(1)
    expect(resawns[0][resawns[0].length - 1]).toContain("opencode attach http://127.0.0.1:50307 -s ses_abc")
    expect(calls(log, "select-pane").some((a) => a.includes(`${TMUX_PANE_MARKER}glm-mx-53f-low`))).toBe(true)
  })

  test("second dispatch: vertical 50% split of the first right pane, first pane not respawned", async () => {
    const log: string[][] = []
    const m = await inited(manager(log), log)
    m.noteChild("main", "ses_a", "agent-a")
    await m.flush()
    log.length = 0
    m.noteChild("main", "ses_b", "agent-b")
    await m.flush()
    expect(m.stats().panes).toBe(2)
    const splits = calls(log, "split-window")
    expect(splits.length).toBe(1)
    expect(splits[0]).toEqual(splitPaneArgs({ target: "%1", dir: "/proj", axis: "v", size: "50%" }))
    expect(calls(log, "respawn-pane").length).toBe(1)
    expect(calls(log, "kill-pane").length).toBe(0)
  })

  test("third dispatch: split + re-even resize of the top pane (thirds)", async () => {
    const log: string[][] = []
    const m = await inited(manager(log, {}, { heights: [40] }), log)
    m.noteChild("main", "ses_a", "agent-a")
    await m.flush()
    m.noteChild("main", "ses_b", "agent-b")
    await m.flush()
    log.length = 0
    m.noteChild("main", "ses_c", "agent-c")
    await m.flush()
    expect(m.stats().panes).toBe(3)
    // full column = 40+40+40=120 lines (the new pane is measured explicitly — live-test regression) → floor(120/3)=40
    const resizes = calls(log, "resize-pane")
    expect(resizes.length).toBe(1)
    expect(resizes[0]).toEqual(resizePaneArgs({ target: "%1", height: 40 }))
  })

  test("fourth dispatch beyond maxPanes: queued, no tmux ops; finishing a visible child swaps in the queued one on the freed pane", async () => {
    const log: string[][] = []
    const m = await inited(manager(log), log)
    for (const [id, agent] of [["ses_a", "a"], ["ses_b", "b"], ["ses_c", "c"], ["ses_d", "d"]] as const) m.noteChild("main", id, agent)
    await m.flush()
    expect(m.stats().panes).toBe(3)
    expect(m.stats().queued).toBe(1)
    expect(calls(log, "split-window").length).toBe(3)
    log.length = 0
    m.noteChildEnd("ses_a") // displayed → ses_d takes over the pane, column stays at 3
    await m.flush()
    expect(m.stats().panes).toBe(3)
    expect(m.stats().queued).toBe(0)
    expect(calls(log, "kill-pane").length).toBe(0)
    expect(calls(log, "respawn-pane").length).toBe(1)
    expect(calls(log, "respawn-pane")[0][calls(log, "respawn-pane")[0].length - 1]).toContain("-s ses_d")
  })

  test("completions shrink the column: 3→2 (kill + re-even), 2→1 (kill), 1→0 (last kill restores the main pane)", async () => {
    const log: string[][] = []
    const m = await inited(manager(log, {}, { heights: [30] }), log)
    for (const id of ["ses_a", "ses_b", "ses_c"]) m.noteChild("main", id, "agent")
    await m.flush()
    log.length = 0
    m.noteChildEnd("ses_a")
    await m.flush()
    expect(m.stats().panes).toBe(2)
    expect(calls(log, "kill-pane").length).toBe(1)
    // survivors (%2/%3) measured 30+30=60 lines → top pane pulled to 30 (even halves)
    expect(calls(log, "resize-pane")[0]).toEqual(resizePaneArgs({ target: "%2", height: 30 }))
    log.length = 0
    m.noteChildEnd("ses_b")
    await m.flush()
    expect(m.stats().panes).toBe(1)
    expect(calls(log, "kill-pane").length).toBe(1)
    expect(calls(log, "resize-pane").length).toBe(0)
    log.length = 0
    m.noteChildEnd("ses_c")
    await m.flush()
    expect(m.stats()).toMatchObject({ panes: 0, queued: 0, tracked: 0 })
    expect(calls(log, "kill-pane").length).toBe(1)
  })

  test("unknown/queued child end is a no-op on layout; duplicate noteChild is idempotent", async () => {
    const log: string[][] = []
    const m = await inited(manager(log), log)
    m.noteChild("main", "ses_a", "a")
    m.noteChild("main", "ses_a", "a") // duplicate
    await m.flush()
    expect(m.stats().panes).toBe(1)
    log.length = 0
    m.noteChildEnd("ses_unknown")
    await m.flush()
    expect(log).toEqual([])
  })

  test("focus preservation: if the window's active pane moved during ops, select-pane restores it", async () => {
    const log: string[][] = []
    // active-pane query sequence: %0 before ops, %1 after (split moved focus) → restore to %0
    const m = await inited(manager(log, {}, { activeSeq: ["%0", "%1"] }), log)
    m.noteChild("main", "ses_a", "a")
    await m.flush()
    const selects = calls(log, "select-pane").filter((a) => a[1] === "-t")
    expect(selects[selects.length - 1]).toEqual(["select-pane", "-t", "%0"])
  })

  test("dead pane self-heal: a vanished slot pane is dropped, layout reconciled, queued child promoted", async () => {
    const log: string[][] = []
    const dead = new Set<string>()
    const m = await inited(manager(log, {}, { deadPanes: dead }), log)
    m.noteChild("main", "ses_a", "a")
    await m.flush()
    m.noteChild("main", "ses_b", "b")
    await m.flush()
    expect(m.stats().panes).toBe(2)
    dead.add("%1") // user closed the first subagent pane
    m.noteChild("main", "ses_c", "c") // any new event triggers reconcile
    await m.flush()
    expect(m.stats().panes).toBe(2)
    // ses_a's pane gone → dropped; ses_c fills the freed slot; ses_b keeps its pane
    const resawns = calls(log, "respawn-pane")
    expect(resawns.some((a) => String(a[a.length - 1]).includes("-s ses_c"))).toBe(true)
    expect(m.tracking("ses_a")).toBe(true) // still running server-side, just not displayed
    m.noteChildEnd("ses_a")
    await m.flush()
    expect(m.tracking("ses_a")).toBe(false)
  })

  test("init sweeps leftover panes from a previous run (title marker or attach start command)", async () => {
    const log: string[][] = []
    const exec = async (args: string[]) => {
      log.push(args)
      if (args[0] === "display-message") return args[args.length - 1] === "#{window_id}" ? "@1" : args[args.indexOf("-t") + 1] ?? ""
      if (args[0] === "list-panes") {
        return ["%0\tmain\t", "%2\tswm:old-agent\topencode attach http://x -s ses_old", "%3\tuser-pane\t"].join("\n")
      }
      return ""
    }
    const m = new TmuxPaneManager({
      env: { TMUX: "s", TMUX_PANE: "%0" },
      options: () => ({ enabled: true, rightPct: 60, maxPanes: 3, mini: false }),
      serverOrigin: "http://127.0.0.1:1",
      dir: "/p",
      exec,
      log: () => {},
    })
    await m.init()
    const kills = calls(log, "kill-pane")
    expect(kills).toEqual([killPaneArgs("%2")])
    expect(m.stats().ready).toBe(true)
  })
})
