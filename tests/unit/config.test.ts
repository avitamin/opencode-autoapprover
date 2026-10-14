import { describe, expect, test } from "bun:test"
import configSchemaJson from "../../schemas/config.schema.json" with { type: "json" }
import {
  effectiveEscalation,
  HOOK_DEADLINE_HARD_MAX_MS,
  loadGuardConfig,
  resolveConfigPath,
  reviewerChain,
  type ConfigDeps,
} from "../../src/config.js"
import { TEST_AUDIT_DIR, TEST_ROOT } from "../helpers.js"

const ENV = { HOME: "/home/tester" }

function depsFor(text: string | null, opts: { roots?: string[]; env?: Record<string, string | undefined> } = {}): ConfigDeps {
  const roots = new Set(opts.roots ?? [TEST_ROOT, TEST_AUDIT_DIR])
  return {
    readTextFile: () => text,
    statPath: (path) => (roots.has(path) ? { isDirectory: true, isSymlink: false } : null),
    env: { ...ENV, ...opts.env },
  }
}

function validConfigText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 2,
    mode: "shadow",
    model: { providerID: "test-provider", id: "test-model" },
    policy: {
      autoAllow: { maxRisk: "LOW", minConfidence: "HIGH", allowedCategories: ["READ"] },
      workspaceRoots: [TEST_ROOT],
      alwaysAskPathPrefixes: ["secrets", "credentials"],
    },
    privacy: { allowCommandTransmission: false, destinationReview: "reviewed endpoint" },
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
    audit: { directory: TEST_AUDIT_DIR, maxFileBytes: 5242880, retainedFiles: 3 },
    ...overrides,
  })
}

describe("resolveConfigPath", () => {
  test("XDG_CONFIG_HOME wins over HOME", () => {
    expect(resolveConfigPath({ HOME: "/home/a", XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/opencode-llm-approval/config.json")
    expect(resolveConfigPath({ HOME: "/home/a" })).toBe("/home/a/.config/opencode-llm-approval/config.json")
  })
})

describe("loadGuardConfig", () => {
  test("missing file → inactive guard", () => {
    const state = loadGuardConfig(depsFor(null))
    expect(state.status).toBe("inactive")
    if (state.status === "inactive") expect(state.detail).toContain("not found")
  })

  test("valid config → active and deeply frozen", () => {
    const state = loadGuardConfig(depsFor(validConfigText()))
    expect(state.status).toBe("active")
    if (state.status === "active") {
      expect(Object.isFrozen(state.config)).toBe(true)
      expect(Object.isFrozen(state.config.policy)).toBe(true)
      expect(Object.isFrozen(state.config.policy.autoAllow)).toBe(true)
    }
  })

  test("non-strict JSON → inactive (duplicate keys, comments, trailing commas)", () => {
    for (const bad of ['{"schemaVersion":2,"schemaVersion":2}', "{ /* c */ }", '{"a":1,}']) {
      expect(loadGuardConfig(depsFor(bad)).status).toBe("inactive")
    }
  })

  test("schema violations → inactive", () => {
    // maxRisk HIGH is not representable in the enum: structural ceiling.
    const high = validConfigText()
    const parsed = JSON.parse(high) as Record<string, unknown>
    const policy = parsed.policy as Record<string, unknown>
    const autoAllow = policy.autoAllow as Record<string, unknown>
    autoAllow.maxRisk = "HIGH"
    expect(loadGuardConfig(depsFor(JSON.stringify(parsed))).status).toBe("inactive")

    expect(loadGuardConfig(depsFor(validConfigText({ schemaVersion: 1 }))).status).toBe("inactive")
    expect(loadGuardConfig(depsFor(validConfigText({ extraTopLevel: true }))).status).toBe("inactive")
    expect(
      loadGuardConfig(depsFor(validConfigText({ limits: { hookDeadlineMs: 100, llmTimeoutMs: 50, maxInFlight: 1, maxAssessmentsPerMinute: 1, maxCommandBytes: 128, maxResources: 1, maxPayloadBytes: 512, maxResponseBytes: 256 } }))).status,
    ).toBe("inactive")
  })

  test("semantic: llmTimeout must leave 500ms before hookDeadline", () => {
    const state = loadGuardConfig(
      depsFor(validConfigText({ limits: { hookDeadlineMs: 6000, llmTimeoutMs: 5600, maxInFlight: 2, maxAssessmentsPerMinute: 20, maxCommandBytes: 4096, maxResources: 8, maxPayloadBytes: 8192, maxResponseBytes: 8192 } })),
    )
    expect(state.status).toBe("inactive")
  })

  test("semantic: placeholders, root sanity, audit overlap, prefixes", () => {
    expect(loadGuardConfig(depsFor(validConfigText({ model: { providerID: "REPLACE_ME_PROVIDER_ID", id: "x" } }))).status).toBe("inactive")
    // root = /
    expect(
      loadGuardConfig(depsFor(validConfigText({ policy: { autoAllow: { maxRisk: "LOW", minConfidence: "HIGH", allowedCategories: ["READ"] }, workspaceRoots: ["/"], alwaysAskPathPrefixes: [] } }))).status,
    ).toBe("inactive")
    // root = entire home
    expect(
      loadGuardConfig(depsFor(validConfigText({ policy: { autoAllow: { maxRisk: "LOW", minConfidence: "HIGH", allowedCategories: ["READ"] }, workspaceRoots: ["/home/tester"], alwaysAskPathPrefixes: [] } }))).status,
    ).toBe("inactive")
    // roots containing each other
    expect(
      loadGuardConfig(
        depsFor(validConfigText({ policy: { autoAllow: { maxRisk: "LOW", minConfidence: "HIGH", allowedCategories: ["READ"] }, workspaceRoots: [TEST_ROOT, `${TEST_ROOT}/sub`], alwaysAskPathPrefixes: [] } }), {
          roots: [TEST_ROOT, `${TEST_ROOT}/sub`, TEST_AUDIT_DIR],
        }),
      ).status,
    ).toBe("inactive")
    // nonexistent root directory
    expect(
      loadGuardConfig(depsFor(validConfigText({ policy: { autoAllow: { maxRisk: "LOW", minConfidence: "HIGH", allowedCategories: ["READ"] }, workspaceRoots: ["/tmp/opencode/no-such-root"], alwaysAskPathPrefixes: [] } }))).status,
    ).toBe("inactive")
    // absolute / .. / wildcard prefixes
    for (const prefixes of [["/abs"], ["a/../b"], ["glob*"]]) {
      expect(
        loadGuardConfig(depsFor(validConfigText({ policy: { autoAllow: { maxRisk: "LOW", minConfidence: "HIGH", allowedCategories: ["READ"] }, workspaceRoots: [TEST_ROOT], alwaysAskPathPrefixes: prefixes } }))).status,
      ).toBe("inactive")
    }
  })

  test("semantic: shadow/auto require non-empty destinationReview", () => {
    expect(loadGuardConfig(depsFor(validConfigText({ privacy: { allowCommandTransmission: false, destinationReview: "" } }))).status).toBe("inactive")
    expect(loadGuardConfig(depsFor(validConfigText({ mode: "off", privacy: { allowCommandTransmission: false, destinationReview: "" } }))).status).toBe("active")
  })

  test("symlink root → inactive", () => {
    const deps: ConfigDeps = {
      readTextFile: () => validConfigText(),
      statPath: (path) => (path === TEST_ROOT ? { isDirectory: true, isSymlink: true } : path === TEST_AUDIT_DIR ? { isDirectory: true, isSymlink: false } : null),
      env: ENV,
    }
    expect(loadGuardConfig(deps).status).toBe("inactive")
  })

  test("diagnostics.llmTrace: valid section → active with defaults omitted", () => {
    const state = loadGuardConfig(depsFor(validConfigText({ diagnostics: { llmTrace: { enabled: true } } })))
    expect(state.status).toBe("active")
    if (state.status === "active") {
      expect(state.config.diagnostics?.llmTrace.enabled).toBe(true)
      expect(state.config.diagnostics?.llmTrace.directory).toBeUndefined()
      expect(Object.isFrozen(state.config.diagnostics?.llmTrace)).toBe(true)
    }
    // Absent section stays valid (default: no trace).
    expect(loadGuardConfig(depsFor(validConfigText())).status).toBe("active")
  })

  test("diagnostics.llmTrace: schema violations → inactive", () => {
    // unknown key inside diagnostics
    expect(loadGuardConfig(depsFor(validConfigText({ diagnostics: { llmTrace: { enabled: true }, extra: 1 } }))).status).toBe("inactive")
    // llmTrace without enabled
    expect(loadGuardConfig(depsFor(validConfigText({ diagnostics: { llmTrace: { directory: TEST_AUDIT_DIR } } }))).status).toBe("inactive")
    // relative directory
    expect(loadGuardConfig(depsFor(validConfigText({ diagnostics: { llmTrace: { enabled: true, directory: "relative/trace" } } }))).status).toBe("inactive")
    // retainedFiles above the cap
    expect(loadGuardConfig(depsFor(validConfigText({ diagnostics: { llmTrace: { enabled: true, retainedFiles: 31 } } }))).status).toBe("inactive")
  })

  test("diagnostics.llmTrace: semantic violations → inactive", () => {
    // trace directory overlapping a workspace root
    expect(
      loadGuardConfig(
        depsFor(validConfigText({ diagnostics: { llmTrace: { enabled: true, directory: `${TEST_ROOT}/trace` } } }), {
          roots: [TEST_ROOT, TEST_AUDIT_DIR, `${TEST_ROOT}/trace`],
        }),
      ).status,
    ).toBe("inactive")
    // placeholder
    expect(loadGuardConfig(depsFor(validConfigText({ diagnostics: { llmTrace: { enabled: true, directory: "/trace/REPLACE_ME" } } }))).status).toBe("inactive")
    // symlink
    const deps: ConfigDeps = {
      readTextFile: () => validConfigText({ diagnostics: { llmTrace: { enabled: true, directory: "/tmp/opencode/trace-link" } } }),
      statPath: (path) =>
        path === TEST_ROOT || path === TEST_AUDIT_DIR
          ? { isDirectory: true, isSymlink: false }
          : path === "/tmp/opencode/trace-link"
            ? { isDirectory: true, isSymlink: true }
            : null,
      env: ENV,
    }
    expect(loadGuardConfig(deps).status).toBe("inactive")
  })

  describe("escalation (D3)", () => {
    const limitsWith = (overrides: Record<string, number>) => ({
      hookDeadlineMs: 8000,
      llmTimeoutMs: 6500,
      maxInFlight: 2,
      maxAssessmentsPerMinute: 20,
      maxCommandBytes: 4096,
      maxResources: 8,
      maxPayloadBytes: 8192,
      maxResponseBytes: 8192,
      ...overrides,
    })
    const HIGH_MODEL = { providerID: "test-provider", id: "test-model", variant: "high" }

    test("valid section → active; effectiveEscalation resolves defaults; chain = primary + stages", () => {
      const state = loadGuardConfig(
        depsFor(validConfigText({ escalation: { models: [HIGH_MODEL] }, limits: limitsWith({ hookDeadlineMs: 20000 }) })),
      )
      expect(state.status).toBe("active")
      if (state.status === "active") {
        const escalation = effectiveEscalation(state.config)
        expect(escalation?.triggerOn).toEqual({ unknownRisk: true, invalidResponse: true, lowConfidence: true })
        expect(escalation?.timeoutMs).toBe(9000)
        // D7: absent allowedCategories → the global autoAllow set is inherited.
        expect(escalation?.allowedCategories).toEqual(["READ"])
        expect(reviewerChain(state.config)).toHaveLength(2)
        expect(Object.isFrozen(state.config.escalation)).toBe(true)
      }
    })

    test("absent section → null escalation, single-model chain", () => {
      const state = loadGuardConfig(depsFor(validConfigText()))
      expect(state.status).toBe("active")
      if (state.status === "active") {
        expect(effectiveEscalation(state.config)).toBeNull()
        expect(reviewerChain(state.config)).toHaveLength(1)
      }
    })

    test("schema violations → inactive", () => {
      // empty / too many models, unknown key, timeout above the cap
      expect(loadGuardConfig(depsFor(validConfigText({ escalation: { models: [] }, limits: limitsWith({ hookDeadlineMs: 20000 }) }))).status).toBe("inactive")
      expect(
        loadGuardConfig(depsFor(validConfigText({ escalation: { models: [HIGH_MODEL, HIGH_MODEL, HIGH_MODEL] }, limits: limitsWith({ hookDeadlineMs: 25000 }) }))).status,
      ).toBe("inactive")
      expect(loadGuardConfig(depsFor(validConfigText({ escalation: { models: [HIGH_MODEL], retry: true } }))).status).toBe("inactive")
      expect(
        loadGuardConfig(depsFor(validConfigText({ escalation: { models: [HIGH_MODEL], timeoutMs: 30001 }, limits: limitsWith({ hookDeadlineMs: 40000 }) }))).status,
      ).toBe("inactive")
    })

    test("stage timeout ceilings are 30000 (D6)", () => {
      // llmTimeoutMs boundary: 30000 fits a 40000 hook deadline (>=500ms reserve), 30001 exceeds the schema cap.
      expect(loadGuardConfig(depsFor(validConfigText({ limits: limitsWith({ hookDeadlineMs: 40000, llmTimeoutMs: 30000 }) }))).status).toBe("active")
      expect(loadGuardConfig(depsFor(validConfigText({ limits: limitsWith({ hookDeadlineMs: 40000, llmTimeoutMs: 30001 }) }))).status).toBe("inactive")
      // escalation.timeoutMs boundary: chain 6500 + 30000 = 36500 fits the 40000 hook deadline.
      expect(
        loadGuardConfig(depsFor(validConfigText({ escalation: { models: [HIGH_MODEL], timeoutMs: 30000 }, limits: limitsWith({ hookDeadlineMs: 40000 }) }))).status,
      ).toBe("active")
      expect(
        loadGuardConfig(depsFor(validConfigText({ escalation: { models: [HIGH_MODEL], timeoutMs: 30001 }, limits: limitsWith({ hookDeadlineMs: 40000 }) }))).status,
      ).toBe("inactive")
    })

    test("semantic: duplicate of the primary model → inactive", () => {
      expect(
        loadGuardConfig(
          depsFor(validConfigText({ escalation: { models: [{ providerID: "test-provider", id: "test-model" }] }, limits: limitsWith({ hookDeadlineMs: 20000 }) })),
        ).status,
      ).toBe("inactive")
    })

    test("semantic: two identical escalation models → inactive", () => {
      expect(
        loadGuardConfig(depsFor(validConfigText({ escalation: { models: [HIGH_MODEL, HIGH_MODEL] }, limits: limitsWith({ hookDeadlineMs: 25000 }) }))).status,
      ).toBe("inactive")
    })

    test("semantic: chain budget must fit hookDeadlineMs", () => {
      // 6500 + 1×9000 = 15500 > 15000
      expect(
        loadGuardConfig(depsFor(validConfigText({ escalation: { models: [HIGH_MODEL] }, limits: limitsWith({ hookDeadlineMs: 15000 }) }))).status,
      ).toBe("inactive")
      // 6500 + 2×9000 = 24500 ≤ 25000 fits
      expect(
        loadGuardConfig(depsFor(validConfigText({ escalation: { models: [HIGH_MODEL, { providerID: "test-provider-2", id: "test-model-2" }] }, limits: limitsWith({ hookDeadlineMs: 25000 }) }))).status,
      ).toBe("active")
    })

    test("semantic: placeholders in escalation models → inactive", () => {
      expect(
        loadGuardConfig(
          depsFor(validConfigText({ escalation: { models: [{ providerID: "REPLACE_ME", id: "x" }] }, limits: limitsWith({ hookDeadlineMs: 20000 }) })),
        ).status,
      ).toBe("inactive")
    })

    test("D7: escalation.allowedCategories superset rule and resolution", () => {
      // Global set is ["READ"]; dropping it from the escalation set → semantic violation.
      expect(
        loadGuardConfig(depsFor(validConfigText({ escalation: { models: [HIGH_MODEL], allowedCategories: ["EXEC"] }, limits: limitsWith({ hookDeadlineMs: 20000 }) }))).status,
      ).toBe("inactive")
      // Schema enum: UNKNOWN is structurally not an allowlable category.
      expect(
        loadGuardConfig(depsFor(validConfigText({ escalation: { models: [HIGH_MODEL], allowedCategories: ["READ", "UNKNOWN"] }, limits: limitsWith({ hookDeadlineMs: 20000 }) }))).status,
      ).toBe("inactive")
      // A proper superset resolves to the escalation set.
      const state = loadGuardConfig(depsFor(validConfigText({ escalation: { models: [HIGH_MODEL], allowedCategories: ["READ", "EXEC"] }, limits: limitsWith({ hookDeadlineMs: 20000 }) })))
      expect(state.status).toBe("active")
      if (state.status === "active") {
        expect(effectiveEscalation(state.config)?.allowedCategories).toEqual(["READ", "EXEC"])
      }
    })

    test("D8: maxResources ceiling is 32", () => {
      expect(loadGuardConfig(depsFor(validConfigText({ limits: limitsWith({ maxResources: 32 }) }))).status).toBe("active")
      expect(loadGuardConfig(depsFor(validConfigText({ limits: limitsWith({ maxResources: 33 }) }))).status).toBe("inactive")
    })

    test("hookDeadlineMs ceiling is a hard cap not overridable by config", () => {
      expect(loadGuardConfig(depsFor(validConfigText({ limits: limitsWith({ hookDeadlineMs: 120000, llmTimeoutMs: 6500 }) }))).status).toBe("active")
      expect(loadGuardConfig(depsFor(validConfigText({ limits: limitsWith({ hookDeadlineMs: 120001, llmTimeoutMs: 6500 }) }))).status).toBe("inactive")
    })

    test("hookDeadlineMs hard ceiling stays in sync between schema and code", () => {
      const schemaMax = (configSchemaJson.properties.limits as { properties: { hookDeadlineMs: { maximum: number } } }).properties.hookDeadlineMs.maximum
      expect(schemaMax).toBe(HOOK_DEADLINE_HARD_MAX_MS)
    })
  })
})
