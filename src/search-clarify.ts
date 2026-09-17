// [2026-09-17]-[broad-search clarify gate: a whole-project search (glob '**' without a path scope / grep without path /
//  recursive rg|grep -r|find|fd from the project root) is denied ONCE per main session with an ask-first error — the
//  model must relay a marker question to the user ("more precise file/directory guidance?"); narrower guidance re-scopes
//  the search, no guidance re-runs it (the call passes after the ask). Latch = marker question completion (captured in
//  tool.execute.after) or the 2nd deny (anti-deadlock fail-open, a broken/unavailable question tool must never wedge a
//  session). Pure helpers + constants only; wiring in src/index.ts; protocol clause in src/assets/agents-md.ts §5]
//
// Detection is deliberately conservative (fail-open): quoted multi-token patterns and unexpected shapes classify as
// scoped — a missed broad search costs some tokens, a false deny wedges the task. Shell/internal sessions are exempt
// at the wiring layer (delegated scouter shells ARE the delegated broad-search path).

/** Marker embedded in the ask's question text and matched in tool.execute.after capture */
export const SEARCH_ASK_MARKER = "switchman-search-scope"

/** Tools whose calls can constitute a broad search (task/read/edit can never be one) */
export const SEARCH_CLARIFY_TOOLS: ReadonlySet<string> = new Set(["glob", "grep", "bash"])

/** Anti-deadlock: after this many denies without an ask the gate opens permanently for the session */
export const SEARCH_CLARIFY_MAX_DENIES = 2

/** path value that leaves the search anchored at the project root (absent / empty / "." / "./" / "/") */
function isRootishPath(p: unknown): boolean {
  if (p === undefined || p === null) return true
  if (typeof p !== "string") return false
  const t = p.trim()
  return t === "" || t === "." || t === "./" || t === "/"
}

/** True when the tool call would scan the whole project rather than a named scope (pure, conservative) */
export function isBroadSearchCall(tool: string, args: unknown): boolean {
  try {
    const a = (args ?? {}) as { pattern?: unknown; path?: unknown; command?: unknown }
    if (tool === "glob") {
      const pattern = typeof a.pattern === "string" ? a.pattern : ""
      if (!pattern.includes("**")) return false
      // a concrete leading directory in the pattern itself (e.g. src/**/*.ts) already scopes the search
      const first = pattern.split("/")[0] ?? ""
      const wildcardFirst = first === "**" || first.includes("*") || /^[{[?]/.test(first)
      return wildcardFirst && isRootishPath(a.path)
    }
    if (tool === "grep") {
      // whole-project text search = exactly what the user must be asked about; include filters do not scope location
      return isRootishPath(a.path)
    }
    if (tool === "bash") {
      const command = typeof a.command === "string" ? a.command : ""
      return isBroadBashSearch(command)
    }
    return false
  } catch { return false }
}

const BASH_SEARCH_HEAD = /^(?:sudo\s+|env\s+|[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(rg|grep|find|fd|ag|ack)\b/

/** Flags that consume the NEXT token as a value (pattern/file/glob/type/…); their operands must not be mistaken for path operands */
const BASH_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-e", "-f", "-g", "-m", "-A", "-B", "-C", "-t", "-T",
  "--regexp", "--file", "--glob", "--type", "--type-not", "--max-count", "--max-filesize",
  "--include", "--exclude", "--exclude-dir", "--pre", "--context", "--after-context", "--before-context",
  "-name", "-iname", "-path", "-ipath", "-lname", "-regex", "-iregex", "-type", "-user", "-group", "-perm", "-size",
  "-mtime", "-atime", "-ctime", "-newer", "-exec", "-ok",
])

/** bash recursive-search heuristic: rg/fd/ag/ack recurse by default, grep only with -r/-R, find walks its root operand.
 *  Only the FIRST pipeline segment is analyzed (downstream `| head`/`| sort` legs are filters, not the search scope);
 *  quoted tokens are unquoted; '!'-prefixed exclusion globs are never path operands */
function isBroadBashSearch(command: string): boolean {
  const seg = command.trim().split(/(?:\|\||&&|;|\|)/)[0]!.trim()
  const m = BASH_SEARCH_HEAD.exec(seg)
  if (!m) return false
  const name = m[1]!
  const tokens = seg.slice(m[0].length).split(/\s+/).filter(Boolean)
  const positional: string[] = []
  let skipNext = false
  for (const raw of tokens) {
    if (skipNext) { skipNext = false; continue }
    if (raw.startsWith("-")) {
      if (BASH_VALUE_FLAGS.has(raw)) skipNext = true
      continue
    }
    const t = raw.replace(/^['"]|['"]$/g, "")
    if (t.startsWith("!")) continue
    positional.push(t)
  }
  if (name === "grep") {
    // grep recurses only with -r/-R among the flags seen
    const flags = tokens.filter((t) => t.startsWith("-")).join(" ")
    if (!/(^|\s)-[a-zA-Z]*[rR]/.test(` ${flags} `) && !/\s--recursive\b/.test(` ${flags} `)) return false
  }
  if (name === "find") {
    // find [flags] ROOT [...]: absent root = cwd; root-ish root = whole project
    return positional.length === 0 || isRootishPath(positional[0])
  }
  // rg/fd/ag/ack [flags] PATTERN [PATH...]: pattern-only (or -e pattern) = cwd; any root-ish path operand = whole project
  if (positional.length <= 1) return true
  return positional.some((p) => isRootishPath(p))
}

/** One-line description of the blocked call for the ask text (bounded, quoted fragments stripped) */
export function describeSearchCall(tool: string, args: unknown): string {
  const a = (args ?? {}) as { pattern?: unknown; command?: unknown }
  const raw = tool === "bash" ? (typeof a.command === "string" ? a.command : "") : (typeof a.pattern === "string" ? a.pattern : "")
  const desc = raw.replace(/["'\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60)
  return `${tool}: ${desc || "(no pattern)"}`
}

/** Pure gate decision: null = allow, string = the denial message shown to the model */
export function searchClarifyDenyMessage(desc: string): string {
  return [
    `[opencode-switchman] BLOCKED (broad-search clarify): this call would search the whole project (${desc}).`,
    `Ask the user ONCE via the question tool before re-running it — question text verbatim, marker included:`,
    `"${SEARCH_ASK_MARKER}: I am about to run a whole-project search (${desc}). Do you have more precise`,
    `file/directory guidance?" (single-choice, options: "No — search the whole project" / "Yes — I will type paths",`,
    `free input allowed). With narrower paths: redo the search scoped to them and never fall back to a whole-project`,
    `scan while that scope holds. Without guidance (or the user declines): retry this exact call — it passes once the`,
    `ask has completed. Retrying the search without asking is a violation.`,
  ].join(" ")
}

/** True when the question-tool args carry our marker question (the search-scope ask relayed by the model) */
export function hasSearchMarkerQuestion(args: unknown): boolean {
  try {
    const questions = (args as any)?.questions
    return Array.isArray(questions) && questions.some((q) => typeof q?.question === "string" && q.question.includes(SEARCH_ASK_MARKER))
  } catch { return false }
}
