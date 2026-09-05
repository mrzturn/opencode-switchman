// [2026-09-05]-[project language preference fixture: normalize/parse (settings.json + AGENTS.md marker)/render
//  (ask directive + [LANG] iron-rule line)/question-answer capture end-to-end/config surface (defaults,
//  validation fallback, tuple override)]
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  normalizeLangValue, parseLangSettings, parseAgentsMdLangMarker, loadLangConfig, saveLangConfig,
  renderAskDirective, renderLangLine, parseQuestionAnswers, saveLangFromQuestion, LANG_SETTINGS_FILE,
} from "../src/lang-config"
import { validateUserConfig, resolveEffectiveOptions } from "../src/config"
import { DEFAULT_LANG_CANDIDATES } from "../src/types"

function sandboxProject(): string {
  return mkdtempSync(join(tmpdir(), "switchman-lang-"))
}

describe("lang-config: normalizeLangValue", () => {
  test("maps well-known labels to tags (exact and case-insensitive), keeps customs verbatim", () => {
    expect(normalizeLangValue("English")).toBe("en")
    expect(normalizeLangValue("简体中文")).toBe("zh-CN")
    expect(normalizeLangValue("日本語")).toBe("ja")
    expect(normalizeLangValue("  español ")).toBe("es")
    expect(normalizeLangValue("pt-BR")).toBe("pt-BR")
    expect(normalizeLangValue("文言文")).toBe("文言文")
  })
  test("rejects empty / non-string / oversized", () => {
    expect(normalizeLangValue("")).toBeNull()
    expect(normalizeLangValue("   ")).toBeNull()
    expect(normalizeLangValue(42)).toBeNull()
    expect(normalizeLangValue(null)).toBeNull()
    expect(normalizeLangValue("x".repeat(49))).toBeNull()
  })
})

describe("lang-config: parseLangSettings / parseAgentsMdLangMarker", () => {
  test("settings: valid roundtrip; missing key / bad JSON / bad value → null; extra fields ignored", () => {
    expect(parseLangSettings(JSON.stringify({ v: 1, configuredAt: "x", lang: { conversation: "zh-CN", comments: "zh-CN", docs: "en" } })))
      .toEqual({ conversation: "zh-CN", comments: "zh-CN", docs: "en" })
    expect(parseLangSettings(JSON.stringify({ lang: { conversation: "zh-CN", comments: "zh-CN" } }))).toBeNull()
    expect(parseLangSettings("{not json")).toBeNull()
    expect(parseLangSettings(JSON.stringify({ lang: { conversation: "", comments: "en", docs: "en" } }))).toBeNull()
    expect(parseLangSettings("null")).toBeNull()
  })
  test("AGENTS.md marker: found / absent / malformed", () => {
    const md = "# Project\n\nswitchman:lang conversation=zh-CN comments=en docs=zh-CN\n"
    expect(parseAgentsMdLangMarker(md)).toEqual({ conversation: "zh-CN", comments: "en", docs: "zh-CN" })
    expect(parseAgentsMdLangMarker("# no marker here")).toBeNull()
    expect(parseAgentsMdLangMarker("switchman:lang conversation= docs=en docs=en")).toBeNull()
  })
})

describe("lang-config: render functions", () => {
  test("ask directive carries three marker questions, all candidates and the no-self-write rule", () => {
    const d = renderAskDirective(DEFAULT_LANG_CANDIDATES)
    expect(d).toContain("switchman-lang 1/3")
    expect(d).toContain("switchman-lang 2/3")
    expect(d).toContain("switchman-lang 3/3")
    for (const c of DEFAULT_LANG_CANDIDATES) expect(d).toContain(c)
    expect(d).toContain("never write the settings file yourself")
  })
  test("[LANG] line carries three keys, iron rule and single-turn exception semantics", () => {
    const line = renderLangLine({ conversation: "zh-CN", comments: "zh-CN", docs: "en" }, "settings")
    expect(line).toContain("conversation=zh-CN")
    expect(line).toContain("comments=zh-CN")
    expect(line).toContain("docs=en")
    expect(line).toContain("IRON RULE")
    expect(line).toContain("single-turn exceptions")
    expect(renderLangLine({ conversation: "en", comments: "en", docs: "en" }, "agents-md")).toContain("AGENTS.md marker")
  })
})

describe("lang-config: parseQuestionAnswers", () => {
  test("marker-question match over the question tool's textual result", () => {
    const out = 'User has answered your questions: "switchman-lang 1/3: Conversation language?"="简体中文", "switchman-lang 2/3: Comments language?"="简体中文", "switchman-lang 3/3: Docs language?"="English"'
    expect(parseQuestionAnswers(out)).toEqual(["简体中文", "简体中文", "English"])
  })
  test("positional fallback when markers absent", () => {
    const out = 'User has answered your questions: "Q1"="a", "Q2"="b", "Q3"="c"'
    expect(parseQuestionAnswers(out)).toEqual(["a", "b", "c"])
  })
  test("fewer than three pairs → null", () => {
    expect(parseQuestionAnswers('User has answered your questions: "Q1"="a"')).toBeNull()
    expect(parseQuestionAnswers("user declined")).toBeNull()
  })
})

describe("lang-config: IO (load/save/capture)", () => {
  test("saveLangConfig writes atomic settings.json; loadLangConfig reads it back", () => {
    const dir = sandboxProject()
    const rel = saveLangConfig(dir, ".switchman", { conversation: "zh-CN", comments: "zh-CN", docs: "en" })
    expect(rel).toBe(`.switchman/${LANG_SETTINGS_FILE}`)
    expect(existsSync(join(dir, rel!))).toBe(true)
    const loaded = loadLangConfig(dir, ".switchman")
    expect(loaded?.source).toBe("settings")
    expect(loaded?.cfg).toEqual({ conversation: "zh-CN", comments: "zh-CN", docs: "en" })
    rmSync(dir, { recursive: true, force: true })
  })
  test("settings.json wins over AGENTS.md marker; marker is the fallback; neither → null; custom dirname honored", () => {
    const dir = sandboxProject()
    mkdirSync(join(dir, ".sw"))
    writeFileSync(join(dir, ".sw", LANG_SETTINGS_FILE), JSON.stringify({ lang: { conversation: "ja", comments: "ja", docs: "ja" } }))
    writeFileSync(join(dir, "AGENTS.md"), "switchman:lang conversation=zh-CN comments=zh-CN docs=zh-CN\n")
    expect(loadLangConfig(dir, ".sw")?.cfg.conversation).toBe("ja")
    expect(loadLangConfig(dir, ".switchman")?.source).toBe("agents-md")
    rmSync(join(dir, ".sw"), { recursive: true, force: true })
    writeFileSync(join(dir, "AGENTS.md"), "no marker\n")
    expect(loadLangConfig(dir, ".switchman")).toBeNull()
    rmSync(dir, { recursive: true, force: true })
  })
  test("saveLangFromQuestion: marker args + result → persisted config with normalized tags; non-marker args → null, no file", () => {
    const dir = sandboxProject()
    const args = { questions: [
      { question: "switchman-lang 1/3: Conversation language for this project (your replies and reasoning)?", options: [{ label: "English" }] },
      { question: "switchman-lang 2/3: Language for code comments and commit messages?", options: [{ label: "English" }] },
      { question: "switchman-lang 3/3: Language for generated documents?", options: [{ label: "English" }] },
    ] }
    const out = 'User has answered your questions: "switchman-lang 1/3: Conversation language for this project (your replies and reasoning)?"="简体中文", "switchman-lang 2/3: Language for code comments and commit messages?"="简体中文", "switchman-lang 3/3: Language for generated documents?"="English"'
    const saved = saveLangFromQuestion(args, out, dir, ".switchman")
    expect(saved?.cfg).toEqual({ conversation: "zh-CN", comments: "zh-CN", docs: "en" })
    expect(JSON.parse(readFileSync(join(dir, ".switchman", LANG_SETTINGS_FILE), "utf8")).lang).toEqual({ conversation: "zh-CN", comments: "zh-CN", docs: "en" })
    expect(saveLangFromQuestion({ questions: [{ question: "unrelated?" }] }, out, dir, ".switchman")).toBeNull()
    expect(saveLangFromQuestion(args, "user declined to answer", dir, ".switchman")).toBeNull()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("lang-config: config surface", () => {
  test("defaults fill the lang section; bad values fall back with SWM037", () => {
    const ok = validateUserConfig({})
    expect(ok.config.lang).toEqual({ enabled: true, ask: true, candidates: [...DEFAULT_LANG_CANDIDATES] })
    const bad = validateUserConfig({ lang: { enabled: "yes", ask: 1, candidates: ["", "x".repeat(49)] } })
    expect(bad.config.lang.enabled).toBe(true)
    expect(bad.config.lang.ask).toBe(true)
    expect(bad.config.lang.candidates).toEqual([...DEFAULT_LANG_CANDIDATES])
    expect(bad.diagnostics.filter((d) => (d.path ?? "").startsWith("lang.")).length).toBe(3)
  })
  test("resolveEffectiveOptions: jsonc baseline + tuple explicit-key override", () => {
    const cfg = validateUserConfig({ lang: { ask: false } }).config
    const none = resolveEffectiveOptions({}, cfg)
    expect(none.options.lang).toEqual({ enabled: true, ask: false, candidates: [...DEFAULT_LANG_CANDIDATES] })
    const tuple = resolveEffectiveOptions({ lang: { enabled: false } }, cfg)
    expect(tuple.options.lang!.enabled).toBe(false)
    expect(tuple.options.lang!.ask).toBe(false)
    expect(tuple.legacySections).toContain("lang")
  })
})
