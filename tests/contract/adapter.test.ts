import { describe, expect, test } from "bun:test"
import { toPermissionEventView, toToolSnapshot, wireGuard, type GuardHostSurface, type RegistrationLike, type SdkPermissionEventLike, type SdkToolBeforeEventLike } from "../../src/opencode/adapter.js"
import { ScriptedReviewer } from "../../src/reviewer.js"
import type { AuditPort, AuditRecord, Effect } from "../../src/types.js"
import { CONFORMING_LOW, TEST_ROOT, makeConfig } from "../helpers.js"

class FakeAudit implements AuditPort {
  readonly records: AuditRecord[] = []
  async append(record: AuditRecord): Promise<void> {
    this.records.push(record)
  }
}

interface Registered {
  evaluate: (event: SdkPermissionEventLike) => Promise<void>
  before: (event: SdkToolBeforeEventLike) => Promise<void>
  after: (event: { tool: string; id: string }) => Promise<void>
  disposed: string[]
}

function fakeSurface(): { surface: GuardHostSurface; state: Registered } {
  const state: Registered = {
    evaluate: async () => {},
    before: async () => {},
    after: async () => {},
    disposed: [],
  }
  const makeRegistration = (name: string): RegistrationLike => ({
    dispose: async () => {
      state.disposed.push(name)
    },
  })
  const surface: GuardHostSurface = {
    location: { directory: TEST_ROOT },
    permission: {
      hook: async (_name, callback) => {
        state.evaluate = callback as Registered["evaluate"]
        return makeRegistration("evaluate")
      },
    },
    tool: {
      hook: (name: "execute.before" | "execute.after", callback: never) => {
        if (name === "execute.before") {
          state.before = callback as unknown as Registered["before"]
          return Promise.resolve(makeRegistration("before"))
        }
        state.after = callback as unknown as Registered["after"]
        return Promise.resolve(makeRegistration("after"))
      },
    },
  }
  return { surface, state }
}

async function wired(overrides: Parameters<typeof wireGuard>[1] = {}) {
  const { surface, state } = fakeSurface()
  const audit = new FakeAudit()
  const reviewer = new ScriptedReviewer([ScriptedReviewer.text(CONFORMING_LOW)])
  const guard = await wireGuard(surface, {
    configState: { status: "active", config: makeConfig() },
    makeAudit: () => audit,
    makeReviewer: () => reviewer,
    clock: () => 1_000_000,
    isoNow: () => "2026-09-28T00:00:00.000Z",
    fingerprintSalt: "test-salt",
    ...overrides,
  })
  return { guard, state, audit, reviewer, surface }
}

function sdkEvaluateEvent(overrides: { [K in keyof SdkPermissionEventLike]?: SdkPermissionEventLike[K] | undefined } = {}): SdkPermissionEventLike {
  const event: SdkPermissionEventLike = {
    sessionID: "ses_1",
    agent: "build",
    action: "shell",
    resources: ["pwd"],
    source: { type: "tool", messageID: "msg_1", id: "call_1" },
    effect: "ask",
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete event[key as keyof SdkPermissionEventLike]
    } else {
      ;(event as unknown as Record<string, unknown>)[key] = value
    }
  }
  return event
}

function sdkBeforeEvent(overrides: Partial<SdkToolBeforeEventLike> = {}): SdkToolBeforeEventLike {
  return {
    tool: "shell",
    sessionID: "ses_1",
    agent: "build",
    messageID: "msg_1",
    id: "call_1",
    input: { command: "pwd", workdir: TEST_ROOT },
    ...overrides,
  }
}

describe("pure SDK mappers", () => {
  test("toPermissionEventView keeps source correlation ids", () => {
    const view = toPermissionEventView(sdkEvaluateEvent())
    expect(view.sourceToolCallID).toBe("call_1")
    expect(view.sourceMessageID).toBe("msg_1")
    expect(view.effect).toBe("ask")
  })

  test("source without tool type loses correlation (later INPUT_UNBOUND)", () => {
    const view = toPermissionEventView(sdkEvaluateEvent({ source: undefined }))
    expect(view.sourceToolCallID).toBeNull()
  })

  test("toToolSnapshot keeps the full compound command and flags unknown keys", () => {
    const snap = toToolSnapshot(sdkBeforeEvent({ input: { command: "cd . && printf probe_cd" } }), 5)
    expect(snap?.command).toBe("cd . && printf probe_cd")
    expect(snap?.workdir).toBeNull()
    const tainted = toToolSnapshot(sdkBeforeEvent({ input: { command: "ls", env: { X: "1" } } }), 5)
    expect(tainted?.extraInputKeys).toEqual(["env"])
    expect(toToolSnapshot(sdkBeforeEvent({ input: "not-an-object" }), 5)).toBeNull()
    expect(toToolSnapshot(sdkBeforeEvent({ input: { workdir: "/tmp" } }), 5)).toBeNull()
  })
})

describe("wired guard end-to-end on the fake host surface", () => {
  test("ask + bound input + conforming assessment → event effect mutated to allow", async () => {
    const w = await wired()
    await w.state.before(sdkBeforeEvent())
    const event = sdkEvaluateEvent()
    await w.state.evaluate(event)
    expect(event.effect).toBe("allow")
    expect(event.message).toContain("opencode-llm-approval")
    expect(w.reviewer.callCount).toBe(1)
  })

  test("native allow passes through untouched", async () => {
    const w = await wired()
    await w.state.before(sdkBeforeEvent())
    const event = sdkEvaluateEvent({ effect: "allow" })
    await w.state.evaluate(event)
    expect(event.effect).toBe("allow")
    expect(w.reviewer.callCount).toBe(0)
  })

  test("native deny passes through untouched even with a bound snapshot", async () => {
    const w = await wired()
    await w.state.before(sdkBeforeEvent())
    const event = sdkEvaluateEvent({ effect: "deny" })
    await w.state.evaluate(event)
    expect(event.effect).toBe("deny")
    expect(w.reviewer.callCount).toBe(0)
  })

  test("ask without captured tool input → unchanged ask (no full command, no LLM)", async () => {
    const w = await wired()
    const event = sdkEvaluateEvent()
    await w.state.evaluate(event)
    expect(event.effect).toBe("ask")
    expect(w.reviewer.callCount).toBe(0)
  })

  test("compound command with lost cd resource is still assessed as a whole", async () => {
    const w = await wired()
    await w.state.before(sdkBeforeEvent({ input: { command: "cd . && printf probe_cd", workdir: TEST_ROOT } }))
    const event = sdkEvaluateEvent({ resources: ["printf probe_cd"] })
    await w.state.evaluate(event)
    expect(event.effect).toBe("allow")
    expect(w.reviewer.calls[0]?.command).toBe("cd . && printf probe_cd")
  })

  test("execute.after releases the snapshot: repeated evaluate → DUPLICATE_EVENT/ask", async () => {
    const w = await wired()
    await w.state.before(sdkBeforeEvent())
    await w.state.after({ tool: "shell", id: "call_1" })
    const event = sdkEvaluateEvent()
    await w.state.evaluate(event)
    expect(event.effect).toBe("ask")
    expect(w.reviewer.callCount).toBe(0)
  })

  test("shadow mode never mutates the event", async () => {
    const w = await wired({ configState: { status: "active", config: makeConfig({ mode: "shadow" }) } })
    await w.state.before(sdkBeforeEvent())
    const event = sdkEvaluateEvent()
    await w.state.evaluate(event)
    expect(event.effect).toBe("ask")
    expect(w.reviewer.callCount).toBe(1)
  })

  test("kill switch via env → ask without LLM", async () => {
    const previous = process.env.OPENCODE_LLM_APPROVAL_DISABLE
    process.env.OPENCODE_LLM_APPROVAL_DISABLE = "1"
    try {
      const w = await wired()
      await w.state.before(sdkBeforeEvent())
      const event = sdkEvaluateEvent()
      await w.state.evaluate(event)
      expect(event.effect).toBe("ask")
      expect(w.reviewer.callCount).toBe(0)
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_LLM_APPROVAL_DISABLE
      else process.env.OPENCODE_LLM_APPROVAL_DISABLE = previous
    }
  })

  test("dispose unloads the controller and disposes every registration", async () => {
    const w = await wired()
    await w.guard.dispose()
    expect(w.state.disposed.sort()).toEqual(["after", "before", "evaluate"])
    // After unload a new event cannot be allowed anymore.
    await w.state.before(sdkBeforeEvent({ id: "call_2", input: { command: "pwd" } }))
    const event = sdkEvaluateEvent({ source: { type: "tool", messageID: "msg_2", id: "call_2" } })
    await w.state.evaluate(event)
    expect(event.effect).toBe("ask")
  })

  test("inactive config leaves the host untouched", async () => {
    const w = await wired({ configState: { status: "inactive", reason: "CONFIG_INVALID", detail: "test" } })
    await w.state.before(sdkBeforeEvent())
    const event = sdkEvaluateEvent()
    await w.state.evaluate(event)
    expect(event.effect).toBe("ask")
    expect(w.reviewer.callCount).toBe(0)
  })

  test("effect type after commit is exactly the allow literal", async () => {
    const w = await wired()
    await w.state.before(sdkBeforeEvent())
    const event = sdkEvaluateEvent()
    await w.state.evaluate(event)
    const effects: Effect[] = ["allow", "ask", "deny"]
    expect(effects).toContain(event.effect)
    expect(event.effect).toBe("allow")
  })
})
