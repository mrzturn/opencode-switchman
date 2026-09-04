// [2026-09-04]-[English localization: translate runtime messages and comments; no logic change]
// [2026-09-04]-[image relay fixture: relayImageParts pure-function cases (no-vision replaced+persisted / has-vision as-is / metadata unknown as-is)
//  + write failure keeps the original part, and local paths keep the original-value reference]
import { describe, expect, test } from "bun:test"
import { relayImageParts } from "../src/relay"

const PNG_B64 = Buffer.from("fake-png-bytes").toString("base64")

function filePart(id: string, url: string, mime = "image/png") {
  return { id, sessionID: "s1", messageID: "m1", type: "file", mime, url }
}

describe("relay: relayImageParts pure function", () => {
  test("no vision + data URL image part → replaced by a reading-guidance text part and the writer invoked", async () => {
    const written: Array<{ path: string; bytes: Uint8Array }> = []
    const parts = [
      { id: "t0", type: "text", text: "look at this image" },
      filePart("p1", `data:image/png;base64,${PNG_B64}`),
    ]
    const res = await relayImageParts(parts, {
      modelVision: false,
      visionHead: "glm-mx-46v-high",
      writeDir: "/tmp/switchman-relay-fixture/s1",
      writeFile: async (path, bytes) => { written.push({ path, bytes }) },
    })
    expect(res.changed).toBe(true)
    expect(written.length).toBe(1)
    expect(written[0]!.path).toBe("/tmp/switchman-relay-fixture/s1/p1.png")
    expect(Buffer.from(written[0]!.bytes).toString()).toBe("fake-png-bytes")
    expect(res.paths).toEqual([written[0]!.path])
    // all image parts aggregate into one text part, other parts kept as-is
    expect(res.parts.length).toBe(2)
    const textPart = res.parts[1] as any
    expect(textPart.type).toBe("text")
    expect(textPart.sessionID).toBe("s1")
    expect(textPart.messageID).toBe("m1")
    expect(textPart.text).toContain("no vision input")
    expect(textPart.text).toContain(written[0]!.path)
    expect(textPart.text).toContain("glm-mx-46v-high")
    expect(textPart.text).toContain('"lane":"vision"')
    expect(textPart.text).toContain("MCP vision tool")
    // the original array was not mutated in place
    expect((parts[1] as any).type).toBe("file")
  })

  test("has vision → returned as-is (changed=false, nothing written)", async () => {
    let called = 0
    const parts = [filePart("p1", `data:image/png;base64,${PNG_B64}`)]
    const res = await relayImageParts(parts, {
      modelVision: true,
      visionHead: null,
      writeDir: "/tmp/switchman-relay-fixture/s2",
      writeFile: async () => { called++ },
    })
    expect(res.changed).toBe(false)
    expect(res.parts).toBe(parts)
    expect(called).toBe(0)
  })

  test("metadata unknown (null) → returned as-is (fail-open, untouched)", async () => {
    const parts = [filePart("p1", `data:image/jpeg;base64,${PNG_B64}`, "image/jpeg")]
    const res = await relayImageParts(parts, {
      modelVision: null,
      visionHead: null,
      writeDir: "/tmp/switchman-relay-fixture/s3",
      writeFile: async () => {},
    })
    expect(res.changed).toBe(false)
    expect(res.parts).toBe(parts)
  })

  test("no image parts → as-is; write failure keeps the original part; local path keeps the original value without writing", async () => {
    let called = 0
    const write = async () => { called++ }
    const plain = [{ id: "t0", type: "text", text: "plain text" }]
    const r0 = await relayImageParts(plain, { modelVision: false, visionHead: null, writeDir: "/x", writeFile: write })
    expect(r0.changed).toBe(false)

    const failParts = [filePart("pf", `data:image/webp;base64,${PNG_B64}`, "image/webp")]
    const r1 = await relayImageParts(failParts, {
      modelVision: false, visionHead: null, writeDir: "/x",
      writeFile: async () => { throw new Error("disk full") },
    })
    expect(r1.changed).toBe(false)
    expect(r1.parts).toBe(failParts)

    const localParts = [filePart("pl", "/home/u/pic/cat.png")]
    const r2 = await relayImageParts(localParts, { modelVision: false, visionHead: null, writeDir: "/x", writeFile: write })
    expect(r2.changed).toBe(true)
    expect(called).toBe(0)
    expect((r2.parts[0] as any).text).toContain("/home/u/pic/cat.png")
    expect((r2.parts[0] as any).text).toContain("call an MCP vision tool")
  })
})
