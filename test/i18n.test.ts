// [2026-09-19]-[i18n behavioral contract: catalog completeness (every locale covers every English key),
//  placeholder parity (translations keep the exact {param} set), t() interpolation/fallback semantics,
//  display-locale resolution chain, and legacy-compat notice rendering]
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CATALOGS, LOCALE_TAGS, renderNotice, resolveDisplayLocale, t, type MsgKey } from "../src/i18n"

const enKeys = Object.keys(CATALOGS.en!) as MsgKey[]
const paramsOf = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",")

describe("i18n catalog", () => {
  test("every locale covers every English key with a non-empty string", () => {
    expect(enKeys.length).toBeGreaterThan(0)
    for (const tag of LOCALE_TAGS) {
      if (tag === "en") continue
      const cat = CATALOGS[tag]!
      const missing = enKeys.filter((k) => typeof cat[k] !== "string" || cat[k]!.length === 0)
      expect(missing).toEqual([])
    }
  })

  test("placeholder sets match English in every locale", () => {
    for (const tag of LOCALE_TAGS) {
      if (tag === "en") continue
      const cat = CATALOGS[tag]!
      for (const k of enKeys) expect(paramsOf(cat[k]!)).toBe(paramsOf(CATALOGS.en![k]!))
    }
  })
})

describe("t()", () => {
  test("interpolates params", () => {
    expect(t("en", "quota.pctLeft" as MsgKey, undefined, "{n}% left")).toBe("{n}% left")
    expect(t("en", "quota.pctLeft" as MsgKey, { n: 42 }, "{n}% left")).toBe("42% left")
  })

  test("missing param stays literal; unknown locale falls back to English", () => {
    expect(t("en", "quota.pctLeft" as MsgKey, undefined, "a {x} b")).toBe("a {x} b")
    expect(t("xx-ZZ", "quota.pctLeft" as MsgKey, { x: 1 }, "a {x} b")).toBe("a 1 b")
  })

  test("unknown key falls back to the provided fallback, then the key itself", () => {
    expect(t("en", "not.a.real.key" as MsgKey, undefined, "fallback!")).toBe("fallback!")
    expect(t("en", "not.a.real.key" as MsgKey)).toBe("not.a.real.key")
  })

  test("real keys translate without fallback", () => {
    const k = enKeys[0]!
    expect(t("en", k)).toBe(CATALOGS.en![k]!)
    expect(t("zh-CN", k)).toBe(CATALOGS["zh-CN"]![k]!)
  })
})

describe("resolveDisplayLocale()", () => {
  const withTempDir = (fn: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "swm-i18n-"))
    try { fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
  }
  const writeSettings = (dir: string, conversation: string) => {
    mkdirSync(join(dir, ".switchman"), { recursive: true })
    writeFileSync(join(dir, ".switchman", "settings.json"), JSON.stringify({ lang: { conversation, comments: "en", docs: "en" } }))
  }

  test("project settings.json lang.conversation wins over uiLang and env", () => {
    withTempDir((dir) => {
      writeSettings(dir, "zh-CN")
      expect(resolveDisplayLocale({ sessionDir: dir, uiLang: "ja", env: { LC_ALL: "ko_KR.UTF-8" } })).toBe("zh-CN")
    })
  })

  test("custom workspaceDirname is honored; AGENTS.md marker is the project fallback", () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, ".arts"), { recursive: true })
      writeFileSync(join(dir, ".arts", "settings.json"), JSON.stringify({ lang: { conversation: "fr", comments: "en", docs: "en" } }))
      writeFileSync(join(dir, "AGENTS.md"), "switchman:lang conversation=zh-TW comments=en docs=en\n")
      expect(resolveDisplayLocale({ sessionDir: dir, workspaceDirname: ".arts", env: {} })).toBe("fr")
      expect(resolveDisplayLocale({ sessionDir: dir, env: {} })).toBe("zh-TW")
    })
  })

  test("uiLang beats env; env wins when project and uiLang are absent; default en", () => {
    expect(resolveDisplayLocale({ uiLang: "de", env: { LC_ALL: "fr_FR.UTF-8" } })).toBe("de")
    expect(resolveDisplayLocale({ env: { LC_ALL: "fr_FR.UTF-8" } })).toBe("fr")
    expect(resolveDisplayLocale({ env: {} })).toBe("en")
  })

  test("unnormalizable project conversation value falls through to the next chain step", () => {
    withTempDir((dir) => {
      writeSettings(dir, "klingon")
      expect(resolveDisplayLocale({ sessionDir: dir, uiLang: "ru", env: {} })).toBe("ru")
    })
  })
})

describe("renderNotice()", () => {
  test("legacy text-only entry passes through verbatim", () => {
    expect(renderNotice({ text: "old prose entry" }, "zh-CN")).toBe("old prose entry")
  })

  test("keyed entry translates with params", () => {
    const k = enKeys[0]!
    expect(renderNotice({ key: k }, "zh-CN")).toBe(CATALOGS["zh-CN"]![k]!)
  })

  test("unknown runtime key falls back to the stored text, then the key", () => {
    expect(renderNotice({ key: "notice.gone", text: "stored text" }, "en")).toBe("stored text")
    expect(renderNotice({ key: "notice.gone" }, "en")).toBe("notice.gone")
  })
})
