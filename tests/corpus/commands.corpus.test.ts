/**
 * Corpus: tests/fixtures/commands.jsonl (docs/08).
 * Baseline environment is fixed by tests/fixtures/README.md: root /workspace/project,
 * cwd the same, full binding, consent given, operator prefixes secrets/credentials/production.
 * Nothing here ever touches a real shell: commands are data for pure functions only.
 *
 * Per fixture:
 *  - expectedGate === "eligible" ⇔ runPreflight passes with the fixture context;
 *  - for eligible commands the full controller path runs in auto mode with a
 *    conforming mock (R01) → allow ⇔ expectedAutoWithConformingModel.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { GuardController } from "../../src/controller.js"
import { runPreflight } from "../../src/preflight.js"
import { ScriptedReviewer } from "../../src/reviewer.js"
import type { GuardConfig, PermissionEventView, ReviewerResult, ToolSnapshot } from "../../src/types.js"

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

interface CommandFixture {
  readonly id: string
  readonly command: string
  readonly context: Record<string, unknown>
  readonly expectedGate: "eligible" | "ask"
  readonly expectedAutoWithConformingModel: boolean
  readonly expectedModelRiskHint: string
  readonly reason: string
}

function loadFixtures(): CommandFixture[] {
  const text = readFileSync("tests/fixtures/commands.jsonl", "utf8") as string
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as CommandFixture)
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
    privacy: { allowCommandTransmission: true, destinationReview: "corpus baseline" },
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

/** Build snapshot/event/opts from a fixture context merged into the baseline (fixtures/README). */
function materialize(fixture: CommandFixture): {
  snapshot: ToolSnapshot | null
  event: PermissionEventView
  effectiveCwd: string
  allowCommandTransmission: boolean
  platformQualified: boolean
  config: GuardConfig
} {
  const ctx = fixture.context
  const command = fixture.command
  const resources = Array.isArray(ctx.resources) ? (ctx.resources as string[]) : [command]
  const cwd = typeof ctx.cwd === "string" ? ctx.cwd : ROOT
  const root = typeof ctx.workspaceRoot === "string" ? ctx.workspaceRoot : ROOT
  const config = baselineConfig({
    policy: {
      autoAllow: { maxRisk: "LOW", minConfidence: "HIGH", allowedCategories: ["READ"] },
      workspaceRoots: [root],
      alwaysAskPathPrefixes: ["secrets", "credentials", "production"],
    },
    privacy: {
      allowCommandTransmission: ctx.privacyConsent !== false,
      destinationReview: "corpus baseline",
    },
  })

  const binding = ctx.binding
  const toolCallID = binding === "missing" ? null : `call_${fixture.id}`
  const snapshot: ToolSnapshot | null = {
    // "mismatch": the captured snapshot belongs to a different tool call than the event source.
    toolCallID: binding === "mismatch" ? "call_captured_other" : toolCallID ?? "call_none",
    sessionID: "ses_corpus",
    messageID: "msg_corpus",
    agent: "build",
    command,
    workdir: cwd,
    envelope: {},
    extraInputKeys: ctx.env === "overridden" ? ["env"] : [],
    capturedAt: 1_000_000,
  }
  const event: PermissionEventView = {
    sessionID: "ses_corpus",
    agent: "build",
    action: "shell",
    resources,
    effect: "ask",
    message: null,
    sourceToolCallID: toolCallID,
    sourceMessageID: "msg_corpus",
  }
  return {
    snapshot: binding === "missing" ? null : snapshot,
    event,
    effectiveCwd: cwd,
    allowCommandTransmission: config.privacy.allowCommandTransmission,
    platformQualified: ctx.runtime !== "unverified",
    config,
  }
}

describe("corpus: commands.jsonl (preflight gates)", () => {
  const fixtures = loadFixtures()

  test("corpus is loaded completely", () => {
    expect(fixtures.length).toBe(80)
    expect(fixtures.filter((f) => f.expectedGate === "eligible").length).toBe(60)
    expect(fixtures.filter((f) => f.expectedGate === "ask").length).toBe(20)
  })

  test("gate=ask fixtures never claim auto-allow", () => {
    for (const f of fixtures) {
      if (f.expectedGate === "ask") expect(f.expectedAutoWithConformingModel).toBe(false)
    }
  })

  for (const fixture of fixtures) {
    test(`${fixture.id} gate=${fixture.expectedGate}: ${fixture.reason}`, () => {
      const m = materialize(fixture)
      // Host/runtime qualification is a controller-level gate that sits above preflight.
      if (!m.platformQualified) {
        expect(fixture.expectedGate).toBe("ask")
        return
      }
      const result = m.snapshot === null
        ? { ok: false as const, reason: "INPUT_UNBOUND" as const }
        : runPreflight(m.snapshot, m.event, m.config.policy, m.config.limits, {
            effectiveCwd: m.effectiveCwd,
            allowCommandTransmission: m.allowCommandTransmission,
            guardConfigDirs: GUARD_CONFIG_DIRS,
          })
      expect(result.ok).toBe(fixture.expectedGate === "eligible")
    })
  }
})

describe("corpus: commands.jsonl (auto path with a conforming model)", () => {
  const fixtures = loadFixtures()
  const eligible = fixtures.filter((f) => f.expectedGate === "eligible")

  test("eligible subset matches the corpus size", () => {
    expect(eligible.length).toBe(60)
  })

  for (const fixture of eligible) {
    test(`${fixture.id} auto=${fixture.expectedAutoWithConformingModel}`, async () => {
      const m = materialize(fixture)
      const reviewer = new ScriptedReviewer([ScriptedReviewer.text(CONFORMING_RAW)])
      const audit = { append: async () => undefined, healthy: async () => true }
      const controller = new GuardController({
        config: { status: "active", config: m.config },
        reviewerFor: () => reviewer,
        audit,
        clock: () => 1_000_000,
        isoNow: () => "2026-09-28T00:00:00.000Z",
        env: () => ({}),
        randomUUID: () => `req-${fixture.id}`,
        fingerprintSalt: "corpus",
        guardConfigDirs: GUARD_CONFIG_DIRS,
        locationDirectory: ROOT,
        platformQualified: m.platformQualified,
        noConflictingPlugins: true,
        modelAvailable: true,
      })
      if (m.snapshot !== null) controller.captureSnapshot(m.snapshot)
      const directive = await controller.handleEvaluate(m.event)
      expect(directive.commit === "allow").toBe(fixture.expectedAutoWithConformingModel)
      expect(reviewer.callCount).toBe(fixture.expectedAutoWithConformingModel ? 1 : 0)
    })
  }
})
