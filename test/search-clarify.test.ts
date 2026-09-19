// [2026-09-17]-[broad-search clarify behavioral contract: a main session's first whole-project search (glob '**'
// unscoped / pathless grep / recursive rg|grep -r|find|fd at the root) is denied with an ask-first marker question;
// the retry passes once the ask completed (marker question capture) or fail-opens after the 2nd deny (anti-deadlock);
// scoped searches, shell subagent sessions and search.clarify:false are exempt. Pure helpers matrix + hook wiring]
import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const configDir = mkdtempSync(join(tmpdir(), "switchman-srch-config-"))
const stateDir = mkdtempSync(join(tmpdir(), "switchman-srch-state-"))
const projectDir = mkdtempSync(join(tmpdir(), "switchman-srch-project-"))
process.env.OPENCODE_CONFIG_DIR = configDir
process.env.SWITCHMAN_STATE = stateDir
// project language preference pre-configured so the lang hard gate never masks the search gate in bash cases
mkdirSync(join(projectDir, ".switchman"), { recursive: true })
writeFileSync(join(projectDir, ".switchman", "settings.json"), JSON.stringify({ v: 1, lang: { conversation: "en", comments: "en", docs: "en" } }))

import { SwitchmanPlugin } from "../src/index"
import { SEARCH_ASK_MARKER, describeSearchCall, hasSearchMarkerQuestion, isBroadSearchCall, searchClarifyDenyMessage } from "../src/search-clarify"
import { renderNotice } from "../src/i18n"

function readStatusLog(): string {
  const p = join(stateDir, "status-log.json")
  if (!existsSync(p)) return ""
  // [2026-09-19]-[i18n cleanup: entries are structured {key, params} — render English for the prose assertions]
  try {
    const data = JSON.parse(readFileSync(p, "utf8"))
    if (Array.isArray(data)) return data.map((e: { key?: string; params?: Record<string, string | number>; text?: string }) => renderNotice(e, "en")).join("\n")
  } catch { /* fail-open: fall through to raw text */ }
  return readFileSync(p, "utf8")
}

const fakeClient = {
  provider: { list: async () => [] },
  session: {
    async fork(opts: any) { return { data: { id: `${opts?.path?.id}_fork`, title: "T (fork)" } } },
    async update() { return { data: {} } },
    async list() { return { data: [] } },
    async get(opts: any) { return { data: { id: opts?.path?.id, title: "T", directory: projectDir } } },
    async summarize() { return { data: true } },
  },
}

async function boot(rawOptions: any = {}) {
  const hooks = await SwitchmanPlugin({ client: fakeClient, directory: projectDir } as any, { matrix: { mode: "legacy" }, ...rawOptions } as any)
  const emit = (event: any) => hooks.event!({ event } as any)
  const call = (sid: string, tool: string, args: any) =>
    hooks["tool.execute.before"]!({ sessionID: sid, tool, callID: `call_${sid}_${Math.random()}` } as any, { args } as any)
  const questionDone = (sid: string) =>
    hooks["tool.execute.after"]!({ sessionID: sid, tool: "question", callID: `q_${sid}_${Math.random()}`, args: { questions: [{ question: `${SEARCH_ASK_MARKER}: I am about to run a whole-project search. Do you have more precise file/directory guidance?`, header: "Search scope", options: [{ label: "No — search the whole project" }, { label: "Yes — I will type paths" }] }] } } as any,
      { output: 'No — search the whole project' } as any)
  return { hooks, emit, call, questionDone }
}

test("isBroadSearchCall: glob — recursive wildcard without a path scope is broad; pattern- or path-scoped is not", () => {
  expect(isBroadSearchCall("glob", { pattern: "**/*.ts" })).toBe(true)
  expect(isBroadSearchCall("glob", { pattern: "**/*.ts", path: "." })).toBe(true)
  expect(isBroadSearchCall("glob", { pattern: "**/package.json" })).toBe(true)
  expect(isBroadSearchCall("glob", { pattern: "**/*.ts", path: "src" })).toBe(false)
  expect(isBroadSearchCall("glob", { pattern: "src/**/*.ts" })).toBe(false)
  expect(isBroadSearchCall("glob", { pattern: "*.ts" })).toBe(false)
  expect(isBroadSearchCall("glob", { pattern: "package.json" })).toBe(false)
})

test("isBroadSearchCall: grep — pathless (or root path) is broad; include filters do not scope location", () => {
  expect(isBroadSearchCall("grep", { pattern: "TODO" })).toBe(true)
  expect(isBroadSearchCall("grep", { pattern: "TODO", path: "." })).toBe(true)
  expect(isBroadSearchCall("grep", { pattern: "TODO", include: "*.ts" })).toBe(true)
  expect(isBroadSearchCall("grep", { pattern: "TODO", path: "src" })).toBe(false)
  expect(isBroadSearchCall("grep", { pattern: "TODO", path: "src/index.ts" })).toBe(false)
})

test("isBroadSearchCall: bash — recursive search commands rooted at the project are broad; scoped operands are not", () => {
  expect(isBroadSearchCall("bash", { command: "rg foo" })).toBe(true)
  expect(isBroadSearchCall("bash", { command: "rg -n --hidden foo" })).toBe(true)
  expect(isBroadSearchCall("bash", { command: "rg foo ." })).toBe(true)
  expect(isBroadSearchCall("bash", { command: "sudo rg foo" })).toBe(true)
  expect(isBroadSearchCall("bash", { command: "rg foo src" })).toBe(false)
  expect(isBroadSearchCall("bash", { command: "grep -rn foo ." })).toBe(true)
  expect(isBroadSearchCall("bash", { command: "grep --recursive foo" })).toBe(true)
  expect(isBroadSearchCall("bash", { command: "grep -rn foo src/" })).toBe(false)
  expect(isBroadSearchCall("bash", { command: "grep foo file.txt" })).toBe(false) // no recursion flag
  expect(isBroadSearchCall("bash", { command: "find . -name '*.ts'" })).toBe(true)
  expect(isBroadSearchCall("bash", { command: "find src -name x" })).toBe(false)
  expect(isBroadSearchCall("bash", { command: "fd pattern" })).toBe(true)
  expect(isBroadSearchCall("bash", { command: "fd pattern src" })).toBe(false)
  expect(isBroadSearchCall("bash", { command: "ls -la" })).toBe(false)
  expect(isBroadSearchCall("bash", { command: "cat package.json" })).toBe(false)
})

test("isBroadSearchCall: bash regression 2026-09-17 — exclusion globs are not path operands; pipes are cut at the first segment", () => {
  // the incident commands (whole-project Chinese-comment scan that must trigger the ask)
  expect(isBroadSearchCall("bash", { command: "rg -n '\\p{Han}' --glob '!node_modules' --glob '!dist' --glob '!*.zh.md' -g '!*.lock' | head -100" })).toBe(true)
  expect(isBroadSearchCall("bash", { command: "rg -c '\\p{Han}' --glob '!node_modules' --glob '!dist' --glob '!*.zh.md' -g '!*.lock' | sort -t: -k2 -rn" })).toBe(true)
  expect(isBroadSearchCall("bash", { command: "rg -e '\\p{Han}'" })).toBe(true) // -e pattern, no path → cwd
  expect(isBroadSearchCall("bash", { command: "find . -type f -name '*.ts' | xargs wc -l" })).toBe(true)
  expect(isBroadSearchCall("bash", { command: "grep -rn --include='*.ts' foo ." })).toBe(true)
  // explicit file/dir lists stay scoped
  expect(isBroadSearchCall("bash", { command: "rg -n '\\p{Han}' README.md docs/reference.md | head -40" })).toBe(false)
  expect(isBroadSearchCall("bash", { command: "rg -n foo skills/db-query/scripts/lib/mysql-readonly.js | rg '\\p{Han}' | head -5" })).toBe(false)
  expect(isBroadSearchCall("bash", { command: "cat x | rg foo" })).toBe(false) // search command not at the head
})

test("deny message carries the verbatim marker question and the retry contract; marker detection is exact", () => {
  const msg = searchClarifyDenyMessage(describeSearchCall("glob", { pattern: "**/*.ts" }))
  expect(msg).toContain(SEARCH_ASK_MARKER)
  expect(msg).toContain("whole-project search (glob: **/*.ts)")
  expect(msg).toContain("question tool")
  expect(msg).toContain("retry this exact call")
  expect(msg).toContain("Retrying the search without asking is a violation")
  expect(hasSearchMarkerQuestion({ questions: [{ question: `${SEARCH_ASK_MARKER}: broader guidance?` }] })).toBe(true)
  expect(hasSearchMarkerQuestion({ questions: [{ question: "unrelated" }] })).toBe(false)
  expect(hasSearchMarkerQuestion({})).toBe(false)
})

test("gate wiring: first broad call denied with the marker ask; retry without asking denied; third attempt fail-opens", async () => {
  const { call } = await boot()
  const sid = "ses_srch_main1"
  const broad = { pattern: "**/*.ts" }
  await expect(call(sid, "glob", broad)).rejects.toThrow(SEARCH_ASK_MARKER)
  await expect(call(sid, "glob", broad)).rejects.toThrow(SEARCH_ASK_MARKER)
  await expect(call(sid, "glob", broad)).resolves.toBeUndefined()
  expect(readStatusLog()).toContain("search clarify gate")
})

test("gate wiring: marker question completed → latch opens; a different session still gated", async () => {
  const { call, questionDone } = await boot()
  const sid = "ses_srch_main2"
  const other = "ses_srch_other2"
  await expect(call(sid, "glob", { pattern: "**/*.ts" })).rejects.toThrow(SEARCH_ASK_MARKER)
  await questionDone(sid)
  expect(readStatusLog()).toContain("scope ask completed")
  await expect(call(sid, "glob", { pattern: "**/*.ts" })).resolves.toBeUndefined()
  await expect(call(sid, "grep", { pattern: "TODO" })).resolves.toBeUndefined() // latch is per-session, all later broad searches pass
  await expect(call(other, "grep", { pattern: "TODO" })).rejects.toThrow(SEARCH_ASK_MARKER)
})

test("gate wiring: scoped searches pass immediately; shell subagent sessions are exempt", async () => {
  const { call, emit } = await boot()
  const sid = "ses_srch_main3"
  await expect(call(sid, "grep", { pattern: "TODO", path: "src" })).resolves.toBeUndefined()
  await expect(call(sid, "glob", { pattern: "src/**/*.ts" })).resolves.toBeUndefined()
  await expect(call(sid, "bash", { command: "rg foo src" })).resolves.toBeUndefined()
  const shellSid = "ses_srch_shell3"
  emit({ type: "session.created", properties: { info: { id: shellSid, agent: "glm-mx-53f-low", title: "T" } } })
  await expect(call(shellSid, "glob", { pattern: "**/*.ts" })).resolves.toBeUndefined()
  await expect(call(shellSid, "bash", { command: "rg foo" })).resolves.toBeUndefined()
})

test("gate wiring: search.clarify:false disables the gate entirely", async () => {
  const { call } = await boot({ search: { clarify: false } })
  await expect(call("ses_srch_off", "glob", { pattern: "**/*.ts" })).resolves.toBeUndefined()
  await expect(call("ses_srch_off", "grep", { pattern: "TODO" })).resolves.toBeUndefined()
})

test("gate wiring: non-question tool completions never open the latch", async () => {
  const { hooks, call } = await boot()
  const sid = "ses_srch_main4"
  await expect(call(sid, "glob", { pattern: "**/*.ts" })).rejects.toThrow(SEARCH_ASK_MARKER)
  await hooks["tool.execute.after"]!({ sessionID: sid, tool: "question", callID: "q_unrelated", args: { questions: [{ question: "unrelated question" }] } } as any,
    { output: "x" } as any)
  await expect(call(sid, "glob", { pattern: "**/*.ts" })).rejects.toThrow(SEARCH_ASK_MARKER)
})
