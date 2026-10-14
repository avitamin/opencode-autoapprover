/**
 * Internal domain types of opencode-llm-approval.
 *
 * These are project-owned types (docs/02): they are NOT a copy of the SDK.
 * The SDK surface is confined to src/opencode/adapter.ts.
 */

export type GuardMode = "off" | "shadow" | "auto"
export type Effect = "allow" | "ask" | "deny"

export type Risk = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | "UNKNOWN"
export type Confidence = "LOW" | "MEDIUM" | "HIGH"
export type Category = "READ" | "WRITE" | "EXEC" | "NETWORK" | "STATE_CHANGE" | "UNKNOWN"
export type Signal =
  | "SECRET_LIKE"
  | "DESTRUCTIVE"
  | "PRIVILEGE"
  | "NETWORK_EGRESS"
  | "INJECTION_ATTEMPT"
  | "AMBIGUOUS_SYNTAX"
  | "UNPARSED_SEGMENT"
  | "SCOPE_ESCAPE"
  | "OTHER"

/** Trace-only diagnostic: which binding condition produced an INPUT_MISMATCH stop (docs/03, D5). */
export type InputMismatchDetail = "extraInputKeys" | "resourcesEmpty" | "resourcesInconsistent"

/** Reason codes — closed enumeration, mirrors schemas/audit.schema.json. */
export type ReasonCode =
  | "RISK_WITHIN_THRESHOLD"
  | "NATIVE_ALLOW"
  | "NATIVE_DENY"
  | "UNKNOWN_ACTION"
  | "MODE_OFF"
  | "SHADOW_MODE"
  | "KILL_SWITCH"
  | "CONFIG_INVALID"
  | "HOST_UNVERIFIED"
  | "PLUGIN_CONFLICT"
  | "INPUT_UNBOUND"
  | "INPUT_MISMATCH"
  | "SECRET_DETECTED"
  | "OUTSIDE_SCOPE"
  | "PRIVACY_BLOCKED"
  | "PAYLOAD_TOO_LARGE"
  | "INVALID_RESPONSE"
  | "RISK_ABOVE_THRESHOLD"
  | "CONFIDENCE_BELOW_MINIMUM"
  | "CATEGORY_NOT_ALLOWED"
  | "MODEL_UNAVAILABLE"
  | "PROVIDER_ERROR"
  | "PROVIDER_CHANGED"
  | "TIMEOUT"
  | "CANCELLED"
  | "UNLOAD"
  | "SNAPSHOT_CHANGED"
  | "RATE_LIMIT"
  | "CONCURRENCY_LIMIT"
  | "MEMORY_LIMIT"
  | "DUPLICATE_EVENT"
  | "AUDIT_ERROR"
  | "UNSUPPORTED_PLATFORM"
  | "CIRCUIT_OPEN"
  | "INTERNAL_ERROR"

export type Outcome = "skipped" | "ask" | "shadow_would_allow" | "allow_prepared"

export interface ModelRef {
  readonly providerID: string
  readonly id: string
  readonly variant?: string
}

/**
 * Operator-configured escalation chain (D3, docs/05, docs/06): optional.
 * Absent section → exactly one reviewer call on `model`, as before. When
 * present, an inconclusive stage result (per triggerOn) is retried once on
 * the next model of the chain — a bounded escalation, never a retry loop.
 */
export interface EscalationConfig {
  /** 1–2 models tried in order after the primary; each must differ from the others. */
  readonly models: readonly ModelRef[]
  /** Escalation triggers; every missing field defaults to true. */
  readonly triggerOn?: {
    /** risk: UNKNOWN in a schema-valid assessment. */
    readonly unknownRisk?: boolean
    /** Unparseable, oversized or schema/coherence-invalid response. */
    readonly invalidResponse?: boolean
    /** confidence: LOW in a schema-valid assessment (the whole verdict is unreliable). */
    readonly lowConfidence?: boolean
  }
  /** Per-escalation-stage deadline; default 9000. */
  readonly timeoutMs?: number
  /**
   * D7: categories an escalation-stage verdict may carry. Must be a superset of
   * policy.autoAllow.allowedCategories; absent → the global set (single-policy
   * behavior). A stage-0 verdict that fails only the global category check and
   * would pass this set is deferred to the next chain model.
   */
  readonly allowedCategories?: readonly AllowedCategory[]
}

/** Verdict categories the operator may allow (schemas/config.schema.json enum; UNKNOWN is structurally excluded). */
export type AllowedCategory = "READ" | "WRITE" | "EXEC" | "NETWORK" | "STATE_CHANGE"

/** Operator authorization threshold (schemas/config.schema.json structural ceilings apply). */
export interface AutoAllowPolicy {
  readonly maxRisk: "LOW" | "MEDIUM"
  readonly minConfidence: "MEDIUM" | "HIGH"
  readonly allowedCategories: readonly AllowedCategory[]
}

export interface GuardLimits {
  readonly hookDeadlineMs: number
  readonly llmTimeoutMs: number
  readonly maxInFlight: number
  readonly maxAssessmentsPerMinute: number
  readonly maxCommandBytes: number
  readonly maxResources: number
  readonly maxPayloadBytes: number
  readonly maxResponseBytes: number
}

export interface GuardConfig {
  readonly schemaVersion: 2
  readonly mode: GuardMode
  readonly model: ModelRef
  /** Optional escalation chain (D3); absent → single-model behavior. */
  readonly escalation?: EscalationConfig
  readonly policy: {
    readonly autoAllow: AutoAllowPolicy
    readonly workspaceRoots: readonly string[]
    readonly alwaysAskPathPrefixes: readonly string[]
  }
  readonly privacy: {
    readonly allowCommandTransmission: boolean
    readonly destinationReview: string
  }
  readonly limits: GuardLimits
  readonly audit: {
    readonly directory: string
    readonly maxFileBytes: number
    readonly retainedFiles: number
  }
  /** Optional opt-in diagnostics; absent section → no trace (default). */
  readonly diagnostics?: {
    readonly llmTrace: {
      readonly enabled: boolean
      readonly directory?: string
      readonly maxFileBytes?: number
      readonly retainedFiles?: number
    }
  }
}

/** Result of trusted-config loading. Missing or invalid file → inactive guard (all outcomes stay ask). */
export type GuardConfigState =
  | { readonly status: "active"; readonly config: GuardConfig }
  | { readonly status: "inactive"; readonly reason: "CONFIG_INVALID"; readonly detail: string }

/**
 * Shell-tool envelope input values (docs/03, D5): documented host-contract keys
 * beyond {command, workdir} — timeout, background. They only bound the host-side
 * execution envelope and cannot alter the transmitted command semantics; their
 * values are bound into the snapshot fingerprint and never sent to the reviewer.
 */
export type ToolEnvelope = Readonly<Record<string, string | number | boolean>>

/** Complete immutable tool-input snapshot captured from the tool hook (docs/02: full input binding). */
export interface ToolSnapshot {
  readonly toolCallID: string
  readonly sessionID: string
  readonly messageID: string
  readonly agent: string | null
  /** Full raw command, compound forms included, never reconstructed from resources. */
  readonly command: string
  readonly workdir: string | null
  /** Documented envelope keys with contract-conforming types (docs/03); bound by the fingerprint. */
  readonly envelope: ToolEnvelope
  /**
   * Tool-input keys outside the documented shell-tool contract {command, workdir,
   * timeout, background}, or envelope keys with a contract-violating value type.
   * Their presence can change shell/env/sandbox/execution → the request is not
   * eligible (docs/03).
   */
  readonly extraInputKeys: readonly string[]
  readonly capturedAt: number
}

/** Read-only normalized view of a permission evaluate event. */
export interface PermissionEventView {
  readonly sessionID: string
  readonly agent: string | null
  readonly action: string
  readonly resources: readonly string[]
  readonly effect: Effect
  readonly message: string | null
  readonly sourceToolCallID: string | null
  readonly sourceMessageID: string | null
}

/** Minimal reviewer input DTO (schemas/review-input.schema.json). No session IDs, no absolute home paths, no operator thresholds. */
export interface ReviewInput {
  readonly schemaVersion: 2
  readonly command: string
  readonly resources: readonly string[]
  readonly cwdRelative: string
  readonly workspaceLabel: string
  readonly localFacts: {
    readonly scopeAuthorized: true
    readonly commandComplete: true
    readonly sensitiveDataDetected: false
  }
}

/** Validated reviewer assessment (schemas/assessment.schema.json + coherence rules). */
export interface Assessment {
  readonly schemaVersion: 2
  readonly risk: Risk
  readonly categories: readonly Category[]
  readonly confidence: Confidence
  readonly signals: readonly Signal[]
  readonly summary: string
}

export type ReviewerFailure =
  | { readonly kind: "timeout" }
  | { readonly kind: "transport"; readonly message: string; readonly code?: string }

export type ReviewerResult = { readonly ok: true; readonly text: string } | ReviewerFailure

/** Stateless single-call reviewer port bound to one chain model; the escalation chain lives in the controller. */
export interface ReviewerPort {
  readonly assess: (input: ReviewInput, signal: AbortSignal) => Promise<ReviewerResult>
}

export interface AuditRecord {
  readonly schemaVersion: 2
  readonly timestamp: string
  readonly requestID: string
  readonly inputFingerprint: string | null
  readonly mode: GuardMode
  readonly outcome: Outcome
  readonly reasonCode: ReasonCode
  /** Model of the deciding stage (the last attempted one on escalation chains). */
  readonly model: ModelRef | null
  /** Physical reviewer calls for this event; present only when > 1 (D3 escalation). */
  readonly attemptCount?: number
  readonly latencyMs: number
  readonly policyVersion: "graduated-v1"
}

export interface AuditPort {
  readonly append: (record: AuditRecord) => Promise<void>
  /** Optional pre-classification availability probe; false → ask without any LLM call (docs/04). */
  readonly healthy?: () => Promise<boolean>
}

/** One physical reviewer call inside an event's chain (D3): the model asked, its latency, raw text and parsed verdict. */
export interface TraceAttempt {
  readonly model: ModelRef
  readonly llmLatencyMs: number
  readonly rawResponse: string | null
  readonly parseOk: boolean
  readonly assessment: Assessment | null
}

/**
 * Opt-in diagnostics trace (docs/07): one record per decided permission event.
 * Post-LLM records (llmCalled: true) carry the complete LLM I/O pair — the
 * exact ReviewInput fields sent to the reviewer, per-attempt raw responses
 * (null when a call never produced one) and the resulting decision; the
 * top-level rawResponse/parseOk/assessment mirror the LAST attempt, model is
 * the deciding stage and llmLatencyMs is the sum over attempts. Pre-LLM
 * records (llmCalled: false) explain why an event never reached the reviewer:
 * preflight stops keep the raw command/resources unless the input is
 * secret-looking (then only the fingerprint, on ANY stop reason); non-shell
 * actions keep only the action name; INPUT_MISMATCH stops carry mismatchDetail
 * naming the failed binding condition. Records are written best-effort AFTER
 * the outcome is known; a trace failure never changes any effect. Default:
 * disabled.
 */
export interface TraceRecord {
  readonly traceVersion: 4
  readonly timestamp: string
  /** False for pre-LLM stops: no reviewer call happened for this event. */
  readonly llmCalled: boolean
  readonly inputFingerprint: string | null
  readonly mode: GuardMode
  readonly model: ModelRef | null
  /** Permission action name ("shell" for the classified path, other names for skipped non-shell events). */
  readonly action: string
  /** Raw command; null when unknown (non-shell events) or redacted (secret-looking input). */
  readonly command: string | null
  readonly resources: readonly string[]
  /** Relative cwd sent to the reviewer; null for pre-LLM records (not computed). */
  readonly cwdRelative: string | null
  readonly workspaceLabel: string | null
  readonly promptSha256: string | null
  readonly llmLatencyMs: number
  readonly rawResponse: string | null
  readonly parseOk: boolean
  readonly assessment: Assessment | null
  /** True when more than one chain stage was physically called (D3). */
  readonly escalated: boolean
  /** Physical calls in chain order; empty for pre-LLM stops. */
  readonly attempts: readonly TraceAttempt[]
  readonly outcome: Outcome
  readonly reasonCode: ReasonCode
  /** Present only on INPUT_MISMATCH stops: which binding condition failed (D5). */
  readonly mismatchDetail?: InputMismatchDetail
  readonly totalLatencyMs: number
  readonly policyVersion: "graduated-v1"
}

/** Best-effort diagnostics sink; append failures are swallowed by the controller (unlike the audit port). */
export interface TracePort {
  readonly append: (record: TraceRecord) => Promise<void>
}

/** Final controller instruction to the adapter. Anything but "allow" leaves the event untouched. */
export type AdapterDirective =
  | { readonly commit: "unchanged" }
  | { readonly commit: "allow"; readonly message: string }
