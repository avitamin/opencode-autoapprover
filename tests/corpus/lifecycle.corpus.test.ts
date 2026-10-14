/**
 * Corpus: tests/fixtures/lifecycle.jsonl (docs/07, docs/08).
 * Each scenario drives the real GuardController on a fake audit + scripted
 * reviewer. Timed fixtures are scaled ×1/100 (7000→70ms etc.) preserving the
 * relations; deterministic interventions use hooks instead of sleeps.
 * `expectedEffects` maps request order; `expectedLlmCalls` counts only the
 * scenario itself, never the setup prefill (fixtures/README).
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { GuardController } from "../../src/controller.js"
import type {
  AdapterDirective,
  AuditPort,
  AuditRecord,
  GuardConfig,
  GuardConfigState,
  PermissionEventView,
  ReviewerPort,
  ReviewerResult,
  ToolSnapshot,
} from "../../src/types.js"

const ROOT = "/workspace/project"
const GUARD_CONFIG_DIRS = ["/home/example/.config/opencode-llm-approval", "/home/example/.config/opencode"]
const CONFORMING_RAW = JSON.stringify({
  schemaVersion: 2,
  risk: "LOW",
  categories: ["READ"],
  confidence: "HIGH",
  signals: [],
  summary: "Ограниченное чтение обычного файла.",
})

interface LifeFixture {
  readonly id: string
  readonly scenario: string
  readonly setup: Record<string, unknown>
  readonly expectedEffects: string[]
  readonly expectedLlmCalls: number
  readonly assertion: string
}

function loadFixtures(): LifeFixture[] {
  const text = readFileSync("tests/fixtures/lifecycle.jsonl", "utf8") as string
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as LifeFixture)
}

function loadCommand(id: string): string {
  const text = readFileSync("tests/fixtures/commands.jsonl", "utf8") as string
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue
    const parsed = JSON.parse(line) as { id: string; command: string }
    if (parsed.id === id) return parsed.command
  }
  throw new Error(`command fixture ${id} not found`)
}

function loadRaw(id: string): string {
  const text = readFileSync("tests/fixtures/assessments.jsonl", "utf8") as string
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue
    const parsed = JSON.parse(line) as { id: string; raw?: string }
    if (parsed.id === id) {
      if (parsed.raw === undefined) throw new Error(`assessment ${id} has no raw`)
      return parsed.raw
    }
  }
  throw new Error(`assessment fixture ${id} not found`)
}

function synthAssessment(risk: string, category: string, confidence: string): string {
  return JSON.stringify({ schemaVersion: 2, risk, categories: [category], confidence, signals: [], summary: "синтез" })
}

function modelResultRaw(token: unknown): string {
  if (typeof token !== "string") return CONFORMING_RAW
  if (token.startsWith("R")) return loadRaw(token)
  if (token === "valid_UNKNOWN_with_terminal_escape_in_summary") {
    return JSON.stringify({
      schemaVersion: 2,
      risk: "UNKNOWN",
      categories: ["UNKNOWN"],
      confidence: "LOW",
      signals: [],
      summary: "ок\u001b[2Jочищено",
    })
  }
  const parts = token.split("_")
  return synthAssessment(parts[0]!, parts[1]!, parts[2]!)
}

/** Reviewer with per-call manual control; records every call. */
class DeferredReviewer implements ReviewerPort {
  readonly inputs: unknown[] = []
  private readonly resolvers: Array<((value: ReviewerResult) => void) | undefined> = []
  private readonly used = new Set<number>()
  private readonly queue: ReviewerResult[] = []

  async assess(input: unknown): Promise<ReviewerResult> {
    this.inputs.push(input)
    const queued = this.queue.shift()
    if (queued !== undefined) return queued
    return await new Promise<ReviewerResult>((resolve) => this.resolvers.push(resolve))
  }

  /** Number of calls still awaiting a manual resolution. */
  get pending(): number {
    return this.resolvers.filter((resolver) => resolver !== undefined).length
  }

  /** Resolve the pending call started at the given request index (stable slots). */
  resolveAt(index: number, value: ReviewerResult): void {
    const resolver = this.resolvers[index]
    if (resolver === undefined || this.used.has(index)) {
      throw new Error(`no pending reviewer call at index ${index}`)
    }
    this.used.add(index)
    this.resolvers[index] = undefined
    resolver(value)
  }

  /** Resolve the oldest still-pending call (FIFO). */
  resolveNext(value: ReviewerResult): void {
    const index = this.resolvers.findIndex((resolver) => resolver !== undefined)
    if (index === -1) throw new Error("no pending reviewer call")
    this.resolveAt(index, value)
  }

  /** Resolve everything still pending (cleanup only). */
  resolveAll(value: ReviewerResult): void {
    for (let index = 0; index < this.resolvers.length; index++) {
      if (this.resolvers[index] !== undefined) this.resolveAt(index, value)
    }
  }

  queueResult(value: ReviewerResult): void {
    this.queue.push(value)
  }

  static text(text: string): ReviewerResult {
    return { ok: true, text }
  }

  static transport(code: string): ReviewerResult {
    return { kind: "transport", message: `provider error ${code}`, code }
  }
}

class ScenarioAudit implements AuditPort {
  readonly records: AuditRecord[] = []
  failAppends = false
  healthyResult: boolean | null = null
  onAppend: (() => void) | null = null
  async append(record: AuditRecord): Promise<void> {
    this.onAppend?.()
    if (this.failAppends) throw new Error("audit sink is broken")
    this.records.push(record)
  }
  async healthy(): Promise<boolean> {
    return this.healthyResult ?? true
  }
}

function baselineConfig(overrides: Partial<GuardConfig> = {}): GuardConfig {
  return {
    schemaVersion: 2,
    mode: "auto",
    model: { providerID: "test-provider", id: "test-model" },
    policy: {
      autoAllow: { maxRisk: "LOW", minConfidence: "HIGH", allowedCategories: ["READ"] },
      workspaceRoots: [ROOT],
      alwaysAskPathPrefixes: ["secrets", "credentials", "production"],
    },
    privacy: { allowCommandTransmission: true, destinationReview: "lifecycle baseline" },
    limits: {
      hookDeadlineMs: 8000,
      llmTimeoutMs: 6500,
      maxInFlight: 2,
      maxAssessmentsPerMinute: 20,
      maxCommandBytes: 4096,
      maxResources: 8,
      maxPayloadBytes: 8192,
      maxResponseBytes: 8192,
    },
    audit: { directory: "/workspace/audit", maxFileBytes: 5242880, retainedFiles: 3 },
    ...overrides,
  }
}

function snapshotFor(id: string, command: string, overrides: Partial<ToolSnapshot> = {}): ToolSnapshot {
  return {
    toolCallID: `call_${id}`,
    sessionID: "ses_life",
    messageID: `msg_${id}`,
    agent: "build",
    command,
    workdir: ROOT,
    extraInputKeys: [],
    capturedAt: 1_000_000,
    ...overrides,
  }
}

function eventFor(id: string, command: string, overrides: Partial<PermissionEventView> = {}): PermissionEventView {
  return {
    sessionID: "ses_life",
    agent: "build",
    action: "shell",
    resources: [command],
    effect: "ask",
    message: null,
    sourceToolCallID: `call_${id}`,
    sourceMessageID: `msg_${id}`,
    ...overrides,
  }
}

function effectOf(directive: AdapterDirective, incoming: string): string {
  return directive.commit === "allow" ? "allow" : incoming
}

describe("corpus: lifecycle.jsonl", () => {
  const fixtures = loadFixtures()

  test("corpus is loaded completely", () => {
    expect(fixtures.length).toBe(54)
  })

  for (const fixture of fixtures) {
    test(`${fixture.id} ${fixture.scenario} → ${JSON.stringify(fixture.expectedEffects)}, llm=${fixture.expectedLlmCalls}`, async () => {
      const setup = fixture.setup
      const str = (key: string): string | undefined => (typeof setup[key] === "string" ? (setup[key] as string) : undefined)
      const bool = (key: string): boolean | undefined => (typeof setup[key] === "boolean" ? (setup[key] as boolean) : undefined)
      const num = (key: string): number | undefined => (typeof setup[key] === "number" ? (setup[key] as number) : undefined)

      const mode = (str("mode") ?? "auto") as GuardConfig["mode"]
      const incomingEffect = str("incomingEffect") ?? "ask"
      const action = str("action") ?? "shell"
      const autoAllow = (setup.autoAllow ?? undefined) as GuardConfig["policy"]["autoAllow"] | undefined

      // Time scaling: fixtures express ms in production scale; tests run ×1/100.
      const scale = 1 / 100
      const llmTimeoutMs = Math.round((num("llmTimeoutMs") ?? 6500) * scale)
      const delayMs = num("delayMs") !== undefined ? Math.round(num("delayMs")! * scale) : undefined

      let now = 1_000_000
      const clock = () => now
      let env: Record<string, string | undefined> = {}
      const audit = new ScenarioAudit()

      let config: GuardConfig = baselineConfig({
        mode,
        limits: { ...baselineConfig().limits, llmTimeoutMs },
        ...(autoAllow !== undefined
          ? { policy: { autoAllow, workspaceRoots: [ROOT], alwaysAskPathPrefixes: ["secrets", "credentials", "production"] } }
          : {}),
      })
      if (str("privacyConsent") === "false" || bool("privacyConsent") === false) {
        config = { ...config, privacy: { ...config.privacy, allowCommandTransmission: false } }
      }

      let configState: GuardConfigState = { status: "active", config }
      if (str("config") !== undefined || str("auditDirectory") === "symlink") {
        configState = { status: "inactive", reason: "CONFIG_INVALID", detail: `fixture ${fixture.id}` }
      }

      const reviewer = new DeferredReviewer()
      const useReviewer: ReviewerPort | null =
        bool("apiKeyAbsent") === true || bool("liveOptIn") === false ? null : reviewer

      if (str("auditDirectory") === "unwritable") audit.healthyResult = false
      if (str("auditAppend") === "error") audit.failAppends = true

      const controller = new GuardController({
        config: configState,
        reviewerFor: () => useReviewer,
        audit,
        clock,
        isoNow: () => "2026-09-28T00:00:00.000Z",
        env: () => env,
        randomUUID: () => `req-${fixture.id}`,
        fingerprintSalt: "corpus",
        guardConfigDirs: GUARD_CONFIG_DIRS,
        locationDirectory: ROOT,
        platformQualified: str("platform") !== "unqualified",
        noConflictingPlugins: str("pluginComposition") !== "unqualified",
        modelAvailable: bool("configuredModelAvailable") !== false && bool("configuredVariantAvailable") !== false,
      })

      // --- Command / preflight shaping ---
      let command = "cat README.md"
      if (str("commandFixture") !== undefined) command = loadCommand(str("commandFixture")!)
      if (str("preflight") === "ask") command = loadCommand("C45") // secret → deterministic local stop
      if (num("payloadBytes") !== undefined) {
        command = "a".repeat(4000) // two resources below push the DTO over 8192 bytes
      }
      const binding = str("binding")

      // --- Setup prefill (never counted in expectedLlmCalls) ---
      if (num("attemptsInLastMinute") !== undefined) {
        reviewer.queueResult(DeferredReviewer.text(CONFORMING_RAW))
        for (let i = 0; i < num("attemptsInLastMinute")!; i++) {
          if (i > 0) reviewer.queueResult(DeferredReviewer.text(CONFORMING_RAW))
          controller.captureSnapshot(snapshotFor(`prefill${i}`, command))
          await controller.handleEvaluate(eventFor(`prefill${i}`, command))
        }
      }
      const setupPending: Array<Promise<AdapterDirective>> = []
      if (num("physicalInFlight") !== undefined) {
        for (let i = 0; i < num("physicalInFlight")!; i++) {
          controller.captureSnapshot(snapshotFor(`hanging${i}`, command))
          setupPending.push(controller.handleEvaluate(eventFor(`hanging${i}`, command)))
          await new Promise((resolve) => setTimeout(resolve, 0))
        }
      }
      if (num("registryEntries") !== undefined) {
        for (let i = 0; i < num("registryEntries")!; i++) {
          controller.captureSnapshot(snapshotFor(`fill${i}`, `printf filler${i}`))
        }
      }
      if (bool("tombstoneExists") === true) {
        controller.captureSnapshot(snapshotFor("main", command))
        controller.releaseSnapshot("call_main")
      }

      // --- Scenario requests (llm counted from here) ---
      const setupCallsDone = reviewer.inputs.length
      const directives: Array<Promise<AdapterDirective>> = []
      const incomingEffects: string[] = []
      const startRequest = (id: string, cmd: string, sessionID = "ses_life", resourceCount = 1): void => {
        if (binding === "missing") {
          // no capture at all
        } else if (binding === "mismatch") {
          controller.captureSnapshot(snapshotFor("other", "printf unrelated"))
        } else {
          controller.captureSnapshot(snapshotFor(id, cmd, { sessionID }))
        }
        incomingEffects.push(incomingEffect)
        directives.push(
          controller.handleEvaluate(
            eventFor(id, cmd, {
              effect: incomingEffect as PermissionEventView["effect"],
              action,
              sessionID,
              resources: Array.from({ length: resourceCount }, () => cmd),
            }),
          ),
        )
      }

      const requests = (setup.requests ?? null) as string[] | null
      if (requests !== null) {
        // "A:eligible_conforming" / "sessionA:conforming" — parallel requests.
        const ids = requests.map((r) => r.split(":")[0]!)
        startRequest(ids[0]!, command)
        startRequest(ids[1]!, command, ids[1]!.startsWith("session") ? `ses_${ids[1]}` : "ses_life")
        await new Promise((resolve) => setTimeout(resolve, 0))
      } else if (bool("sameCorrelationKey") === true) {
        controller.captureSnapshot(snapshotFor("main", command))
        incomingEffects.push(incomingEffect, incomingEffect)
        directives.push(controller.handleEvaluate(eventFor("main", command)))
        await new Promise((resolve) => setTimeout(resolve, 0))
        directives.push(controller.handleEvaluate(eventFor("main", command)))
      } else {
        startRequest("main", command, "ses_life", num("payloadBytes") !== undefined ? 2 : 1)
        await new Promise((resolve) => setTimeout(resolve, 0))
      }

      // --- Deterministic interventions while classifying / before commit ---
      if (num("cancelAtMs") !== undefined) controller.releaseSnapshot("call_main")
      if (num("unloadAtMs") !== undefined) controller.unload()
      const disableBeforeCommit = bool("disableBeforeCommit") === true
      const inputChanged = bool("inputChanged") === true
      const providerSnapshotChanged = bool("providerSnapshotChanged") === true
      const auditPastDeadline = bool("auditCompletesAfterHookDeadline") === true
      if (disableBeforeCommit || inputChanged || providerSnapshotChanged || auditPastDeadline) {
        audit.onAppend = () => {
          if (disableBeforeCommit) env = { OPENCODE_LLM_APPROVAL_DISABLE: "1" }
          if (inputChanged) controller.captureSnapshot(snapshotFor("main", "printf replaced"))
          if (providerSnapshotChanged) controller.invalidateGeneration("SNAPSHOT_CHANGED")
          if (auditPastDeadline) now += 10_000
        }
      }

      // --- Resolve reviewer calls ---
      const timeoutMode = bool("timeout") === true || str("timeout") === "true"
      if (timeoutMode) {
        // Never resolved: the LLM deadline (scaled) fires first.
      } else if (delayMs !== undefined) {
        const raw = modelResultRaw(setup.modelResult)
        const order = (setup.completionOrder ?? null) as string[] | null
        const indices = order === null ? [0] : order.map((name) => {
          const idx = requests?.findIndex((r) => r.startsWith(`${name}:`)) ?? -1
          return idx >= 0 ? idx : 0
        })
        for (const index of indices) {
          setTimeout(() => {
            const value = requests !== null && index === 1
              ? DeferredReviewer.text(loadRaw("R02"))
              : DeferredReviewer.text(raw)
            reviewer.resolveAt(index, value)
          }, delayMs)
        }
      } else {
        const forced = setup.forcedMockResult ?? setup.modelResult ?? setup.firstResult
        const raw = modelResultRaw(forced)
        // Gate-stopped scenarios (rate/concurrency/etc.) never reach the reviewer.
        if (requests !== null && reviewer.pending > 0) {
          // No explicit completionOrder: resolve in request order (A then B).
          reviewer.resolveAt(0, DeferredReviewer.text(loadRaw("R01")))
          await new Promise((resolve) => setTimeout(resolve, 0))
          if (reviewer.pending > 0) reviewer.resolveAt(1, DeferredReviewer.text(loadRaw("R02")))
        } else if (bool("sameCorrelationKey") === true && reviewer.pending > 0) {
          reviewer.resolveNext(DeferredReviewer.text(raw))
        } else if (str("providerError") !== undefined && reviewer.pending > 0) {
          reviewer.resolveNext(DeferredReviewer.transport(str("providerError")!))
        } else if (reviewer.pending > 0) {
          reviewer.resolveNext(DeferredReviewer.text(raw))
        }
      }

      // Give timers/awaits a chance (scaled deadlines are ≤ 120ms).
      await new Promise((resolve) => setTimeout(resolve, timeoutMode || delayMs !== undefined ? 200 : 5))

      const settled = await Promise.all(directives)
      const effects = settled.map((directive, index) => effectOf(directive, incomingEffects[index] ?? "ask"))

      expect(effects).toEqual(fixture.expectedEffects)
      expect(reviewer.inputs.length - setupCallsDone).toBe(fixture.expectedLlmCalls)

      // Cleanup setup-hanging calls so nothing dangles out of the test.
      reviewer.resolveAll(DeferredReviewer.text(CONFORMING_RAW))
      await Promise.allSettled(setupPending)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
})
