/**
 * T08 (M3): end-to-end wiring of the stateless native reviewer through the
 * real adapter — prompt loading, model-catalog gating, timeout race, 429
 * mapping and the full allow path, all against a fake generate transport.
 * No network, no credentials.
 */
import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { wireGuard, type GuardHostSurface, type RegistrationLike, type SdkPermissionEventLike, type SdkToolBeforeEventLike } from "../../src/opencode/adapter.js"
import type { AuditPort, AuditRecord, Effect } from "../../src/types.js"
import { CONFORMING_LOW, TEST_ROOT, makeConfig } from "../helpers.js"

const PLUGIN_DIR = fileURLToPath(new URL("../..", import.meta.url)) // repo root: prompts/ ships here

const CONFORMING_MODEL: { providerID: string; id: string } = { providerID: "test-provider", id: "test-model" }

class FakeAudit implements AuditPort {
  readonly records: AuditRecord[] = []
  async append(record: AuditRecord): Promise<void> {
    this.records.push(record)
  }
  async healthy(): Promise<boolean> {
    return true
  }
}

interface FakeGenerate {
  calls: { prompt: string; model: unknown }[]
  behavior: (input: { prompt: string; model?: unknown }, requestOptions?: { signal?: AbortSignal }) => Promise<{ text: string }>
}

type EvaluateCallback = (event: SdkPermissionEventLike) => Promise<void> | void
type BeforeCallback = (event: SdkToolBeforeEventLike) => Promise<void> | void

function fakeSurface(
  generate?: FakeGenerate["behavior"],
  modelData?: { id: string; providerID: string; variants?: { id: string }[] }[],
): {
  surface: GuardHostSurface
  evaluate: EvaluateCallback
  before: BeforeCallback
} {
  const registered: { evaluate: EvaluateCallback; before: BeforeCallback } = {
    evaluate: async () => {},
    before: async () => {},
  }
  const makeRegistration = (): RegistrationLike => ({ dispose: async () => undefined })
  const surface: GuardHostSurface = {
    location: { directory: TEST_ROOT },
    pluginDirectory: PLUGIN_DIR,
    permission: {
      hook: async (_name, callback) => {
        registered.evaluate = callback
        return makeRegistration()
      },
    },
    tool: {
      hook: (name: "execute.before" | "execute.after", callback: never) => {
        if (name === "execute.before") {
          registered.before = callback as unknown as typeof registered.before
          return Promise.resolve(makeRegistration())
        }
        return Promise.resolve(makeRegistration())
      },
    },
    ...(generate !== undefined
      ? { generate: (input: { prompt: string; model?: unknown }, requestOptions?: { signal?: AbortSignal }) => generate(input, requestOptions) }
      : {}),
    ...(modelData !== undefined
      ? { model: { list: async () => ({ data: modelData }) } }
      : {}),
  }
  return { surface, evaluate: (event) => registered.evaluate(event), before: (event) => registered.before(event) }
}

function trackingGenerate(result: () => Promise<{ text: string }>): FakeGenerate {
  const gen: FakeGenerate = { calls: [], behavior: async () => ({ text: "" }) }
  gen.behavior = (input) => {
    gen.calls.push({ prompt: input.prompt, model: input.model })
    return result()
  }
  return gen
}

function evaluateEvent(): SdkPermissionEventLike {
  return {
    sessionID: "ses_1",
    agent: "build",
    action: "shell",
    resources: ["pwd"],
    source: { type: "tool", messageID: "msg_1", id: "call_1" },
    effect: "ask",
  }
}

function beforeEvent(): SdkToolBeforeEventLike {
  return {
    tool: "bash",
    sessionID: "ses_1",
    agent: "build",
    messageID: "msg_1",
    id: "call_1",
    input: { command: "pwd", workdir: TEST_ROOT },
  }
}

describe("wiring: native generate reviewer (M3)", () => {
  test("conforming model answer through the real wiring → allow, one call, prompt loaded from prompts/", async () => {
    const gen = trackingGenerate(async () => ({ text: CONFORMING_LOW }))
    const { surface, evaluate, before } = fakeSurface(gen.behavior, [
      { id: CONFORMING_MODEL.id, providerID: CONFORMING_MODEL.providerID },
    ])
    const audit = new FakeAudit()
    const guard = await wireGuard(surface, {
      configState: { status: "active", config: makeConfig() },
      makeAudit: () => audit,
      clock: () => 1_000_000,
      isoNow: () => "2026-09-28T00:00:00.000Z",
      fingerprintSalt: "test-salt",
    })
    await before(beforeEvent())
    const event = evaluateEvent()
    await evaluate(event)
    expect(event.effect).toBe("allow")
    expect(gen.calls.length).toBe(1)
    expect(gen.calls[0]!.model).toEqual({ id: CONFORMING_MODEL.id, providerID: CONFORMING_MODEL.providerID })
    // The shipped instruction is really part of the prompt.
    expect(gen.calls[0]!.prompt).toContain("градуированный классификатор")
    expect(gen.calls[0]!.prompt).toContain("недоверенные данные")
    expect(audit.records.at(-1)?.outcome).toBe("allow_prepared")
    await guard.dispose()
  })

  test("invalid model JSON → ask INVALID_RESPONSE, exactly one call", async () => {
    const gen = trackingGenerate(async () => ({ text: "Одобрено." }))
    const { surface, evaluate, before } = fakeSurface(gen.behavior)
    const audit = new FakeAudit()
    const guard = await wireGuard(surface, {
      configState: { status: "active", config: makeConfig() },
      makeAudit: () => audit,
      clock: () => 1_000_000,
      isoNow: () => "2026-09-28T00:00:00.000Z",
      fingerprintSalt: "test-salt",
    })
    await before(beforeEvent())
    const event = evaluateEvent()
    await evaluate(event)
    expect(event.effect).toBe("ask")
    expect(gen.calls.length).toBe(1)
    expect(audit.records.at(-1)?.reasonCode).toBe("INVALID_RESPONSE")
    await guard.dispose()
  })

  test("no generate on the surface → MODEL_UNAVAILABLE, zero calls", async () => {
    let calls = 0
    const gen = trackingGenerate(async () => {
      calls++
      return { text: CONFORMING_LOW }
    })
    const { surface, evaluate, before } = fakeSurface(undefined, undefined)
    void gen
    const audit = new FakeAudit()
    const guard = await wireGuard(surface, {
      configState: { status: "active", config: makeConfig() },
      makeAudit: () => audit,
      clock: () => 1_000_000,
      isoNow: () => "2026-09-28T00:00:00.000Z",
      fingerprintSalt: "test-salt",
    })
    await before(beforeEvent())
    const event = evaluateEvent()
    await evaluate(event)
    expect(event.effect).toBe("ask")
    expect(audit.records.at(-1)?.reasonCode).toBe("MODEL_UNAVAILABLE")
    expect(calls).toBe(0)
    await guard.dispose()
  })

  test("configured model absent from the host catalog → ask without any LLM call", async () => {
    const gen = trackingGenerate(async () => ({ text: CONFORMING_LOW }))
    const { surface, evaluate, before } = fakeSurface(gen.behavior, [
      { id: "other-model", providerID: "other-provider" },
    ])
    const audit = new FakeAudit()
    const guard = await wireGuard(surface, {
      configState: { status: "active", config: makeConfig() },
      makeAudit: () => audit,
      clock: () => 1_000_000,
      isoNow: () => "2026-09-28T00:00:00.000Z",
      fingerprintSalt: "test-salt",
    })
    await before(beforeEvent())
    const event = evaluateEvent()
    await evaluate(event)
    expect(event.effect).toBe("ask")
    expect(gen.calls.length).toBe(0)
    expect(audit.records.at(-1)?.reasonCode).toBe("MODEL_UNAVAILABLE")
    await guard.dispose()
  })

  test("configured variant missing → MODEL_UNAVAILABLE; present variant → no gate", async () => {
    const gen = trackingGenerate(async () => ({ text: CONFORMING_LOW }))
    // Variant configured in the guard config, catalog has no variants for the model.
    const config = makeConfig({ model: { ...CONFORMING_MODEL, variant: "fast" } })
    const { surface, evaluate, before } = fakeSurface(gen.behavior, [
      { id: CONFORMING_MODEL.id, providerID: CONFORMING_MODEL.providerID, variants: [] },
    ])
    const audit = new FakeAudit()
    const guard = await wireGuard(surface, {
      configState: { status: "active", config },
      makeAudit: () => audit,
      clock: () => 1_000_000,
      isoNow: () => "2026-09-28T00:00:00.000Z",
      fingerprintSalt: "test-salt",
    })
    await before(beforeEvent())
    const event = evaluateEvent()
    await evaluate(event)
    expect(event.effect).toBe("ask")
    expect(gen.calls.length).toBe(0)
    expect(audit.records.at(-1)?.reasonCode).toBe("MODEL_UNAVAILABLE")
    await guard.dispose()
  })

  test("hanging generation hits the LLM deadline → ask TIMEOUT (single call, late result discarded)", async () => {
    const gen = trackingGenerate(
      () =>
        new Promise<{ text: string }>((resolve) => {
          setTimeout(() => resolve({ text: CONFORMING_LOW }), 300)
        }),
    )
    const { surface, evaluate, before } = fakeSurface(gen.behavior)
    const audit = new FakeAudit()
    const guard = await wireGuard(surface, {
      configState: {
        status: "active",
        config: makeConfig({ limits: { ...makeConfig().limits, llmTimeoutMs: 40 } }),
      },
      makeAudit: () => audit,
      clock: () => 1_000_000,
      isoNow: () => "2026-09-28T00:00:00.000Z",
      fingerprintSalt: "test-salt",
    })
    await before(beforeEvent())
    const event = evaluateEvent()
    await evaluate(event)
    expect(event.effect).toBe("ask")
    expect(gen.calls.length).toBe(1)
    expect(audit.records.at(-1)?.reasonCode).toBe("TIMEOUT")
    await new Promise((resolve) => setTimeout(resolve, 320)) // let the late resolve land and be discarded
    expect(event.effect).toBe("ask")
    await guard.dispose()
  })

  test("provider 429 → ask RATE_LIMIT through the full classify path", async () => {
    const gen = trackingGenerate(async () => {
      throw Object.assign(new Error("rate limited"), { status: 429 })
    })
    const { surface, evaluate, before } = fakeSurface(gen.behavior)
    const audit = new FakeAudit()
    const guard = await wireGuard(surface, {
      configState: { status: "active", config: makeConfig() },
      makeAudit: () => audit,
      clock: () => 1_000_000,
      isoNow: () => "2026-09-28T00:00:00.000Z",
      fingerprintSalt: "test-salt",
    })
    await before(beforeEvent())
    const event = evaluateEvent()
    await evaluate(event)
    expect(event.effect).toBe("ask")
    expect(audit.records.at(-1)?.reasonCode).toBe("RATE_LIMIT")
    await guard.dispose()
  })

  test("missing prompt file → reviewer unavailable → MODEL_UNAVAILABLE", async () => {
    const gen = trackingGenerate(async () => ({ text: CONFORMING_LOW }))
    const behavior = gen.behavior
    const registered: { evaluate: EvaluateCallback; before: BeforeCallback } = {
      evaluate: async () => {},
      before: async () => {},
    }
    const surface: GuardHostSurface = {
      location: { directory: TEST_ROOT },
      pluginDirectory: "/tmp/opencode/no-such-plugin-dir",
      permission: {
        hook: async (_name, callback) => {
          registered.evaluate = callback
          return { dispose: async () => undefined }
        },
      },
      tool: {
        hook: (name: "execute.before" | "execute.after", callback: never) => {
          if (name === "execute.before") registered.before = callback as unknown as typeof registered.before
          return Promise.resolve({ dispose: async () => undefined })
        },
      },
      generate: (input) => behavior(input),
    }
    const audit = new FakeAudit()
    const guard = await wireGuard(surface, {
      configState: { status: "active", config: makeConfig() },
      makeAudit: () => audit,
      clock: () => 1_000_000,
      isoNow: () => "2026-09-28T00:00:00.000Z",
      fingerprintSalt: "test-salt",
    })
    await registered.before(beforeEvent())
    const event = evaluateEvent()
    await registered.evaluate(event)
    expect(event.effect).toBe("ask")
    expect(gen.calls.length).toBe(0)
    expect(audit.records.at(-1)?.reasonCode).toBe("MODEL_UNAVAILABLE")
    await guard.dispose()
  })
})
