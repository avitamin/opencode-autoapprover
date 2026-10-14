/**
 * Escalation chain (D3, docs/06): an inconclusive stage result (UNKNOWN risk,
 * invalid response, LOW confidence) is re-asked once on the next chain model;
 * conclusive verdicts, transport failures and timeouts are never escalated.
 * Budget, rate limits, audit and trace semantics of the chain are pinned here.
 */
import { describe, expect, test } from "bun:test"
import { GuardController } from "../../src/controller.js"
import { ScriptedReviewer } from "../../src/reviewer.js"
import type {
  AuditPort,
  AuditRecord,
  GuardConfig,
  ModelRef,
  ReviewerPort,
  ReviewerResult,
  ReviewInput,
  ToolSnapshot,
  TracePort,
  TraceRecord,
} from "../../src/types.js"
import { CONFORMING_LOW, TEST_ROOT, makeConfig, makeEvent, makeSnapshot, flush } from "../helpers.js"

const PRIMARY: ModelRef = { providerID: "test-provider", id: "test-model" }
const HIGH: ModelRef = { providerID: "test-provider", id: "test-model", variant: "high" }

function key(model: ModelRef): string {
  return `${model.providerID}/${model.id}/${model.variant ?? ""}`
}

const UNKNOWN_RISK = JSON.stringify({
  schemaVersion: 2,
  risk: "UNKNOWN",
  categories: ["UNKNOWN"],
  confidence: "LOW",
  signals: [],
  summary: "cannot determine the effect of this command",
})

const LOW_CONFIDENCE = JSON.stringify({
  schemaVersion: 2,
  risk: "LOW",
  categories: ["READ"],
  confidence: "LOW",
  signals: [],
  summary: "probably safe but not sure",
})

const HIGH_RISK = JSON.stringify({
  schemaVersion: 2,
  risk: "HIGH",
  categories: ["EXEC"],
  confidence: "HIGH",
  signals: ["DESTRUCTIVE"],
  summary: "destructive command",
})

class FakeAudit implements AuditPort {
  readonly records: AuditRecord[] = []
  async append(record: AuditRecord): Promise<void> {
    this.records.push(record)
  }
}

class FakeTrace implements TracePort {
  readonly records: TraceRecord[] = []
  async append(record: TraceRecord): Promise<void> {
    this.records.push(record)
  }
}

/** Reviewer that advances the injected clock before resolving, to burn hook budget deterministically. */
class ClockBurningReviewer implements ReviewerPort {
  constructor(
    private readonly burn: () => void,
    private readonly result: ReviewerResult,
  ) {}
  async assess(): Promise<ReviewerResult> {
    this.burn()
    return this.result
  }
}

/** Reviewer that never settles: the deadline/abort race must win. */
class HangingReviewer implements ReviewerPort {
  async assess(): Promise<ReviewerResult> {
    return await new Promise<ReviewerResult>(() => undefined)
  }
}

interface Harness {
  readonly controller: GuardController
  readonly audit: FakeAudit
  readonly trace: FakeTrace
  /** Chain models the controller actually asked a reviewer for, in order. */
  readonly requested: string[]
  readonly setReviewer: (model: ModelRef, reviewer: ReviewerPort | null) => void
  readonly capture: (snapshot?: Partial<ToolSnapshot>) => void
  readonly advance: (ms: number) => void
}

function escalationHarness(configOverrides: Partial<GuardConfig> = {}, withEscalation = true): Harness {
  let now = 1_000_000
  const audit = new FakeAudit()
  const trace = new FakeTrace()
  const requested: string[] = []
  const reviewers = new Map<string, ReviewerPort | null>()
  const base = makeConfig()
  const config = makeConfig({
    ...(withEscalation ? { escalation: { models: [HIGH] } } : {}),
    limits: { ...base.limits, hookDeadlineMs: 20_000 },
    ...configOverrides,
  })
  const controller = new GuardController({
    config: { status: "active", config },
    reviewerFor: (model) => {
      requested.push(key(model))
      return reviewers.get(key(model)) ?? null
    },
    audit,
    trace,
    clock: () => now,
    isoNow: () => new Date(now).toISOString(),
    env: () => ({}),
    randomUUID: () => `req-${requested.length}`,
    fingerprintSalt: "test-salt",
    guardConfigDirs: ["/home/tester/.config/opencode"],
    locationDirectory: TEST_ROOT,
  })
  return {
    controller,
    audit,
    trace,
    requested,
    setReviewer: (model, reviewer) => {
      reviewers.set(key(model), reviewer)
    },
    capture: (snapshot) => controller.captureSnapshot(makeSnapshot(snapshot)),
    advance: (ms) => {
      now += ms
    },
  }
}

describe("escalation chain triggers", () => {
  test("UNKNOWN risk on primary → escalation answers LOW → allow, attemptCount 2", async () => {
    const h = escalationHarness({ mode: "auto" })
    h.setReviewer(PRIMARY, new ScriptedReviewer([ScriptedReviewer.text(UNKNOWN_RISK)]))
    h.setReviewer(HIGH, new ScriptedReviewer([ScriptedReviewer.text(CONFORMING_LOW)]))
    h.capture()
    expect((await h.controller.handleEvaluate(makeEvent())).commit).toBe("allow")
    await flush()
    expect(h.requested).toEqual([key(PRIMARY), key(HIGH)])
    expect(h.audit.records[0]?.reasonCode).toBe("RISK_WITHIN_THRESHOLD")
    expect(h.audit.records[0]?.attemptCount).toBe(2)
    expect(h.audit.records[0]?.model).toEqual(HIGH)
    const record = h.trace.records[0]!
    expect(record.traceVersion).toBe(4)
    expect(record.escalated).toBe(true)
    expect(record.model).toEqual(HIGH)
    expect(record.attempts.length).toBe(2)
    expect(record.attempts[0]?.model).toEqual(PRIMARY)
    expect(record.attempts[0]?.assessment?.risk).toBe("UNKNOWN")
    expect(record.attempts[1]?.rawResponse).toBe(CONFORMING_LOW)
    expect(record.attempts[1]?.assessment?.risk).toBe("LOW")
    expect(record.rawResponse).toBe(CONFORMING_LOW)
  })

  test("LOW confidence on primary → escalation answers HIGH confidence → allow", async () => {
    const h = escalationHarness({ mode: "auto" })
    h.setReviewer(PRIMARY, new ScriptedReviewer([ScriptedReviewer.text(LOW_CONFIDENCE)]))
    h.setReviewer(HIGH, new ScriptedReviewer([ScriptedReviewer.text(CONFORMING_LOW)]))
    h.capture()
    expect((await h.controller.handleEvaluate(makeEvent())).commit).toBe("allow")
    await flush()
    expect(h.requested).toEqual([key(PRIMARY), key(HIGH)])
    expect(h.audit.records[0]?.attemptCount).toBe(2)
    expect(h.trace.records[0]?.attempts[0]?.assessment?.confidence).toBe("LOW")
  })

  test("invalid JSON on primary → escalation answers valid → allow", async () => {
    const h = escalationHarness({ mode: "auto" })
    h.setReviewer(PRIMARY, new ScriptedReviewer([ScriptedReviewer.text("not-json { oops")]))
    h.setReviewer(HIGH, new ScriptedReviewer([ScriptedReviewer.text(CONFORMING_LOW)]))
    h.capture()
    expect((await h.controller.handleEvaluate(makeEvent())).commit).toBe("allow")
    await flush()
    expect(h.requested).toEqual([key(PRIMARY), key(HIGH)])
    expect(h.trace.records[0]?.attempts[0]?.parseOk).toBe(false)
    expect(h.trace.records[0]?.attempts[0]?.rawResponse).toBe("not-json { oops")
  })

  test("chain exhausted (both UNKNOWN) → ask RISK_ABOVE_THRESHOLD, two calls", async () => {
    const h = escalationHarness({ mode: "auto" })
    h.setReviewer(PRIMARY, new ScriptedReviewer([ScriptedReviewer.text(UNKNOWN_RISK)]))
    h.setReviewer(HIGH, new ScriptedReviewer([ScriptedReviewer.text(UNKNOWN_RISK)]))
    h.capture()
    expect((await h.controller.handleEvaluate(makeEvent())).commit).toBe("unchanged")
    await flush()
    expect(h.requested).toEqual([key(PRIMARY), key(HIGH)])
    expect(h.audit.records[0]?.reasonCode).toBe("RISK_ABOVE_THRESHOLD")
    expect(h.audit.records[0]?.attemptCount).toBe(2)
    expect(h.audit.records[0]?.model).toEqual(HIGH)
  })

  test("conclusive HIGH risk on primary → one call, no attemptCount", async () => {
    const h = escalationHarness({ mode: "auto" })
    h.setReviewer(PRIMARY, new ScriptedReviewer([ScriptedReviewer.text(HIGH_RISK)]))
    h.setReviewer(HIGH, new ScriptedReviewer([ScriptedReviewer.text(CONFORMING_LOW)]))
    h.capture()
    expect((await h.controller.handleEvaluate(makeEvent())).commit).toBe("unchanged")
    await flush()
    expect(h.requested).toEqual([key(PRIMARY)])
    expect(h.audit.records[0]?.reasonCode).toBe("RISK_ABOVE_THRESHOLD")
    expect(h.audit.records[0]?.attemptCount).toBeUndefined()
    expect(h.trace.records[0]?.escalated).toBe(false)
    expect(h.trace.records[0]?.attempts.length).toBe(1)
  })

  test("triggers off (unknownRisk+lowConfidence) → UNKNOWN stays single-stage ask", async () => {
    const h = escalationHarness({
      mode: "auto",
      escalation: { models: [HIGH], triggerOn: { unknownRisk: false, lowConfidence: false } },
    })
    h.setReviewer(PRIMARY, new ScriptedReviewer([ScriptedReviewer.text(UNKNOWN_RISK)]))
    h.setReviewer(HIGH, new ScriptedReviewer([ScriptedReviewer.text(CONFORMING_LOW)]))
    h.capture()
    expect((await h.controller.handleEvaluate(makeEvent())).commit).toBe("unchanged")
    await flush()
    expect(h.requested).toEqual([key(PRIMARY)])
    expect(h.audit.records[0]?.reasonCode).toBe("RISK_ABOVE_THRESHOLD")
  })

  test("transport failure on primary → no escalation (infrastructure, not an unknown verdict)", async () => {
    const h = escalationHarness({ mode: "auto" })
    h.setReviewer(PRIMARY, new ScriptedReviewer([ScriptedReviewer.transport("boom")]))
    h.setReviewer(HIGH, new ScriptedReviewer([ScriptedReviewer.text(CONFORMING_LOW)]))
    h.capture()
    expect((await h.controller.handleEvaluate(makeEvent())).commit).toBe("unchanged")
    await flush()
    expect(h.requested).toEqual([key(PRIMARY)])
    expect(h.audit.records[0]?.reasonCode).toBe("PROVIDER_ERROR")
    expect(h.audit.records[0]?.attemptCount).toBeUndefined()
  })

  test("timeout on primary → abort fires, no escalation", async () => {
    const h = escalationHarness({ mode: "auto", limits: { ...makeConfig().limits, llmTimeoutMs: 30, hookDeadlineMs: 20_000 } })
    h.setReviewer(PRIMARY, new HangingReviewer())
    h.setReviewer(HIGH, new ScriptedReviewer([ScriptedReviewer.text(CONFORMING_LOW)]))
    h.capture()
    expect((await h.controller.handleEvaluate(makeEvent())).commit).toBe("unchanged")
    await flush()
    expect(h.requested).toEqual([key(PRIMARY)])
    expect(h.audit.records[0]?.reasonCode).toBe("TIMEOUT")
  })

  test("remaining hook budget below the stage minimum → escalation not started", async () => {
    const h = escalationHarness({
      mode: "auto",
      limits: { ...makeConfig().limits, llmTimeoutMs: 600, hookDeadlineMs: 1_500 },
      escalation: { models: [HIGH], timeoutMs: 500 },
    })
    h.setReviewer(PRIMARY, new ClockBurningReviewer(() => h.advance(800), ScriptedReviewer.text(UNKNOWN_RISK)))
    h.setReviewer(HIGH, new ScriptedReviewer([ScriptedReviewer.text(CONFORMING_LOW)]))
    h.capture()
    expect((await h.controller.handleEvaluate(makeEvent())).commit).toBe("unchanged")
    await flush()
    expect(h.requested).toEqual([key(PRIMARY)])
    expect(h.audit.records[0]?.reasonCode).toBe("RISK_ABOVE_THRESHOLD")
    expect(h.audit.records[0]?.attemptCount).toBeUndefined()
  })

  test("escalation model without transport → MODEL_UNAVAILABLE ask, prior attempt traced", async () => {
    const h = escalationHarness({ mode: "auto" })
    h.setReviewer(PRIMARY, new ScriptedReviewer([ScriptedReviewer.text(UNKNOWN_RISK)]))
    // HIGH deliberately not registered: reviewerFor returns null for it.
    h.capture()
    expect((await h.controller.handleEvaluate(makeEvent())).commit).toBe("unchanged")
    await flush()
    expect(h.requested).toEqual([key(PRIMARY), key(HIGH)])
    expect(h.audit.records[0]?.reasonCode).toBe("MODEL_UNAVAILABLE")
    expect(h.audit.records[0]?.attemptCount).toBeUndefined()
    expect(h.trace.records[0]?.llmCalled).toBe(true)
    expect(h.trace.records[0]?.attempts.length).toBe(1)
    expect(h.trace.records[0]?.reasonCode).toBe("MODEL_UNAVAILABLE")
  })

  test("shadow mode: escalated allow stays shadow_would_allow", async () => {
    const h = escalationHarness({ mode: "shadow" })
    h.setReviewer(PRIMARY, new ScriptedReviewer([ScriptedReviewer.text(UNKNOWN_RISK)]))
    h.setReviewer(HIGH, new ScriptedReviewer([ScriptedReviewer.text(CONFORMING_LOW)]))
    h.capture()
    expect((await h.controller.handleEvaluate(makeEvent())).commit).toBe("unchanged")
    await flush()
    expect(h.audit.records[0]?.outcome).toBe("shadow_would_allow")
    expect(h.audit.records[0]?.attemptCount).toBe(2)
    expect(h.trace.records[0]?.outcome).toBe("shadow_would_allow")
  })
})

describe("escalation chain limits", () => {
  test("rate limiting counts events, not physical calls", async () => {
    const h = escalationHarness({ mode: "auto", limits: { ...makeConfig().limits, hookDeadlineMs: 20_000, maxAssessmentsPerMinute: 2 } })
    h.setReviewer(PRIMARY, new ScriptedReviewer([ScriptedReviewer.text(UNKNOWN_RISK), ScriptedReviewer.text(UNKNOWN_RISK)]))
    h.setReviewer(HIGH, new ScriptedReviewer([ScriptedReviewer.text(CONFORMING_LOW), ScriptedReviewer.text(CONFORMING_LOW)]))
    h.capture()
    expect((await h.controller.handleEvaluate(makeEvent())).commit).toBe("allow")
    h.capture({ toolCallID: "call_2" })
    expect((await h.controller.handleEvaluate(makeEvent({ sourceToolCallID: "call_2" }))).commit).toBe("allow")
    h.capture({ toolCallID: "call_3" })
    expect((await h.controller.handleEvaluate(makeEvent({ sourceToolCallID: "call_3" }))).commit).toBe("unchanged")
    await flush()
    // Two escalated events = two stamps: the third event hit RATE_LIMIT before any reviewer call.
    expect(h.requested.length).toBe(4)
    expect(h.audit.records.some((r) => r.reasonCode === "RATE_LIMIT")).toBe(true)
  })

  test("no escalation section → single model, previous behavior intact", async () => {
    const h = escalationHarness({ mode: "auto" }, false)
    h.setReviewer(PRIMARY, new ScriptedReviewer([ScriptedReviewer.text(UNKNOWN_RISK)]))
    h.capture()
    expect((await h.controller.handleEvaluate(makeEvent())).commit).toBe("unchanged")
    await flush()
    expect(h.requested).toEqual([key(PRIMARY)])
    expect(h.audit.records[0]?.reasonCode).toBe("RISK_ABOVE_THRESHOLD")
    expect(h.audit.records[0]?.attemptCount).toBeUndefined()
  })
})
