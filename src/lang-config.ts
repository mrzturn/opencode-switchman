// [2026-09-05]-[project language preference: per-project conversation/comments/docs language — hook-driven detection
//  (<workspace-dirname>/settings.json primary; AGENTS.md marker read-only fallback), first-run interactive ask
//  (the model relays one exact 3-question question-tool call; answers captured via tool.execute.after and persisted
//  by the plugin itself, never by the model), then a per-turn [LANG] iron-rule line (user ad-hoc language requests
//  are single-turn exceptions); pure functions + thin sync IO, fail-open everywhere — wiring in src/index.ts]
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { nowIso, writeJsonAtomic } from "./state"

export const LANG_SETTINGS_FILE = "settings.json"
/** Marker embedded in the ask's question texts and matched in tool.execute.after capture */
export const LANG_ASK_MARKER = "switchman-lang"

/** well-known candidate label → BCP-47-ish tag; anything else is stored verbatim */
const LANG_TAGS: Record<string, string> = {
  English: "en", 简体中文: "zh-CN", 繁體中文: "zh-TW", 日本語: "ja", 한국어: "ko",
  Español: "es", Français: "fr", Deutsch: "de", Italiano: "it", Português: "pt", Русский: "ru",
}

export interface LangConfig { conversation: string; comments: string; docs: string }
export interface LoadedLangConfig { cfg: LangConfig; source: "settings" | "agents-md"; rel: string }

const MAX_LANG_LEN = 48

/** Normalize one language value: trim, map a well-known label (case-insensitive) to its tag, bound length; bad → null */
export function normalizeLangValue(v: unknown): string | null {
  if (typeof v !== "string") return null
  const t = v.trim()
  if (!t || t.length > MAX_LANG_LEN) return null
  if (LANG_TAGS[t]) return LANG_TAGS[t]
  const ci = Object.keys(LANG_TAGS).find((k) => k.toLowerCase() === t.toLowerCase())
  return ci ? LANG_TAGS[ci]! : t
}

/** Parse <workspace-dirname>/settings.json content; all three keys valid or null (extra fields ignored) */
export function parseLangSettings(text: string): LangConfig | null {
  try {
    const v = JSON.parse(text)
    if (typeof v !== "object" || v === null) return null
    const lang = (v as any).lang
    if (typeof lang !== "object" || lang === null) return null
    const conversation = normalizeLangValue(lang.conversation)
    const comments = normalizeLangValue(lang.comments)
    const docs = normalizeLangValue(lang.docs)
    if (!conversation || !comments || !docs) return null
    return { conversation, comments, docs }
  } catch { return null }
}

/** Parse the read-only AGENTS.md marker `switchman:lang conversation=<..> comments=<..> docs=<..>` */
export function parseAgentsMdLangMarker(text: string): LangConfig | null {
  const m = /switchman:lang\s+conversation=(\S+)\s+comments=(\S+)\s+docs=(\S+)/.exec(text)
  if (!m) return null
  const conversation = normalizeLangValue(m[1])
  const comments = normalizeLangValue(m[2])
  const docs = normalizeLangValue(m[3])
  if (!conversation || !comments || !docs) return null
  return { conversation, comments, docs }
}

/** Read the project language config (sync, cheap, fail-open): settings.json primary, AGENTS.md marker fallback */
export function loadLangConfig(projectDir: string, workspaceDirname: string): LoadedLangConfig | null {
  const rel = `${workspaceDirname}/${LANG_SETTINGS_FILE}`
  try {
    const settingsPath = join(projectDir, workspaceDirname, LANG_SETTINGS_FILE)
    if (existsSync(settingsPath)) {
      const cfg = parseLangSettings(readFileSync(settingsPath, "utf8"))
      if (cfg) return { cfg, source: "settings", rel }
    }
  } catch { /* fail-open */ }
  try {
    const agentsMd = join(projectDir, "AGENTS.md")
    if (existsSync(agentsMd)) {
      const cfg = parseAgentsMdLangMarker(readFileSync(agentsMd, "utf8"))
      if (cfg) return { cfg, source: "agents-md", rel: "AGENTS.md" }
    }
  } catch { /* fail-open */ }
  return null
}

/** Persist atomically (mkdir + tmp/rename); returns the display path (posix) or null on failure */
export function saveLangConfig(projectDir: string, workspaceDirname: string, cfg: LangConfig): string | null {
  const rel = `${workspaceDirname}/${LANG_SETTINGS_FILE}`
  try {
    const abs = join(projectDir, workspaceDirname, LANG_SETTINGS_FILE)
    mkdirSync(dirname(abs), { recursive: true })
    writeJsonAtomic(abs, { v: 1, configuredAt: nowIso(), lang: cfg })
    return rel
  } catch { return null }
}

const askTag = (n: 1 | 2 | 3) => `${LANG_ASK_MARKER} ${n}/3`

/** First-run ask directive: one question-tool call, three marker questions, plugin-side capture */
export function renderAskDirective(candidates: readonly string[]): string {
  const opts = candidates.join(" / ")
  return [
    `[opencode-switchman] Project language preference is not yet configured for this project. Before starting`,
    `the user's task, call the question tool ONCE with exactly these three questions (question texts verbatim, marker`,
    `included — the plugin captures the answers itself and persists the config; never write the settings file yourself):`,
    `1. question "${askTag(1)}: Conversation language for this project (your replies and reasoning)?", single-choice, options: ${opts}`,
    `2. question "${askTag(2)}: Language for code comments and commit messages?", single-choice, options: ${opts}`,
    `3. question "${askTag(3)}: Language for generated documents (plans, PRD, design docs, reports)?", single-choice, options: ${opts}`,
    `The user may also type any other language (custom answer) — relay it verbatim as the option text.`,
    `After the tool returns: confirm the saved preferences in one line, then continue the user's task in the chosen`,
    `conversation language. If the question tool is unavailable or the user declines, skip silently and proceed with`,
    `English defaults; do not ask again in this session.`,
  ].join("\n")
}

/** Per-turn iron-rule line (config re-read from disk every turn, so this is mechanism-enforced stickiness) */
export function renderLangLine(cfg: LangConfig, source: "settings" | "agents-md"): string {
  return `[LANG] conversation=${cfg.conversation} comments=${cfg.comments} docs=${cfg.docs} (source: ${
    source === "agents-md" ? "AGENTS.md marker" : "project settings"
  }) — project-level language config, IRON RULE: reply and reason in the conversation language; code comments AND commit messages follow comments; every generated document follows docs (overrides any bundled skill's English-by-default). User ad-hoc language requests are single-turn exceptions: honor the current reply, then revert to this config automatically.`
}

/** Parse the question tool's textual result into the three answers (marker-question match first, positional fallback) */
export function parseQuestionAnswers(output: string): [string, string, string] | null {
  const pairs: Array<[string, string]> = []
  const re = /"([^"]+)"\s*=\s*"([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(output)) !== null) pairs.push([m[1]!, m[2]!])
  if (pairs.length < 3) return null
  const byMarker = (n: 1 | 2 | 3) => pairs.find(([q]) => q.includes(askTag(n)))?.[1]
  const a1 = byMarker(1), a2 = byMarker(2), a3 = byMarker(3)
  if (a1 !== undefined && a2 !== undefined && a3 !== undefined) return [a1, a2, a3]
  return [pairs[0]![1], pairs[1]![1], pairs[2]![1]]
}

/** tool.execute.after capture: marker-carrying question args + textual result → persisted config (fail-open null) */
export function saveLangFromQuestion(args: unknown, toolOutput: unknown, projectDir: string, workspaceDirname: string): { rel: string; cfg: LangConfig } | null {
  try {
    const questions = (args as any)?.questions
    if (!Array.isArray(questions) || !questions.some((q) => typeof q?.question === "string" && q.question.includes(LANG_ASK_MARKER))) return null
    if (typeof toolOutput !== "string") return null
    const answers = parseQuestionAnswers(toolOutput)
    if (!answers) return null
    const conversation = normalizeLangValue(answers[0])
    const comments = normalizeLangValue(answers[1])
    const docs = normalizeLangValue(answers[2])
    if (!conversation || !comments || !docs) return null
    const cfg = { conversation, comments, docs }
    const rel = saveLangConfig(projectDir, workspaceDirname, cfg)
    return rel ? { rel, cfg } : null
  } catch { return null }
}
