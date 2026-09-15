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

// [2026-09-14]-[D4 locale-following ask: opencode exposes no locale surface to plugins, so the chain is env LC_ALL →
//  LANG → "en" (normalized, unknown values fall through). Only the user-facing question texts localize — the directive
//  body, the [LANG] line, the deny copy and the `switchman-lang n/3: ` prefix (the capture anchor for
//  parseQuestionAnswers) stay byte-stable across all locales, so capture never depends on the locale]
/** Locale tags the ask questions are translated into (translation-table keys; matches the LANG_TAGS candidate set) */
const UI_LOCALE_TAGS = ["en", "zh-CN", "zh-TW", "ja", "ko", "es", "fr", "de", "it", "pt", "ru"]

/**
 * Map a raw locale (BCP-47 or env style, e.g. "zh_CN.UTF-8") to one of UI_LOCALE_TAGS: exact case-insensitive match
 * wins; zh-TW / zh-Hant / zh-HK / zh-MO prefixes map to zh-TW, any other zh* to zh-CN; otherwise the primary subtag
 * must itself be a known tag; null when nothing matches (caller falls through / defaults to en).
 */
export function normalizeUiLocale(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const cleaned = raw.trim().split(".")[0]!.split("@")[0]!.replace(/_/g, "-")
  if (!cleaned) return null
  const lower = cleaned.toLowerCase()
  const exact = UI_LOCALE_TAGS.find((t) => t.toLowerCase() === lower)
  if (exact) return exact
  if (lower.startsWith("zh")) return /^zh-(tw|hant|hk|mo)/.test(lower) ? "zh-TW" : "zh-CN"
  const primary = lower.split("-")[0]!
  return UI_LOCALE_TAGS.find((t) => t.toLowerCase() === primary) ?? null
}

export interface UiLocaleDetection { locale: string; via: "LC_ALL" | "LANG" | "default" }

/** Detect the UI locale for localizing the ask questions (sync, cheap, fail-open; never throws; unknown → "en").
 *  Chain: env LC_ALL → env LANG (env-style "zh_CN.UTF-8" normalized) → "en"; an unrecognized value at any step
 *  falls through to the next one. Locale is read at ask time — no config. */
export function detectUiLocale(env: Record<string, string | undefined> = process.env): UiLocaleDetection {
  try {
    for (const key of ["LC_ALL", "LANG"] as const) {
      const tag = normalizeUiLocale(env[key])
      if (tag) return { locale: tag, via: key }
    }
  } catch { /* fail-open */ }
  return { locale: "en", via: "default" }
}

/** Builds a table entry so the `switchman-lang n/3: ` prefix is byte-stable across every locale (capture anchor) */
const askQ = (n: 1 | 2 | 3, text: string) => `${askTag(n)}: ${text}`

/** Localized question texts per UI locale tag (the only user-visible strings of the ask; options stay the native labels) */
export const UI_LOCALE_ASK_TEXT: Readonly<Record<string, readonly [string, string, string]>> = Object.freeze({
  en: [
    askQ(1, "Conversation language for this project (your replies and reasoning)?"),
    askQ(2, "Language for code comments and commit messages?"),
    askQ(3, "Language for generated documents (plans, PRD, design docs, reports)?"),
  ],
  "zh-CN": [
    askQ(1, "本项目的对话语言（你的回复与推理）？"),
    askQ(2, "代码注释与提交信息用什么语言？"),
    askQ(3, "生成的文档（计划、PRD、设计文档、报告）用什么语言？"),
  ],
  "zh-TW": [
    askQ(1, "本專案的對話語言（回覆與推理）？"),
    askQ(2, "程式碼註解與提交訊息使用什麼語言？"),
    askQ(3, "產生的文件（計畫、PRD、設計文件、報告）使用什麼語言？"),
  ],
  ja: [
    askQ(1, "このプロジェクトの会話言語（返答と推論）は？"),
    askQ(2, "コードコメントとコミットメッセージの言語は？"),
    askQ(3, "生成されるドキュメント（計画、PRD、設計書、レポート）の言語は？"),
  ],
  ko: [
    askQ(1, "이 프로젝트의 대화 언어(응답과 추론)는 무엇인가요?"),
    askQ(2, "코드 주석과 커밋 메시지에 사용할 언어는 무엇인가요?"),
    askQ(3, "생성되는 문서(계획, PRD, 설계 문서, 보고서)의 언어는 무엇인가요?"),
  ],
  es: [
    askQ(1, "¿Idioma de conversación para este proyecto (tus respuestas y razonamiento)?"),
    askQ(2, "¿Idioma para los comentarios de código y los mensajes de commit?"),
    askQ(3, "¿Idioma para los documentos generados (planes, PRD, documentos de diseño, informes)?"),
  ],
  fr: [
    askQ(1, "Langue de conversation pour ce projet (réponses et raisonnement) ?"),
    askQ(2, "Langue des commentaires de code et des messages de commit ?"),
    askQ(3, "Langue des documents générés (plans, PRD, documents de conception, rapports) ?"),
  ],
  de: [
    askQ(1, "Gesprächssprache für dieses Projekt (deine Antworten und Gedankengänge)?"),
    askQ(2, "Sprache für Codekommentare und Commit-Meldungen?"),
    askQ(3, "Sprache für generierte Dokumente (Pläne, PRD, Design-Dokumente, Berichte)?"),
  ],
  it: [
    askQ(1, "Lingua di conversazione per questo progetto (le tue risposte e il tuo ragionamento)?"),
    askQ(2, "Lingua per i commenti al codice e i messaggi di commit?"),
    askQ(3, "Lingua per i documenti generati (piani, PRD, documenti di progettazione, report)?"),
  ],
  pt: [
    askQ(1, "Idioma de conversa para este projeto (suas respostas e raciocínio)?"),
    askQ(2, "Idioma para comentários de código e mensagens de commit?"),
    askQ(3, "Idioma para documentos gerados (planos, PRD, documentos de design, relatórios)?"),
  ],
  ru: [
    askQ(1, "Язык общения для этого проекта (ваши ответы и рассуждения)?"),
    askQ(2, "Язык комментариев к коду и сообщений коммитов?"),
    askQ(3, "Язык создаваемых документов (планы, PRD, проектные документы, отчёты)?"),
  ],
})

/** First-run ask directive: one question-tool call, three marker questions, plugin-side capture. Question texts follow
 *  the detected UI locale (normalized, English fallback); the directive body stays English (model-facing). */
export function renderAskDirective(candidates: readonly string[], locale = "en"): string {
  const asks = UI_LOCALE_ASK_TEXT[normalizeUiLocale(locale) ?? "en"] ?? UI_LOCALE_ASK_TEXT.en!
  const opts = candidates.join(" / ")
  return [
    `[opencode-switchman] Project language preference is not yet configured for this project. Before starting`,
    `the user's task, call the question tool ONCE with exactly these three questions (question texts verbatim, marker`,
    `included — the plugin captures the answers itself and persists the config; never write the settings file yourself):`,
    `1. question "${asks[0]}", single-choice, options: ${opts}`,
    `2. question "${asks[1]}", single-choice, options: ${opts}`,
    `3. question "${asks[2]}", single-choice, options: ${opts}`,
    `The user may also type any other language (custom answer) — relay it verbatim as the option text.`,
    `HARD GATE: the plugin denies every write / edit / bash / task call in this project until the answers are captured`,
    `and the config is saved — asking first is not optional. After the tool returns: confirm the saved preferences in`,
    `one line, then continue the user's task in the chosen conversation language. If the user declines or the question`,
    `tool is unavailable, skip silently and proceed with English defaults (the plugin waives the gate and this ask for`,
    `the session); otherwise the ask re-surfaces on the next user turn until the config is saved.`,
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

// [2026-09-07]-[lang hard gate: prompt-only enforcement proved unreliable — models routinely skipped the turn-1 (and
//  per-turn) ask directive and dove into the task. These pure helpers power a tool.execute.before gate in index.ts:
//  write/edit/bash/task calls are denied with an ask-first error while the config is missing; reads stay open so the
//  model can still explore; a completed-but-unsaved marker question call (user declined / unparsable) waives the gate
//  for that session — impact: unconfigured projects get asked structurally, not on the model's goodwill]

/** Tools blocked by the lang gate while the project is unconfigured (mutation + delegation; reads stay allowed) */
export const LANG_GATE_TOOLS: ReadonlySet<string> = new Set(["bash", "edit", "write", "task"])

export interface LangGateInput { tool: string; configured: boolean; askEnabled: boolean; waived: boolean }

/** Pure gate decision: null = allow, string = the denial message shown to the model */
export function langGateDecision(input: LangGateInput): string | null {
  if (!input.askEnabled || input.configured || input.waived) return null
  if (!LANG_GATE_TOOLS.has(input.tool)) return null
  return [
    `[opencode-switchman] BLOCKED: this project's language preference is not configured yet. Ask the user ONCE via the`,
    `question tool with exactly the three "switchman-lang n/3" questions (see the ask directive in your system prompt)`,
    `and wait for the answers — the plugin persists them and unblocks this call automatically, then retry. Reads stay`,
    `allowed. If the user declines, the gate is waived for this session.`,
  ].join(" ")
}

/** True when the question-tool args carry our marker questions (the lang ask relayed by the model) */
export function hasLangMarkerQuestions(args: unknown): boolean {
  try {
    const questions = (args as any)?.questions
    return Array.isArray(questions) && questions.some((q) => typeof q?.question === "string" && q.question.includes(LANG_ASK_MARKER))
  } catch { return false }
}

/** tool.execute.after capture: marker-carrying question args + textual result → persisted config (fail-open null) */
export function saveLangFromQuestion(args: unknown, toolOutput: unknown, projectDir: string, workspaceDirname: string): { rel: string; cfg: LangConfig } | null {
  try {
    if (!hasLangMarkerQuestions(args)) return null
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
