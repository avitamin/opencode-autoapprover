/**
 * Controller (docs/02, docs/07): per-request lifecycle
 * captured → preflight → classifying → validated → final-check → audit-prepared → committed
 * with terminal ask from any incomplete state. Only this module can issue the
 * final "allow" commit instruction, after every gate and a successful audit
 * append, while the request is still active.
 */
import { createHash, randomUUID as nodeRandomUUID } from "node:crypto"
import { parseAssessmentText } from "./assessment.js"
import { DEFAULT_ESCALATION_TIMEOUT_MS, KILL_SWITCH_ENV, effectiveEscalation, reviewerChain } from "./config.js"
import type { EffectiveEscalation } from "./config.js"
import { detectSecretLike, runPreflight } from "./preflight.js"
import { mapAssessmentToThreshold } from "./threshold.js"
import type {
  AdapterDirective,
  Assessment,
  AuditPort,
  AuditRecord,
  AutoAllowPolicy,
  GuardConfig,
  GuardConfigState,
  GuardMode,
  InputMismatchDetail,
  ModelRef,
  Outcome,
  PermissionEventView,
  ReasonCode,
  ReviewInput,
  ReviewerPort,
  ToolSnapshot,
  TraceAttempt,
  TracePort,
  TraceRecord,
} from "./types.js"

const REGISTRY_CAP = 256
const ENTRY_TTL_MS = 60_000
const RATE_WINDOW_MS = 60_000
/** An escalation stage is started only when the remaining hook budget leaves it a meaningful slice (docs/07). */
const MIN_STAGE_BUDGET_MS = 1_000

/**
 * D7: a verdict is authorized against the category allowlist of the stage that
 * produced it — an escalation-stage verdict may carry the extended
 * escalation.allowedCategories set, the primary only the global one (docs/04).
 * With no escalation, or the default inherited set, this is the global policy.
 */
function stagePolicy(config: GuardConfig, escalation: EffectiveEscalation | null, stage: number): AutoAllowPolicy {
  if (stage === 0 || escalation === null) return config.policy.autoAllow
  return {
    maxRisk: config.policy.autoAllow.maxRisk,
    minConfidence: config.policy.autoAllow.minConfidence,
    allowedCategories: escalation.allowedCategories,
  }
}

export interface ControllerDeps {
  readonly config: GuardConfigState
  /**
   * Reviewer transport factory, one port per chain model (primary first, then
   * escalation stages, D3). The controller asks for a model only when its
   * stage actually starts; null → MODEL_UNAVAILABLE ask without any call.
   */
  readonly reviewerFor: (model: ModelRef) => ReviewerPort | null
  readonly audit: AuditPort
  /** Milliseconds since an arbitrary epoch; monotonic within a process. */
  readonly clock: () => number
  readonly isoNow: () => string
  readonly env: () => Readonly<Record<string, string | undefined>>
  readonly randomUUID: () => string
  /** Fixed in tests; random per process in production. Never written to the audit log. */
  readonly fingerprintSalt: string
  /** Sensitive absolute directories (guard/OpenCode config) for scope admission. */
  readonly guardConfigDirs: readonly string[]
  /** Location directory of the plugin: effective cwd fallback for shell input without workdir. */
  readonly locationDirectory: string
  /** Host/runtime qualification (M0-style probe result); false → ask without LLM (HOST_UNVERIFIED). */
  readonly platformQualified?: boolean
  /** No other permission-mutating plugin registered; false → PLUGIN_CONFLICT ask. */
  readonly noConflictingPlugins?: boolean
  /** Configured model id/variant present in the host catalog; false → MODEL_UNAVAILABLE ask without LLM. */
  readonly modelAvailable?: boolean
  /**
   * Opt-in diagnostics trace (docs/07): complete LLM I/O pairs for admitted
   * assessments. Absent/null → no trace. Best-effort: failures never affect
   * any decision and appends are never awaited on the decision path.
   */
  readonly trace?: TracePort | null
  /** SHA-256 of the reviewer instruction in effect; null when unavailable. */
  readonly promptSha256?: string | null
}

interface ActiveEntry {
  readonly snapshot: ToolSnapshot
  readonly fingerprint: string
  phase: "captured" | "classifying" | "decided" | "done"
  used: boolean
  abort: AbortController | null
}

export class GuardController {
  private readonly active = new Map<string, ActiveEntry>()
  private readonly tombstones = new Map<string, number>()
  private readonly rateStamps: number[] = []
  private inFlight = 0
  private generation = 0
  private invalidationReason: "UNLOAD" | "SNAPSHOT_CHANGED" = "UNLOAD"
  private unloaded = false

  constructor(private readonly deps: ControllerDeps) {}

  /** Tool-hook capture: full input keyed by the stable tool call ID. */
  captureSnapshot(snapshot: ToolSnapshot): void {
    if (this.unloaded) return
    this.pruneExpired()
    if (this.active.size >= REGISTRY_CAP) {
      // Overflow never evicts active entries to make room for allow: the new request gets ask.
      return
    }
    this.active.set(snapshot.toolCallID, {
      snapshot,
      fingerprint: snapshotFingerprint(snapshot, this.deps.fingerprintSalt),
      phase: "captured",
      used: false,
      abort: null,
    })
  }

  /** Tool completion/error: release the snapshot, keep a short tombstone. */
  releaseSnapshot(toolCallID: string): void {
    const entry = this.active.get(toolCallID)
    if (entry !== undefined) {
      entry.abort?.abort()
      entry.phase = "done"
      this.active.delete(toolCallID)
    }
    this.rememberTombstone(toolCallID)
  }

  unload(): void {
    this.unloaded = true
    this.invalidateGeneration("UNLOAD")
    for (const entry of this.active.values()) {
      entry.abort?.abort()
      entry.phase = "done"
    }
    this.active.clear()
  }

  /**
   * Invalidate in-flight generations (model/policy snapshot changed, unload).
   * In-flight requests fail their final checks with the given reason; new
   * requests were never holding the old token.
   */
  invalidateGeneration(reason: "UNLOAD" | "SNAPSHOT_CHANGED"): void {
    this.generation++
    this.invalidationReason = reason
  }

  private killSwitchActive(): boolean {
    return this.deps.env()[KILL_SWITCH_ENV] === "1"
  }

  private rememberTombstone(toolCallID: string): void {
    if (this.tombstones.size >= REGISTRY_CAP) {
      const oldest = this.tombstones.keys().next().value
      if (typeof oldest === "string") this.tombstones.delete(oldest)
    }
    this.tombstones.set(toolCallID, this.deps.clock() + ENTRY_TTL_MS)
  }

  private pruneExpired(): void {
    const now = this.deps.clock()
    for (const [id, expiry] of this.tombstones) {
      if (expiry <= now) this.tombstones.delete(id)
    }
    for (const [id, entry] of this.active) {
      if (ENTRY_TTL_MS <= now - entry.snapshot.capturedAt) {
        entry.abort?.abort()
        entry.phase = "done"
        this.active.delete(id)
      }
    }
  }

  private rateLimited(now: number, config: GuardConfig): boolean {
    while (this.rateStamps.length > 0 && this.rateStamps[0]! <= now - RATE_WINDOW_MS) this.rateStamps.shift()
    return this.rateStamps.length >= config.limits.maxAssessmentsPerMinute
  }

  private buildAuditRecord(
    mode: GuardMode,
    outcome: Outcome,
    reason: ReasonCode,
    start: number,
    model: GuardConfig["model"] | null,
    inputFingerprint: string | null,
    attemptCount?: number,
  ): AuditRecord {
    return {
      schemaVersion: 2,
      timestamp: this.deps.isoNow(),
      requestID: this.deps.randomUUID(),
      inputFingerprint,
      mode,
      outcome,
      reasonCode: reason,
      model,
      ...(attemptCount !== undefined && attemptCount > 1 ? { attemptCount } : {}),
      latencyMs: Math.max(0, this.deps.clock() - start),
      policyVersion: "graduated-v1",
    }
  }

  /** Best-effort audit for paths that already end in ask; a failure here cannot change safety. */
  private auditBestEffort(
    mode: GuardMode,
    outcome: Outcome,
    reason: ReasonCode,
    start: number,
    model: GuardConfig["model"] | null,
    inputFingerprint: string | null,
    attemptCount?: number,
  ): void {
    if (process.env.OPENCODE_LLM_APPROVAL_DEBUG === "1") {
      console.error(`[llm-approval] audit best-effort: ${mode}/${outcome}/${reason}`)
    }
    void this.deps.audit
      .append(this.buildAuditRecord(mode, outcome, reason, start, model, inputFingerprint, attemptCount))
      .catch((error) => {
        if (process.env.OPENCODE_LLM_APPROVAL_DEBUG === "1") {
          console.error(`[llm-approval] audit append failed: ${String(error)}`)
        }
      })
  }

  /**
   * Best-effort diagnostics trace for the reviewer chain of one admitted
   * assessment (docs/07): every physical attempt with its model, latency, raw
   * response and verdict, plus the final outcome. Top-level fields mirror the
   * LAST attempt; llmLatencyMs is the sum over attempts. Called only after
   * the outcome is known; the append is fire-and-forget, so the hook deadline
   * is never spent on the trace sink. A broken trace cannot change any effect.
   */
  private traceLlm(input: {
    readonly config: GuardConfig
    readonly fingerprint: string | null
    readonly review: ReviewInput
    readonly start: number
    readonly attempts: readonly TraceAttempt[]
    readonly outcome: Outcome
    readonly reason: ReasonCode
  }): void {
    const trace = this.deps.trace
    if (trace === undefined || trace === null) return
    const last = input.attempts[input.attempts.length - 1]!
    const record: TraceRecord = {
      traceVersion: 4,
      timestamp: this.deps.isoNow(),
      llmCalled: true,
      inputFingerprint: input.fingerprint,
      mode: input.config.mode,
      model: last.model,
      action: "shell",
      command: input.review.command,
      resources: input.review.resources,
      cwdRelative: input.review.cwdRelative,
      workspaceLabel: input.review.workspaceLabel,
      promptSha256: this.deps.promptSha256 ?? null,
      llmLatencyMs: input.attempts.reduce((sum, attempt) => sum + attempt.llmLatencyMs, 0),
      rawResponse: last.rawResponse,
      parseOk: last.parseOk,
      assessment: last.assessment,
      escalated: input.attempts.length > 1,
      attempts: [...input.attempts],
      outcome: input.outcome,
      reasonCode: input.reason,
      totalLatencyMs: Math.max(0, this.deps.clock() - input.start),
      policyVersion: "graduated-v1",
    }
    if (process.env.OPENCODE_LLM_APPROVAL_DEBUG === "1") {
      console.error(`[llm-approval] trace: ${record.mode}/${record.outcome}/${record.reasonCode}/${record.attempts.length}attempts`)
    }
    void trace.append(record).catch((error) => {
      if (process.env.OPENCODE_LLM_APPROVAL_DEBUG === "1") {
        console.error(`[llm-approval] trace append failed: ${String(error)}`)
      }
    })
  }

  /**
   * Best-effort diagnostics trace for pre-LLM stops (docs/07): explains why an
   * event never reached the reviewer. Preflight stops keep the raw command and
   * resources — unless the input is secret-looking, which is redacted to the
   * fingerprint on ANY stop reason (the secret prefilter only runs at gate 4,
   * after binding/size stops, so the trace must not rely on the stop reason);
   * non-shell actions keep only the action name (no snapshot exists for them).
   * Same fire-and-forget contract as traceLlm: never awaited on the decision
   * path, failures change nothing.
   */
  private traceStop(input: {
    readonly mode: GuardMode
    readonly model: GuardConfig["model"] | null
    readonly fingerprint: string | null
    readonly action: string
    readonly command: string | null
    readonly resources: readonly string[]
    readonly start: number
    readonly outcome: Outcome
    readonly reason: ReasonCode
    readonly mismatchDetail?: InputMismatchDetail
  }): void {
    const trace = this.deps.trace
    if (trace === undefined || trace === null) return
    const secretLike =
      input.command !== null && (detectSecretLike(input.command) || input.resources.some((resource) => detectSecretLike(resource)))
    const record: TraceRecord = {
      traceVersion: 4,
      timestamp: this.deps.isoNow(),
      llmCalled: false,
      inputFingerprint: input.fingerprint,
      mode: input.mode,
      model: input.model,
      action: input.action,
      command: secretLike ? null : input.command,
      resources: secretLike ? [] : input.resources,
      cwdRelative: null,
      workspaceLabel: null,
      promptSha256: this.deps.promptSha256 ?? null,
      llmLatencyMs: 0,
      rawResponse: null,
      parseOk: false,
      assessment: null,
      escalated: false,
      attempts: [],
      outcome: input.outcome,
      reasonCode: input.reason,
      ...(input.mismatchDetail !== undefined ? { mismatchDetail: input.mismatchDetail } : {}),
      totalLatencyMs: Math.max(0, this.deps.clock() - input.start),
      policyVersion: "graduated-v1",
    }
    if (process.env.OPENCODE_LLM_APPROVAL_DEBUG === "1") {
      console.error(`[llm-approval] trace stop: ${record.action}/${record.outcome}/${record.reasonCode}${record.mismatchDetail !== undefined ? `/${record.mismatchDetail}` : ""}`)
    }
    void trace.append(record).catch((error) => {
      if (process.env.OPENCODE_LLM_APPROVAL_DEBUG === "1") {
        console.error(`[llm-approval] trace append failed: ${String(error)}`)
      }
    })
  }

  /**
   * Handle a permission evaluate event. Returns the instruction for the adapter;
   * the SDK event object itself is never touched here (docs/02: decision transfer).
   */
  async handleEvaluate(event: PermissionEventView): Promise<AdapterDirective> {
    if (process.env.OPENCODE_LLM_APPROVAL_DEBUG === "1") {
      console.error(`[llm-approval] evaluate: action=${event.action} effect=${event.effect}`)
    }
    const start = this.deps.clock()

    if (event.action !== "shell") {
      // Thin record: no snapshot exists for non-shell actions, so only the action name is traced.
      this.traceStop({
        mode: this.effectiveMode(),
        model: null,
        fingerprint: null,
        action: event.action,
        command: null,
        resources: [],
        start,
        outcome: "skipped",
        reason: "UNKNOWN_ACTION",
      })
      this.auditBestEffort(this.effectiveMode(), "skipped", "UNKNOWN_ACTION", start, null, null)
      return UNCHANGED
    }
    if (event.effect === "allow") {
      this.auditBestEffort(this.effectiveMode(), "skipped", "NATIVE_ALLOW", start, null, null)
      return UNCHANGED
    }
    if (event.effect === "deny") {
      this.auditBestEffort(this.effectiveMode(), "skipped", "NATIVE_DENY", start, null, null)
      return UNCHANGED
    }

    if (this.killSwitchActive()) {
      this.auditBestEffort(this.effectiveMode(), "ask", "KILL_SWITCH", start, null, null)
      return UNCHANGED
    }
    if (this.deps.config.status !== "active") {
      this.auditBestEffort("off", "ask", "CONFIG_INVALID", start, null, null)
      return UNCHANGED
    }
    const config = this.deps.config.config
    if (config.mode === "off") {
      this.auditBestEffort("off", "skipped", "MODE_OFF", start, null, null)
      return UNCHANGED
    }
    if (this.unloaded) {
      this.auditBestEffort(config.mode, "ask", "UNLOAD", start, null, null)
      return UNCHANGED
    }
    if (this.deps.platformQualified === false) {
      this.auditBestEffort(config.mode, "ask", "HOST_UNVERIFIED", start, null, null)
      return UNCHANGED
    }
    if (this.deps.noConflictingPlugins === false) {
      this.auditBestEffort(config.mode, "ask", "PLUGIN_CONFLICT", start, null, null)
      return UNCHANGED
    }
    if (this.deps.modelAvailable === false) {
      this.auditBestEffort(config.mode, "ask", "MODEL_UNAVAILABLE", start, config.model, null)
      return UNCHANGED
    }
    const auditHealthy = this.deps.audit.healthy
    if (auditHealthy !== undefined && !(await auditHealthy.call(this.deps.audit))) {
      // Unavailable audit sink → ask before any LLM call (docs/04).
      this.auditBestEffort(config.mode, "ask", "AUDIT_ERROR", start, null, null)
      return UNCHANGED
    }

    this.pruneExpired()
    const key = event.sourceToolCallID
    if (key === null) {
      this.auditBestEffort(config.mode, "ask", "INPUT_UNBOUND", start, null, null)
      return UNCHANGED
    }
    if (this.tombstones.has(key)) {
      // Completed key seen again → ask without a new LLM call (docs/07).
      this.auditBestEffort(config.mode, "ask", "DUPLICATE_EVENT", start, null, null)
      return UNCHANGED
    }
    const entry = this.active.get(key)
    if (entry === undefined) {
      this.auditBestEffort(config.mode, "ask", "INPUT_UNBOUND", start, null, null)
      return UNCHANGED
    }
    if (entry.used) {
      // Repeated processing of the same key while still active → ask without a new LLM call.
      this.auditBestEffort(config.mode, "ask", "DUPLICATE_EVENT", start, null, entry.fingerprint)
      return UNCHANGED
    }

    const preflight = runPreflight(entry.snapshot, event, config.policy, config.limits, {
      effectiveCwd: entry.snapshot.workdir ?? this.deps.locationDirectory,
      allowCommandTransmission: config.privacy.allowCommandTransmission,
      guardConfigDirs: this.deps.guardConfigDirs,
    })
    if (!preflight.ok) {
      entry.used = true
      entry.phase = "done"
      this.active.delete(key)
      this.rememberTombstone(key)
      // traceStop itself redacts secret-looking input to the fingerprint: the
      // secret prefilter (gate 4) has not run yet for binding/size stops.
      this.traceStop({
        mode: config.mode,
        model: config.model,
        fingerprint: entry.fingerprint,
        action: "shell",
        command: entry.snapshot.command,
        resources: event.resources,
        start,
        outcome: "ask",
        reason: preflight.reason,
        ...(preflight.detail !== undefined ? { mismatchDetail: preflight.detail } : {}),
      })
      this.auditBestEffort(config.mode, "ask", preflight.reason, start, null, entry.fingerprint)
      return UNCHANGED
    }

    const now = this.deps.clock()
    if (this.rateLimited(now, config)) {
      this.finishEntry(key, entry)
      this.auditBestEffort(config.mode, "ask", "RATE_LIMIT", start, null, entry.fingerprint)
      return UNCHANGED
    }
    if (this.inFlight >= config.limits.maxInFlight) {
      this.finishEntry(key, entry)
      this.auditBestEffort(config.mode, "ask", "CONCURRENCY_LIMIT", start, null, entry.fingerprint)
      return UNCHANGED
    }

    // One admitted assessment: consume the entry, occupy a slot, start the clocks.
    entry.used = true
    entry.phase = "classifying"
    const abort = new AbortController()
    entry.abort = abort
    const generation = this.generation
    this.inFlight++
    this.rateStamps.push(now)
    const deadlineAt = start + config.limits.hookDeadlineMs

    try {
      const chain = reviewerChain(config)
      const escalation = effectiveEscalation(config)
      const attempts: TraceAttempt[] = []
      let stopReason: ReasonCode = "INTERNAL_ERROR"
      // Set when a stage produced a conclusive verdict — the only path that may leave ask.
      let conclusive: { readonly text: string; readonly assessment: Assessment } | null = null
      // D7: the final verdict is judged by the producing stage's own category set.
      let conclusiveStage = 0

      for (let stage = 0; stage < chain.length; stage++) {
        const model = chain[stage]!
        const reviewer = this.deps.reviewerFor(model)
        if (reviewer === null) {
          // Transport/instruction unavailable for this stage (docs/06): ask, no further calls.
          stopReason = "MODEL_UNAVAILABLE"
          break
        }
        const remaining = deadlineAt - this.deps.clock()
        const stageBudget = Math.min(
          stage === 0 ? config.limits.llmTimeoutMs : (escalation?.timeoutMs ?? DEFAULT_ESCALATION_TIMEOUT_MS),
          remaining,
        )

        const llmStart = this.deps.clock()
        const result = await this.callReviewerOnce(reviewer, preflight.review, abort, stageBudget)
        const latency = Math.max(0, this.deps.clock() - llmStart)

        if (result === "timeout-or-cancelled") {
          attempts.push({ model, llmLatencyMs: latency, rawResponse: null, parseOk: false, assessment: null })
          // The shared abort controller fired: no further stage can start.
          stopReason = this.generation !== generation ? this.invalidationReason : "TIMEOUT"
          break
        }
        if ("kind" in result) {
          attempts.push({ model, llmLatencyMs: latency, rawResponse: null, parseOk: false, assessment: null })
          // Transport failures are infrastructure errors, not unknown verdicts: never retried (FR-11).
          stopReason = result.kind === "timeout" ? "TIMEOUT" : result.code === "429" ? "RATE_LIMIT" : "PROVIDER_ERROR"
          break
        }
        const oversized = new TextEncoder().encode(result.text).length > config.limits.maxResponseBytes
        const validation = oversized ? ({ ok: false } as const) : parseAssessmentText(result.text)
        if (!validation.ok) {
          attempts.push({ model, llmLatencyMs: latency, rawResponse: result.text, parseOk: false, assessment: null })
          if (this.nextStageAllowed(stage, chain, generation, deadlineAt) && (escalation?.triggerOn.invalidResponse ?? true)) continue
          stopReason = oversized ? "PAYLOAD_TOO_LARGE" : "INVALID_RESPONSE"
          break
        }
        const assessment = validation.assessment
        attempts.push({ model, llmLatencyMs: latency, rawResponse: result.text, parseOk: true, assessment })
        // An inconclusive verdict (UNKNOWN risk / LOW confidence) makes the whole assessment
        // unreliable, risk included: one bounded re-ask on the next chain model (D3, docs/06).
        const inconclusive =
          escalation !== null &&
          ((assessment.risk === "UNKNOWN" && escalation.triggerOn.unknownRisk) ||
            (assessment.confidence === "LOW" && escalation.triggerOn.lowConfidence))
        // D7: a stage-0 verdict that fails only the global category set — and would fully
        // pass the escalation one — is deferred to the next chain model: extra categories
        // may be auto-allowed only by an escalation-stage verdict. Risk/confidence failures
        // never defer; the threshold already rejected the verdict on a stricter axis.
        const deferredByCategory =
          stage === 0 &&
          escalation !== null &&
          !inconclusive &&
          mapAssessmentToThreshold(assessment, config.policy.autoAllow).reason === "CATEGORY_NOT_ALLOWED" &&
          mapAssessmentToThreshold(assessment, stagePolicy(config, escalation, 1)).withinThreshold
        if (!inconclusive && !deferredByCategory) {
          conclusive = { text: result.text, assessment }
          conclusiveStage = stage
          break
        }
        if (this.nextStageAllowed(stage, chain, generation, deadlineAt)) continue
        // Chain exhausted or out of budget: judged by the producing stage's own set.
        stopReason = mapAssessmentToThreshold(assessment, stagePolicy(config, escalation, stage)).reason
        break
      }

      if (attempts.length === 0) {
        // No physical call happened (MODEL_UNAVAILABLE before the first attempt): nothing to trace.
        this.auditBestEffort(config.mode, "ask", stopReason, start, config.model, entry.fingerprint)
        return UNCHANGED
      }
      const finalModel = attempts[attempts.length - 1]!.model
      const attemptCount = attempts.length

      if (conclusive === null) {
        this.traceLlm({
          config,
          fingerprint: entry.fingerprint,
          review: preflight.review,
          start,
          attempts,
          outcome: "ask",
          reason: stopReason,
        })
        this.auditBestEffort(config.mode, "ask", stopReason, start, finalModel, entry.fingerprint, attemptCount)
        return UNCHANGED
      }
      const threshold = mapAssessmentToThreshold(conclusive.assessment, stagePolicy(config, escalation, conclusiveStage))
      if (!threshold.withinThreshold) {
        this.traceLlm({
          config,
          fingerprint: entry.fingerprint,
          review: preflight.review,
          start,
          attempts,
          outcome: "ask",
          reason: threshold.reason,
        })
        this.auditBestEffort(config.mode, "ask", threshold.reason, start, finalModel, entry.fingerprint, attemptCount)
        return UNCHANGED
      }
      entry.phase = "decided"

      if (config.mode === "shadow") {
        this.traceLlm({
          config,
          fingerprint: entry.fingerprint,
          review: preflight.review,
          start,
          attempts,
          outcome: "shadow_would_allow",
          reason: "RISK_WITHIN_THRESHOLD",
        })
        this.auditBestEffort(config.mode, "shadow_would_allow", "RISK_WITHIN_THRESHOLD", start, finalModel, entry.fingerprint, attemptCount)
        return UNCHANGED
      }

      // Auto mode: final checks → durable audit append → synchronous re-checks → commit instruction.
      const invalidated = (): ReasonCode | null => {
        if (this.generation !== generation) return this.invalidationReason
        if (this.active.get(key) !== entry) return "SNAPSHOT_CHANGED"
        if (this.killSwitchActive()) return "KILL_SWITCH"
        if (this.deps.clock() >= deadlineAt) return "TIMEOUT"
        return null
      }
      const preAuditFailure = invalidated()
      if (preAuditFailure !== null) {
        this.traceLlm({
          config,
          fingerprint: entry.fingerprint,
          review: preflight.review,
          start,
          attempts,
          outcome: "ask",
          reason: preAuditFailure,
        })
        this.auditBestEffort(config.mode, "ask", preAuditFailure, start, finalModel, entry.fingerprint, attemptCount)
        return UNCHANGED
      }
      try {
        await this.deps.audit.append(
          this.buildAuditRecord(config.mode, "allow_prepared", "RISK_WITHIN_THRESHOLD", start, finalModel, entry.fingerprint, attemptCount),
        )
      } catch {
        // Broken sink is not written into itself (docs/07); the trace still records the LLM I/O.
        this.traceLlm({
          config,
          fingerprint: entry.fingerprint,
          review: preflight.review,
          start,
          attempts,
          outcome: "ask",
          reason: "AUDIT_ERROR",
        })
        return UNCHANGED
      }
      const postAuditFailure = invalidated()
      if (postAuditFailure !== null) {
        // allow_prepared is written but NOT applied: it never means allow was committed.
        this.traceLlm({
          config,
          fingerprint: entry.fingerprint,
          review: preflight.review,
          start,
          attempts,
          outcome: "ask",
          reason: postAuditFailure,
        })
        return UNCHANGED
      }
      this.traceLlm({
        config,
        fingerprint: entry.fingerprint,
        review: preflight.review,
        start,
        attempts,
        outcome: "allow_prepared",
        reason: "RISK_WITHIN_THRESHOLD",
      })
      entry.phase = "done"
      return {
        commit: "allow",
        message: "opencode-llm-approval: within operator threshold; audit recorded",
      }
    } finally {
      this.inFlight--
      this.finishEntry(key, entry)
    }
  }

  private finishEntry(key: string, entry: ActiveEntry): void {
    entry.abort?.abort()
    entry.phase = "done"
    this.active.delete(key)
    this.rememberTombstone(key)
  }

  /**
   * Exactly one reviewer call, raced against the LLM deadline and abort.
   * A late resolve/reject of the losing call is swallowed without side effects
   * and without unhandled rejections (docs/07).
   */
  private async callReviewerOnce(
    reviewer: ReviewerPort,
    input: ReviewInput,
    abort: AbortController,
    llmDeadlineMs: number,
  ): Promise<ReviewerCallResult> {
    if (abort.signal.aborted) return "timeout-or-cancelled"
    return await new Promise<ReviewerCallResult>((resolve) => {
      let settled = false
      const settle = (value: ReviewerCallResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        abort.signal.removeEventListener("abort", onAbort)
        resolve(value)
      }
      const timer = setTimeout(() => {
        abort.abort()
        settle("timeout-or-cancelled")
      }, llmDeadlineMs)
      const onAbort = (): void => settle("timeout-or-cancelled")
      abort.signal.addEventListener("abort", onAbort, { once: true })
      reviewer
        .assess(input, abort.signal)
        .then((result) => settle(result), () => settle({ kind: "transport", message: "reviewer call rejected" }))
    })
  }

  /**
   * Whether the next escalation stage may start (docs/07): a next model
   * exists, the request generation is still current, and the remaining hook
   * budget still leaves the stage a meaningful slice. Never reached after an
   * abort-based stop — the shared controller is already fired there.
   */
  private nextStageAllowed(stage: number, chain: readonly ModelRef[], generation: number, deadlineAt: number): boolean {
    if (stage + 1 >= chain.length) return false
    if (this.generation !== generation) return false
    return this.deps.clock() + MIN_STAGE_BUDGET_MS <= deadlineAt
  }

  private effectiveMode(): GuardMode {
    return this.deps.config.status === "active" ? this.deps.config.config.mode : "off"
  }
}

type ReviewerCallResult =
  | { readonly ok: true; readonly text: string }
  | { readonly kind: "timeout" }
  | { readonly kind: "transport"; readonly message: string; readonly code?: string }
  | "timeout-or-cancelled"

const UNCHANGED: AdapterDirective = { commit: "unchanged" }

/**
 * Binding fingerprint of a captured snapshot (docs/03): hashes the correlation
 * ids, the full command, the workdir and every documented envelope value, so
 * the guard stays bound to the COMPLETE captured input (D5). Salted per
 * process; only the digest is ever written to audit/trace.
 */
export function snapshotFingerprint(snapshot: ToolSnapshot, salt: string): string {
  const envelope: Record<string, string | number | boolean> = {}
  for (const key of Object.keys(snapshot.envelope).sort()) {
    envelope[key] = snapshot.envelope[key]!
  }
  const canonical = JSON.stringify({
    toolCallID: snapshot.toolCallID,
    sessionID: snapshot.sessionID,
    messageID: snapshot.messageID,
    command: snapshot.command,
    workdir: snapshot.workdir,
    envelope,
  })
  return createHash("sha256").update(`${salt}:${canonical}`).digest("hex")
}

export function randomFingerprintSalt(): string {
  return nodeRandomUUID()
}
