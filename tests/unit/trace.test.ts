/**
 * Diagnostics trace writer (docs/07): UTC-day file split, size rotation
 * within a day with counted indexes, retention pruning across files,
 * serialized appends, append-failure propagation with a live chain.
 * Pure in-memory fs fakes, no disk.
 */
import { describe, expect, test } from "bun:test"
import { FileTraceWriter, type TraceFsDeps } from "../../src/trace.js"
import type { TraceRecord } from "../../src/types.js"

function record(id: number, timestamp: string, pad = ""): TraceRecord {
  return {
    traceVersion: 3,
    timestamp,
    llmCalled: true,
    inputFingerprint: `fp_${id}`,
    mode: "shadow",
    model: { providerID: "test-provider", id: "test-model", variant: "low" },
    action: "shell",
    command: `echo ${id} ${pad}`,
    resources: [`echo ${id}`],
    cwdRelative: ".",
    workspaceLabel: "test",
    promptSha256: "deadbeef",
    llmLatencyMs: 42,
    rawResponse: `{"risk":"LOW","id":${id}}`,
    parseOk: true,
    assessment: { schemaVersion: 2, risk: "LOW", categories: ["READ"], confidence: "HIGH", signals: [], summary: "ok" },
    escalated: false,
    attempts: [
      {
        model: { providerID: "test-provider", id: "test-model", variant: "low" },
        llmLatencyMs: 42,
        rawResponse: `{"risk":"LOW","id":${id}}`,
        parseOk: true,
        assessment: { schemaVersion: 2, risk: "LOW", categories: ["READ"], confidence: "HIGH", signals: [], summary: "ok" },
      },
    ],
    outcome: "shadow_would_allow",
    reasonCode: "RISK_WITHIN_THRESHOLD",
    totalLatencyMs: 50,
    policyVersion: "graduated-v1",
  }
}

class FakeTraceFs implements TraceFsDeps {
  readonly files = new Map<string, string>()
  failAppend = false
  readonly unlinked: string[] = []

  async mkdir(): Promise<void> {}
  async statSize(path: string): Promise<number | null> {
    const content = this.files.get(path)
    return content === undefined ? null : content.length
  }
  async appendFile(path: string, data: string): Promise<void> {
    if (this.failAppend) throw new Error("ENOSPC: no space left")
    this.files.set(path, (this.files.get(path) ?? "") + data)
  }
  async rename(from: string, to: string): Promise<void> {
    const content = this.files.get(from)
    if (content === undefined) return
    this.files.set(to, content)
    this.files.delete(from)
  }
  async readdir(dir: string): Promise<readonly string[]> {
    const prefix = `${dir}/`
    return [...this.files.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length))
  }
  async unlink(path: string): Promise<void> {
    this.unlinked.push(path)
    this.files.delete(path)
  }
}

const DIR = "/trace"
const DAY_A = "2026-09-28"
const DAY_B = "2026-09-29"
const DAY_C = "2026-09-30"

function writer(fs: FakeTraceFs, maxFileBytes: number, retainedFiles: number): FileTraceWriter {
  return new FileTraceWriter(DIR, maxFileBytes, retainedFiles, fs)
}

describe("FileTraceWriter", () => {
  test("append writes one parseable JSONL line into the UTC-day file from the record timestamp", async () => {
    const fs = new FakeTraceFs()
    await writer(fs, 1_000_000, 7).append(record(1, `${DAY_B}T10:00:00.000Z`))
    const file = `${DIR}/trace-${DAY_B}.jsonl`
    const content = fs.files.get(file)!
    expect(content.endsWith("\n")).toBe(true)
    const parsed = JSON.parse(content.trim()) as TraceRecord
    expect(parsed.inputFingerprint).toBe("fp_1")
    expect(parsed.command).toBe("echo 1 ")
    expect(parsed.traceVersion).toBe(3)
  })

  test("records on different days land in different files", async () => {
    const fs = new FakeTraceFs()
    const w = writer(fs, 1_000_000, 7)
    await w.append(record(1, `${DAY_A}T23:59:59.000Z`))
    await w.append(record(2, `${DAY_B}T00:00:01.000Z`))
    expect([...fs.files.keys()].sort()).toEqual([`${DIR}/trace-${DAY_A}.jsonl`, `${DIR}/trace-${DAY_B}.jsonl`])
  })

  test("size rotation within a day counts indexes up and restarts the current file", async () => {
    const fs = new FakeTraceFs()
    const w = writer(fs, 400, 30)
    await w.append(record(1, `${DAY_B}T10:00:00.000Z`, "x".repeat(50)))
    await w.append(record(2, `${DAY_B}T11:00:00.000Z`, "y".repeat(50))) // rotate: r1 → -01
    await w.append(record(3, `${DAY_B}T12:00:00.000Z`, "z".repeat(50))) // rotate: r2 → -02
    const current = `${DIR}/trace-${DAY_B}.jsonl`
    const id = (path: string): string | null => (JSON.parse((fs.files.get(path) ?? "{}").trim()) as TraceRecord).inputFingerprint
    expect(fs.files.has(`${DIR}/trace-${DAY_B}-01.jsonl`)).toBe(true)
    expect(fs.files.has(`${DIR}/trace-${DAY_B}-02.jsonl`)).toBe(true)
    expect(id(`${DIR}/trace-${DAY_B}-01.jsonl`)).toBe("fp_1")
    expect(id(`${DIR}/trace-${DAY_B}-02.jsonl`)).toBe("fp_2")
    expect(id(current)).toBe("fp_3")
  })

  test("retention prunes oldest days first; rotated index files go before the base file", async () => {
    const fs = new FakeTraceFs()
    fs.files.set(`${DIR}/trace-2026-09-26.jsonl`, "old-day")
    fs.files.set(`${DIR}/trace-2026-09-27.jsonl`, "older-recent-day")
    const w = writer(fs, 1_000_000, 2)
    await w.append(record(1, `${DAY_B}T10:00:00.000Z`))
    // Three files with a cap of 2 → exactly the oldest (26th) is evicted.
    expect(fs.unlinked).toEqual([`${DIR}/trace-2026-09-26.jsonl`])
    expect([...fs.files.keys()].sort()).toEqual([`${DIR}/trace-2026-09-27.jsonl`, `${DIR}/trace-${DAY_B}.jsonl`])
  })

  test("retention treats the rotated index file as older than the same-day base file", async () => {
    const fs = new FakeTraceFs()
    const w = writer(fs, 150, 2)
    await w.append(record(1, `${DAY_B}T10:00:00.000Z`, "x".repeat(100)))
    await w.append(record(2, `${DAY_B}T11:00:00.000Z`, "y".repeat(100))) // r1 → -01, current = r2
    // Two files exist; the next day's append must evict -01 (older), not the base.
    await w.append(record(3, `${DAY_C}T09:00:00.000Z`))
    expect(fs.files.has(`${DIR}/trace-${DAY_B}-01.jsonl`)).toBe(false)
    expect(fs.files.has(`${DIR}/trace-${DAY_B}.jsonl`)).toBe(true)
    expect(fs.files.has(`${DIR}/trace-${DAY_C}.jsonl`)).toBe(true)
  })

  test("audit files in a shared directory are never touched", async () => {
    const fs = new FakeTraceFs()
    fs.files.set(`${DIR}/audit.jsonl`, "audit-line\n")
    fs.files.set(`${DIR}/audit-1.jsonl`, "audit-line\n")
    const w = writer(fs, 150, 1)
    await w.append(record(1, `${DAY_B}T10:00:00.000Z`, "x".repeat(100)))
    await w.append(record(2, `${DAY_B}T11:00:00.000Z`, "y".repeat(100)))
    expect(fs.files.get(`${DIR}/audit.jsonl`)).toBe("audit-line\n")
    expect(fs.files.get(`${DIR}/audit-1.jsonl`)).toBe("audit-line\n")
    expect(fs.unlinked.every((path) => !path.includes("audit"))).toBe(true)
  })

  test("append failure propagates and does not kill the chain", async () => {
    const fs = new FakeTraceFs()
    const w = writer(fs, 1_000_000, 7)
    await w.append(record(1, `${DAY_B}T10:00:00.000Z`))
    fs.failAppend = true
    await expect(w.append(record(2, `${DAY_B}T11:00:00.000Z`))).rejects.toThrow("ENOSPC")
    fs.failAppend = false
    await w.append(record(3, `${DAY_B}T12:00:00.000Z`))
    const lines = (fs.files.get(`${DIR}/trace-${DAY_B}.jsonl`) ?? "").trim().split("\n")
    expect(lines.length).toBe(2)
  })

  test("concurrent appends serialize in call order", async () => {
    const fs = new FakeTraceFs()
    const w = writer(fs, 1_000_000, 7)
    await Promise.all([
      w.append(record(1, `${DAY_B}T10:00:00.000Z`)),
      w.append(record(2, `${DAY_B}T10:00:01.000Z`)),
      w.append(record(3, `${DAY_B}T10:00:02.000Z`)),
    ])
    const lines = (fs.files.get(`${DIR}/trace-${DAY_B}.jsonl`) ?? "").trim().split("\n")
    expect(lines.map((line) => (JSON.parse(line) as TraceRecord).inputFingerprint)).toEqual(["fp_1", "fp_2", "fp_3"])
  })
})
