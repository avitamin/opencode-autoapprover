import type { GuardConfig, PermissionEventView, ToolSnapshot } from "../src/types.js"

export const TEST_ROOT = "/tmp/opencode/guard-test-root"
export const TEST_LOCATION = TEST_ROOT
export const TEST_AUDIT_DIR = "/tmp/opencode/guard-test-audit"
export const GUARD_CONFIG_DIRS = ["/home/tester/.config/opencode-llm-approval", "/home/tester/.config/opencode"]

export function makeConfig(overrides: Partial<GuardConfig> = {}): GuardConfig {
  return {
    schemaVersion: 2,
    mode: "auto",
    model: { providerID: "test-provider", id: "test-model" },
    policy: {
      autoAllow: { maxRisk: "LOW", minConfidence: "HIGH", allowedCategories: ["READ"] },
      workspaceRoots: [TEST_ROOT],
      alwaysAskPathPrefixes: ["secrets", "credentials"],
    },
    privacy: { allowCommandTransmission: true, destinationReview: "test endpoint reviewed by operator" },
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
  }
}

export function makeSnapshot(overrides: Partial<ToolSnapshot> = {}): ToolSnapshot {
  return {
    toolCallID: "call_1",
    sessionID: "ses_1",
    messageID: "msg_1",
    agent: "build",
    command: "pwd",
    workdir: TEST_ROOT,
    envelope: {},
    extraInputKeys: [],
    capturedAt: 1_000_000,
    ...overrides,
  }
}

export function makeEvent(overrides: Partial<PermissionEventView> = {}): PermissionEventView {
  return {
    sessionID: "ses_1",
    agent: "build",
    action: "shell",
    resources: ["pwd"],
    effect: "ask",
    message: null,
    sourceToolCallID: "call_1",
    sourceMessageID: "msg_1",
    ...overrides,
  }
}

export const CONFORMING_LOW = JSON.stringify({
  schemaVersion: 2,
  risk: "LOW",
  categories: ["READ"],
  confidence: "HIGH",
  signals: [],
  summary: "safe read-only command inside workspace",
})

export async function flush(): Promise<void> {
  // Let fire-and-forget audit appends and late promise continuations settle.
  for (let i = 0; i < 4; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}
