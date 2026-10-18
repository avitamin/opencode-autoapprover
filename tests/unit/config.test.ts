import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import configSchemaJson from "../../schemas/config.schema.json" with { type: "json" }
import {
  effectiveEscalation,
  HOOK_DEADLINE_HARD_MAX_MS,
  loadGuardConfig,
  normalizeAbsolutePath,
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

  test("USERPROFILE fallback when HOME is unset (Windows)", () => {
    expect(resolveConfigPath({ USERPROFILE: "C:\\Users\\anton" })).toBe("C:\\Users\\anton/.config/opencode-llm-approval/config.json")
    expect(resolveConfigPath({ USERPROFILE: "C:\\Users\\anton\\" })).toBe("C:\\Users\\anton/.config/opencode-llm-approval/config.json")
  })

  test("HOME wins over USERPROFILE when both are set", () => {
    expect(resolveConfigPath({ HOME: "/home/a", USERPROFILE: "C:\\Users\\anton" })).toBe("/home/a/.config/opencode-llm-approval/config.json")
  })
})

describe("normalizeAbsolutePath (Windows separators)", () => {
  test("backslash, forward-slash and /C:/ drive forms canonicalize identically (case-folded)", () => {
    expect(normalizeAbsolutePath("C:\\Users\\anton")).toBe("/c:/users/anton")
    expect(normalizeAbsolutePath("C:/Users/anton")).toBe("/c:/users/anton")
    expect(normalizeAbsolutePath("/C:/Users/anton")).toBe("/c:/users/anton")
    expect(normalizeAbsolutePath("C:\\Users\\anton\\..\\Bob")).toBe("/c:/users/bob")
  })

  test("drive paths are case-insensitive, POSIX paths are not (R2)", () => {
    expect(normalizeAbsolutePath("c:\\Users\\ANTON\\src")).toBe("/c:/users/anton/src")
    expect(normalizeAbsolutePath("c:\\Users\\ANTON\\src")).toBe(normalizeAbsolutePath("C:/Users/anton/src"))
    expect(normalizeAbsolutePath("/Home/Anton")).toBe("/Home/Anton")
  })

  test("POSIX behavior is unchanged", () => {
    expect(normalizeAbsolutePath("/a/b/../c")).toBe("/a/c")
    expect(normalizeAbsolutePath("/a//b/./c")).toBe("/a/b/c")
  })

  test("KNOWN LIMITATION (D10 review F4): '..' collapses across backslash on POSIX-looking paths", () => {
    // A real POSIX directory literally named "..\a" is lexically collapsed into
    // a traversal and can satisfy root matching without physically living in
    // the root. Documented platform limitation (docs/05, IMPLEMENTATION_STATUS
    // D10); feasible only when such a directory was deliberately created.
    expect(normalizeAbsolutePath("/home/a3/..\\a/src")).toBe("/home/a/src")
  })
})

describe("loadGuardConfig", () => {
  test("missing file → inactive guard", () => {
    const state = loadGuardConfig(depsFor(null))
    expect(state.status).toBe("inactive")
    if (state.status === "inactive") {
      expect(state.reason).toBe("CONFIG_MISSING")
      expect(state.detail).toContain("not found")
    }
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

  test("windows: drive-letter roots and audit directory are schema-valid and active", () => {
    const env = { USERPROFILE: "C:\\Users\\anton" }
    const roots = ["C:/Users/anton/PhpstormProjects"]
    const state = loadGuardConfig(
      depsFor(
        validConfigText({
          policy: { autoAllow: { maxRisk: "LOW", minConfidence: "HIGH", allowedCategories: ["READ"] }, workspaceRoots: roots, alwaysAskPathPrefixes: [] },
          audit: { directory: "C:/Users/anton/.local/state/opencode-llm-approval", maxFileBytes: 5242880, retainedFiles: 3 },
        }),
        { roots: [...roots, "C:/Users/anton/.local/state/opencode-llm-approval"], env },
      ),
    )
    expect(state.status).toBe("active")
  })

  test("windows: native backslash roots and audit directory are schema-valid and active (D10 review F1)", () => {
    // The JSON pattern previously decoded to a character class holding only "/",
    // rejecting every "C:\…" path an operator pastes from Explorer.
    const env = { USERPROFILE: "C:\\Users\\anton" }
    const roots = ["C:\\Users\\anton\\PhpstormProjects"]
    const state = loadGuardConfig(
      depsFor(
        validConfigText({
          policy: { autoAllow: { maxRisk: "LOW", minConfidence: "HIGH", allowedCategories: ["READ"] }, workspaceRoots: roots, alwaysAskPathPrefixes: [] },
          audit: { directory: "C:\\Users\\anton\\.local\\state\\opencode-llm-approval", maxFileBytes: 5242880, retainedFiles: 3 },
        }),
        { roots: [...roots, "C:\\Users\\anton\\.local\\state\\opencode-llm-approval"], env },
      ),
    )
    expect(state.status).toBe("active")
  })

  test("windows: backslash alwaysAskPathPrefixes normalize to '/' and stay rejectable (D10 review F5)", () => {
    const state = loadGuardConfig(
      depsFor(
        validConfigText({
          policy: { autoAllow: { maxRisk: "LOW", minConfidence: "HIGH", allowedCategories: ["READ"] }, workspaceRoots: [TEST_ROOT], alwaysAskPathPrefixes: ["src\\secrets"] },
        }),
      ),
    )
    expect(state.status).toBe("active")
    if (state.status === "active") {
      expect(state.config.policy.alwaysAskPathPrefixes).toEqual(["src/secrets"])
    }
    // Normalization happens before validation: traversal becomes visible and is rejected.
    expect(
      loadGuardConfig(
        depsFor(
          validConfigText({
            policy: { autoAllow: { maxRisk: "LOW", minConfidence: "HIGH", allowedCategories: ["READ"] }, workspaceRoots: [TEST_ROOT], alwaysAskPathPrefixes: ["a\\..\\b"] },
          }),
        ),
      ).status,
    ).toBe("inactive")
  })

  test("windows: an entire drive is not a valid workspace root (D10 review F6)", () => {
    const env = { XDG_CONFIG_HOME: "D:\\xdg", HOME: undefined, USERPROFILE: "C:\\Users\\anton" }
    const state = loadGuardConfig(
      depsFor(
        validConfigText({
          policy: { autoAllow: { maxRisk: "LOW", minConfidence: "HIGH", allowedCategories: ["READ"] }, workspaceRoots: ["C:/"], alwaysAskPathPrefixes: [] },
        }),
        { roots: ["C:/"], env },
      ),
    )
    expect(state.status).toBe("inactive")
  })

  test("windows: mixed-case duplicate drive roots are detected as nested (R2)", () => {
    // Before case-folding, "C:/Users/anton/proj" and "c:\Users\anton\proj\SUB"
    // normalized differently and hid the containment from the nesting rule.
    const env = { USERPROFILE: "C:\\Users\\anton" }
    const roots = ["C:/Users/anton/PhpstormProjects", "c:\\Users\\anton\\PhpstormProjects\\API"]
    const state = loadGuardConfig(
      depsFor(
        validConfigText({
          policy: { autoAllow: { maxRisk: "LOW", minConfidence: "HIGH", allowedCategories: ["READ"] }, workspaceRoots: roots, alwaysAskPathPrefixes: [] },
        }),
        { roots: [...roots, "C:/Users/anton/.local/state/opencode-llm-approval"], env },
      ),
    )
    expect(state.status).toBe("inactive")
  })

  test("windows: entire home as root is rejected with USERPROFILE too", () => {
    const env = { HOME: undefined, USERPROFILE: "C:\\Users\\anton" }
    const roots = ["C:/Users/anton"]
    const state = loadGuardConfig(
      depsFor(
        validConfigText({ policy: { autoAllow: { maxRisk: "LOW", minConfidence: "HIGH", allowedCategories: ["READ"] }, workspaceRoots: roots, alwaysAskPathPrefixes: [] } }),
        { roots, env },
      ),
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

    test("guard.auto.json example stays semantically valid after placeholder substitution", () => {
      // Review finding: the escalation section (timeoutMs 9000) plus llmTimeoutMs 6500
      // needs a 15500ms chain budget — the template's hookDeadlineMs must cover it,
      // otherwise a filled-in example dies with CONFIG_INVALID instead of going active.
      const raw = readFileSync("examples/guard.auto.json", "utf8")
      const filled = raw
        .replaceAll("REPLACE_ME_ESCALATION_PROVIDER_ID", "example-provider-2")
        .replaceAll("REPLACE_ME_ESCALATION_MODEL_ID", "example-model-2")
        .replaceAll("REPLACE_ME_PROVIDER_ID", "example-provider")
        .replaceAll("REPLACE_ME_MODEL_ID", "example-model")
        .replaceAll("/home/REPLACE_ME_USER/projects/REPLACE_ME_PROJECT", TEST_ROOT)
        .replaceAll("/home/REPLACE_ME_USER/.local/state/opencode-llm-approval", TEST_AUDIT_DIR)
        .replaceAll("REPLACE_ME", "reviewed")
      const state = loadGuardConfig(depsFor(filled))
      expect(state.status).toBe("active")
      if (state.status === "active") {
        expect(state.config.escalation?.allowedCategories).toEqual(["READ", "EXEC"])
      }
    })

    test("D8: maxResources ceiling is 32", () => {
      expect(loadGuardConfig(depsFor(validConfigText({ limits: limitsWith({ maxResources: 32 }) }))).status).toBe("active")
      expect(loadGuardConfig(depsFor(validConfigText({ limits: limitsWith({ maxResources: 33 }) }))).status).toBe("inactive")
    })

    test("D10: maxInFlight ceiling is 8", () => {
      // Operator tuning (16.10) raised maxInFlight past the old cap of 2 → CONFIG_INVALID
      // silently disarmed the guard for three days. Ceiling lifted 2 → 8, default 2 unchanged.
      expect(loadGuardConfig(depsFor(validConfigText({ limits: limitsWith({ maxInFlight: 8 }) }))).status).toBe("active")
      expect(loadGuardConfig(depsFor(validConfigText({ limits: limitsWith({ maxInFlight: 9 }) }))).status).toBe("inactive")
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
