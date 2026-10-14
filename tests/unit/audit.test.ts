/**
 * T09 (M3): FileAuditWriter — serialized appends, size-based rotation with a
 * retention cap, append-failure propagation with a live chain, and the
 * pre-classification health probe. Pure in-memory fs fakes, no disk.
 */
import { describe, expect, test } from "bun:test"
import { FileAuditWriter, type AuditFsDeps } from "../../src/audit.js"
import type { AuditRecord } from "../../src/types.js"

let seq = 0
function record(id?: number): AuditRecord {
  const n = id ?? ++seq
  return {
    schemaVersion: 2,
    timestamp: "2026-09-28T00:00:00.000Z",
    requestID: `req_${n}`,
    inputFingerprint: "fp",
    mode: "auto",
    outcome: "allow_prepared",
    reasonCode: "RISK_WITHIN_THRESHOLD",
    model: { providerID: "p", id: "m" },
    latencyMs: 5,
    policyVersion: "graduated-v1",
  }
}

class FakeFs implements AuditFsDeps {
  readonly files = new Map<string, string>()
  mkdirCalls = 0
  failMkdir = false
  failAppend = false
  failWritable = false
  readonly renames: string[][] = []

  async mkdir(): Promise<void> {
    this.mkdirCalls++
    if (this.failMkdir) throw new Error("EACCES: permission denied")
  }
  async statSize(path: string): Promise<number | null> {
    const content = this.files.get(path)
    return content === undefined ? null : content.length
  }
  async appendFile(path: string, data: string): Promise<void> {
    if (this.failAppend) throw new Error("ENOSPC: no space left")
    this.files.set(path, (this.files.get(path) ?? "") + data)
  }
  async rename(from: string, to: string): Promise<void> {
    this.renames.push([from, to])
    const content = this.files.get(from)
    if (content === undefined) return
    this.files.set(to, content)
    this.files.delete(from)
  }
  async unlink(path: string): Promise<void> {
    this.files.delete(path)
  }
  async checkWritable(): Promise<void> {
    if (this.failWritable) throw new Error("EACCES: permission denied")
  }
}

const DIR = "/audit"
const CURRENT = `${DIR}/audit.jsonl`

function writer(fs: FakeFs, maxFileBytes: number, retainedFiles: number): FileAuditWriter {
  return new FileAuditWriter(DIR, maxFileBytes, retainedFiles, fs)
}

describe("FileAuditWriter", () => {
  test("append writes one parseable JSONL line per record", async () => {
    const fs = new FakeFs()
    const w = writer(fs, 1_000_000, 3)
    await w.append(record())
    const content = fs.files.get(CURRENT)!
    expect(content.endsWith("\n")).toBe(true)
    const parsed = JSON.parse(content.trim()) as AuditRecord
    expect(parsed.requestID).toBe("req_1")
    expect(parsed.outcome).toBe("allow_prepared")
  })

  test("concurrent appends serialize in call order", async () => {
    const fs = new FakeFs()
    const w = writer(fs, 1_000_000, 3)
    await Promise.all([w.append(record(1)), w.append(record(2)), w.append(record(3))])
    const lines = (fs.files.get(CURRENT) ?? "").trim().split("\n")
    expect(lines.length).toBe(3)
    const ids = lines.map((line) => (JSON.parse(line) as AuditRecord).requestID)
    expect(ids).toEqual(["req_1", "req_2", "req_3"])
  })

  test("size-based rotation keeps current + retainedFiles-1 rotated files", async () => {
    const fs = new FakeFs()
    // ~150-char records; rotate whenever the file would exceed 300 bytes.
    const w = writer(fs, 300, 3)
    await w.append(record(1)) // current = r1
    await w.append(record(2)) // rotate: r1 → audit-1; current = r2
    await w.append(record(3)) // rotate: r2 → audit-1, r1 → audit-2; current = r3
    await w.append(record(4)) // rotate: r3 → audit-1, r2 → audit-2 (r1 overwritten); current = r4
    const names = [...fs.files.keys()].sort()
    expect(names).toEqual([`${DIR}/audit-1.jsonl`, `${DIR}/audit-2.jsonl`, CURRENT])
    const id = (path: string): string => (JSON.parse((fs.files.get(path) ?? "{}").trim()) as AuditRecord).requestID
    expect(id(CURRENT)).toBe("req_4")
    expect(id(`${DIR}/audit-1.jsonl`)).toBe("req_3")
    expect(id(`${DIR}/audit-2.jsonl`)).toBe("req_2") // req_1 fell off the retention cap
  })

  test("append failure propagates and does not kill the chain", async () => {
    const fs = new FakeFs()
    const w = writer(fs, 1_000_000, 3)
    await w.append(record()) // ok
    fs.failAppend = true
    await expect(w.append(record())).rejects.toThrow("ENOSPC")
    fs.failAppend = false
    await w.append(record()) // chain still alive after the rejection
    const lines = (fs.files.get(CURRENT) ?? "").trim().split("\n")
    expect(lines.length).toBe(2)
  })

  test("rotation failure propagates to the caller", async () => {
    const fs = new FakeFs()
    // statSize always reports full → every second append rotates; break rename.
    const w = writer(fs, 1, 3)
    await w.append(record())
    fs.rename = async () => {
      throw new Error("EXDEV: cross-device link")
    }
    await expect(w.append(record())).rejects.toThrow("EXDEV")
  })

  test("healthy(): false when the directory cannot be created, true when writable", async () => {
    const fs = new FakeFs()
    fs.failMkdir = true
    const broken = writer(fs, 100, 3)
    expect(await broken.healthy()).toBe(false)
    fs.failMkdir = false
    fs.failWritable = true
    const unwritable = writer(fs, 100, 3)
    expect(await unwritable.healthy()).toBe(false)
    fs.failWritable = false
    const ok = writer(fs, 100, 3)
    expect(await ok.healthy()).toBe(true)
  })

  test("healthy() caches directory creation across calls", async () => {
    const fs = new FakeFs()
    const w = writer(fs, 100, 3)
    await w.healthy()
    await w.healthy()
    await w.append(record())
    expect(fs.mkdirCalls).toBe(1)
  })
})
