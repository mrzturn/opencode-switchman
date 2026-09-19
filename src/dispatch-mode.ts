// [2026-09-14]-[D3 dispatch opt-out: top-level "dispatch": "off" in <workspace-dirname>/settings.json — the same file
//  the lang config lives in (parseLangSettings ignores extra top-level fields, so the two coexist). Exactly the string
//  "off" opts out; the field absent / non-string / any other value → fleet (fail-open). Read per call (cheap
//  small-file JSON.parse, same pattern as loadLangConfig) so toggling the setting takes effect on the next task call /
//  next request without a restart; never throws]
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { appendStatusLog } from "./state"
import type { MsgKey } from "./i18n"
import { LANG_SETTINGS_FILE } from "./lang-config"

export type DispatchMode = "fleet" | "off"

export interface ParsedDispatchMode {
  mode: DispatchMode
  /** file exists but JSON.parse fails entirely (broken-settings warning case) */
  broken: boolean
  /** a "dispatch" field is present but not the exact string "off" (visibility note; fleet behavior) */
  invalidValue: boolean
  /** the raw present value for the note copy (undefined when absent) */
  rawValue?: string
}

/** Pure parse of the settings.json text: exactly "off" → off; anything else → fleet (fail-open) */
export function parseDispatchMode(text: string): ParsedDispatchMode {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return { mode: "fleet", broken: true, invalidValue: false }
  }
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const d = (v as Record<string, unknown>).dispatch
    if (d === undefined) return { mode: "fleet", broken: false, invalidValue: false }
    if (d === "off") return { mode: "off", broken: false, invalidValue: false }
    return { mode: "fleet", broken: false, invalidValue: true, rawValue: typeof d === "string" ? d : JSON.stringify(d) }
  }
  // valid JSON but not an object → no dispatch field exists; fleet, no note (same class as a missing file)
  return { mode: "fleet", broken: false, invalidValue: false }
}

// once-per-process-per-path guards: loadDispatchMode is read per call (task calls AND every system.transform request
// via the [ROUTE] gate), so un-gated notes would spam the status log on every request
const brokenWarned = new Set<string>()
const invalidNoted = new Set<string>()

/** Read the project dispatch mode (sync, cheap, fail-open, never throws). Logs the broken-settings warning and the
 *  present-but-invalid note once per process per path via the injected log callback (defaults to appendStatusLog).
 *  [2026-09-19]-[P3c status-log i18n: the log callback carries structured (key, params); English only, no behavior change]
 *  [2026-09-19]-[i18n cleanup: tighten the log callback key to MsgKey (both sites use catalog keys)] */
export function loadDispatchMode(
  projectDir: string,
  workspaceDirname: string,
  log: (key: MsgKey, params?: Record<string, string | number>) => void = appendStatusLog,
): DispatchMode {
  const abs = join(projectDir, workspaceDirname, LANG_SETTINGS_FILE)
  try {
    if (!existsSync(abs)) return "fleet"
    const parsed = parseDispatchMode(readFileSync(abs, "utf8"))
    if (parsed.broken) {
      if (!brokenWarned.has(abs)) {
        brokenWarned.add(abs)
        log("notice.lang.settingsInvalidJson", { workspaceDirname, langSettingsFile: LANG_SETTINGS_FILE })
      }
      return "fleet"
    }
    if (parsed.invalidValue && !invalidNoted.has(abs)) {
      invalidNoted.add(abs)
      log("notice.lang.dispatchNotOff", { workspaceDirname, langSettingsFile: LANG_SETTINGS_FILE, rawValue: parsed.rawValue ?? "" })
    }
    return parsed.mode
  } catch {
    return "fleet"
  }
}
