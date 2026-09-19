// [2026-09-19]-[i18n core: render-time localization for all user-visible switchman UI strings (sidebar chrome,
//  dialogs, status-log notices, quota labels, CLI copy). Locale chain: current session's project lang
//  (lang.conversation: <workspace>/settings.json → AGENTS.md marker) → global ui.lang (state ui-locale.json,
//  from the plugin config "ui" section) → terminal env (LC_ALL/LANG) → "en". Model-facing protocol copy
//  (agents-md.ts protocol, [ROUTES]/[WATERMARK]/[LIMITS] lines, [LANG] line, lang-gate denials, ask directive
//  body) stays English by design — capture anchors must remain byte-stable across locales]
import { detectUiLocale, loadLangConfig, normalizeUiLocale } from "./lang-config"
import { en } from "./locales/en"
import { zhCN } from "./locales/zh-CN"
import { zhTW } from "./locales/zh-TW"
import { ja } from "./locales/ja"
import { ko } from "./locales/ko"
import { es } from "./locales/es"
import { fr } from "./locales/fr"
import { de } from "./locales/de"
import { it } from "./locales/it"
import { pt } from "./locales/pt"
import { ru } from "./locales/ru"

/** All locale tags shipped (mirrors UI_LOCALE_TAGS in lang-config.ts; keep the two in sync) */
export const LOCALE_TAGS = ["en", "zh-CN", "zh-TW", "ja", "ko", "es", "fr", "de", "it", "pt", "ru"] as const
export type LocaleTag = (typeof LOCALE_TAGS)[number]

/** Canonical message key set — keyof the English catalog (source of truth); other locales are Partial but completeness-tested */
export type MsgKey = keyof typeof en

export const CATALOGS: Record<LocaleTag, Partial<Record<MsgKey, string>>> = {
  en, "zh-CN": zhCN, "zh-TW": zhTW, ja, ko, es, fr, de, it, pt, ru,
}

/** Translate `key` into `locale` with `{param}` interpolation. Unknown locale or key falls back to English, then
 *  to `fallback`, then to the key itself — never throws, so a missing translation can never break rendering. */
export function t(locale: unknown, key: MsgKey, params?: Record<string, string | number>, fallback?: string): string {
  // [2026-09-19]-[typecheck fix: normalizeUiLocale returns string|null but is contractually limited to UI_LOCALE_TAGS,
  //  which mirrors LOCALE_TAGS exactly (keep the two in sync) — so its non-null results are safe to cast to LocaleTag]
  const tag = (normalizeUiLocale(locale) as LocaleTag | null) ?? "en"
  const cat = CATALOGS[tag] ?? CATALOGS.en!
  const tmpl = cat[key] ?? CATALOGS.en![key] ?? fallback ?? String(key)
  if (!params) return tmpl
  return tmpl.replace(/\{([a-zA-Z0-9_]+)\}/g, (m: string, p: string) => (params[p] === undefined ? m : String(params[p])))
}

export interface DisplayLocaleInputs {
  /** Project directory of the session being viewed (sidebar) — null/absent skips the project step (CLI) */
  sessionDir?: string | null
  /** Configured workspace dirname (state workspace-meta.json); defaults to ".switchman" */
  workspaceDirname?: string
  /** Global UI language override (state ui-locale.json; from plugin config "ui"."lang") */
  uiLang?: string | null
  /** Environment for terminal-locale detection (defaults to process.env inside detectUiLocale) */
  env?: Record<string, string | undefined>
}

/** Resolve the display locale for the sidebar/CLI: project lang → global ui.lang → terminal env → "en".
 *  Pure — callers own the IO (reading state files / session directory). */
export function resolveDisplayLocale(inputs: DisplayLocaleInputs): LocaleTag {
  if (inputs.sessionDir) {
    try {
      const loaded = loadLangConfig(inputs.sessionDir, inputs.workspaceDirname?.trim() || ".switchman")
      if (loaded) {
        const tag = normalizeUiLocale(loaded.cfg.conversation)
        // UI_LOCALE_TAGS ≡ LOCALE_TAGS sync contract: normalizeUiLocale only returns tags from that set
        if (tag) return tag as LocaleTag
      }
    } catch { /* fail-open: fall through to the next chain step */ }
  }
  const ui = normalizeUiLocale(inputs.uiLang)
  if (ui) return ui as LocaleTag
  return detectUiLocale(inputs.env).locale as LocaleTag
}

/** Render one persisted status-log entry: legacy text-only entries pass through verbatim; keyed entries translate
 *  (unknown runtime keys — e.g. after a downgrade — fall back to the stored text, then the key). */
export function renderNotice(entry: { key?: string; params?: Record<string, string | number>; text?: string }, locale: unknown): string {
  if (!entry.key) return entry.text ?? ""
  return t(locale, entry.key as MsgKey, entry.params, entry.text ?? entry.key)
}
