// [2026-09-04]-[图片中继 fixture：relayImageParts 纯函数三例（无视觉替换落盘/有视觉原样/元数据未知原样）
//  ＋写盘失败保留原部件与本地路径原值引用]
import { describe, expect, test } from "bun:test"
import { relayImageParts } from "../src/relay"

const PNG_B64 = Buffer.from("fake-png-bytes").toString("base64")

function filePart(id: string, url: string, mime = "image/png") {
  return { id, sessionID: "s1", messageID: "m1", type: "file", mime, url }
}

describe("relay：relayImageParts 纯函数", () => {
  test("无视觉＋data URL 图片部件 → 替换为读图指引文本部件且写盘被调用", async () => {
    const written: Array<{ path: string; bytes: Uint8Array }> = []
    const parts = [
      { id: "t0", type: "text", text: "看这张图" },
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
    // 全部图片部件聚合成一个文本部件，其余部件原样保留
    expect(res.parts.length).toBe(2)
    const textPart = res.parts[1] as any
    expect(textPart.type).toBe("text")
    expect(textPart.sessionID).toBe("s1")
    expect(textPart.messageID).toBe("m1")
    expect(textPart.text).toContain("本会话模型无视觉输入")
    expect(textPart.text).toContain(written[0]!.path)
    expect(textPart.text).toContain("glm-mx-46v-high")
    expect(textPart.text).toContain('"lane":"vision"')
    expect(textPart.text).toContain("MCP 视觉工具")
    // 原数组未被原地修改
    expect((parts[1] as any).type).toBe("file")
  })

  test("有视觉 → 原样返回（changed=false，不写盘）", async () => {
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

  test("元数据未知（null）→ 原样返回（fail-open 不动）", async () => {
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

  test("无图片部件 → 原样；写盘失败保留原部件；本地路径原值引用不写盘", async () => {
    let called = 0
    const write = async () => { called++ }
    const plain = [{ id: "t0", type: "text", text: "纯文本" }]
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
    expect((r2.parts[0] as any).text).toContain("调用 MCP 视觉工具")
  })
})
