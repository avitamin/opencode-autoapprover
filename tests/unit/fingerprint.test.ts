/**
 * Snapshot binding fingerprint (D5, docs/03): the digest must cover the
 * COMPLETE captured input — correlation ids, full command, workdir and every
 * documented envelope value — so whitelisted envelope keys stay bound.
 */
import { describe, expect, test } from "bun:test"
import { snapshotFingerprint } from "../../src/controller.js"
import type { ToolSnapshot } from "../../src/types.js"

function snapshot(overrides: Partial<ToolSnapshot> = {}): ToolSnapshot {
  return {
    toolCallID: "call_1",
    sessionID: "ses_1",
    messageID: "msg_1",
    agent: "build",
    command: "bun run check",
    workdir: "/tmp/opencode/guard-test-root",
    envelope: {},
    extraInputKeys: [],
    capturedAt: 1_000_000,
    ...overrides,
  }
}

describe("snapshotFingerprint", () => {
  test("envelope values participate in the binding digest", () => {
    const base = snapshotFingerprint(snapshot({ envelope: { timeout: 120_000 } }), "salt")
    const changed = snapshotFingerprint(snapshot({ envelope: { timeout: 300_000 } }), "salt")
    const flipped = snapshotFingerprint(snapshot({ envelope: { timeout: 120_000, background: true } }), "salt")
    const empty = snapshotFingerprint(snapshot(), "salt")
    expect(base).not.toBe(changed)
    expect(base).not.toBe(flipped)
    expect(base).not.toBe(empty)
  })

  test("envelope key order does not change the digest", () => {
    const first = snapshotFingerprint(snapshot({ envelope: { timeout: 1, background: true } }), "salt")
    const second = snapshotFingerprint(snapshot({ envelope: { background: true, timeout: 1 } }), "salt")
    expect(first).toBe(second)
  })

  test("salt and command changes change the digest", () => {
    const a = snapshotFingerprint(snapshot(), "salt-a")
    const b = snapshotFingerprint(snapshot(), "salt-b")
    const c = snapshotFingerprint(snapshot({ command: "bun run check 2>&1" }), "salt-a")
    expect(a).not.toBe(b)
    expect(a).not.toBe(c)
    expect(a).toHaveLength(64)
  })
})
