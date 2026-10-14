/**
 * SDK adapter (docs/02, docs/03): the ONLY module that touches the OpenCode SDK.
 * - Typed, structural read-subsets of the documented event shapes (no `any`).
 * - Full tool input is captured from execute.before; permission evaluate is
 *   correlated by the stable tool-call ID and only then handed to the controller.
 * - The adapter mutates ONLY effect/message, and only on a controller commit.
 */
import { createHash } from "node:crypto"
import { lstatSync, readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { FileAuditWriter } from "../audit.js"
import { loadGuardConfig, resolveConfigPath, reviewerChain, type ConfigDeps, type PathStat } from "../config.js"
import { GuardController, randomFingerprintSalt, type ControllerDeps } from "../controller.js"
import { GenerateTextReviewer, type GenerateTextLike } from "./generate-reviewer.js"
import { FileTraceWriter } from "../trace.js"
import type {
  AuditPort,
  Effect,
  GuardConfig,
  GuardConfigState,
  ModelRef,
  PermissionEventView,
  ReviewerPort,
  ToolSnapshot,
  TracePort,
} from "../types.js"

/** Structural read/mutate subset of the SDK PermissionEvaluation (source ids are documented stable). */
export interface SdkPermissionEventLike {
  readonly sessionID: string
  readonly agent?: string
  readonly action: string
  readonly resources: readonly string[]
  readonly metadata?: Record<string, unknown>
  readonly source?: { readonly type: string; readonly messageID: string; readonly id: string }
  effect: Effect
  message?: string
}

/** Structural read subset of the SDK execute.before event (id = Tool.CallID). */
export interface SdkToolBeforeEventLike {
  readonly tool: string
  readonly sessionID: string
  readonly agent: string
  readonly messageID: string
  readonly id: string
  readonly input: unknown
}

/** Structural read subset of the SDK execute.after event. */
export interface SdkToolAfterEventLike {
  readonly tool: string
  readonly id: string
}

export interface RegistrationLike {
  readonly dispose: () => Promise<void>
}

/** Structural read subset of the SDK model.list output used for availability gating. */
export interface SdkModelListLike {
  list: () => Promise<{ readonly data: readonly { readonly id: string; readonly providerID: string; readonly variants?: readonly { readonly id: string }[] }[] }>
}

/** The host surface the guard needs; satisfied structurally by Plugin.Context. */
export interface GuardHostSurface {
  readonly location: { readonly directory: string }
  /**
   * Directory of the installed plugin itself (import.meta-based), where
   * prompts/ ships. Optional: a missing prompt file → reviewer unavailable.
   */
  readonly pluginDirectory?: string
  readonly permission: {
    readonly hook: (
      name: "evaluate",
      callback: (event: SdkPermissionEventLike) => Promise<void> | void,
    ) => Promise<RegistrationLike>
  }
  readonly tool: {
    hook(
      name: "execute.before",
      callback: (event: SdkToolBeforeEventLike) => Promise<void> | void,
    ): Promise<RegistrationLike>
    hook(
      name: "execute.after",
      callback: (event: SdkToolAfterEventLike) => Promise<void> | void,
    ): Promise<RegistrationLike>
  }
  /** Stateless generation transport (docs/06). Absent → reviewer null → ask/MODEL_UNAVAILABLE. */
  readonly generate?: GenerateTextLike
  /** Model catalog for the configured-model availability gate; absence of the API is not a failure. */
  readonly model?: SdkModelListLike
}

export function toPermissionEventView(event: SdkPermissionEventLike): PermissionEventView {
  const source = event.source
  return {
    sessionID: event.sessionID,
    agent: event.agent ?? null,
    action: event.action,
    resources: [...event.resources],
    effect: event.effect,
    message: event.message ?? null,
    sourceToolCallID: source !== undefined && source.type === "tool" ? source.id : null,
    sourceMessageID: source !== undefined && source.type === "tool" ? source.messageID : null,
  }
}

/**
 * Documented shell-tool input contract beyond {command, workdir} (docs/03,
 * compatibility/host-contract.json fieldMapping): host-side execution envelope
 * keys observed in the qualified host's shell tool schema. They cannot alter
 * the transmitted command semantics; their values are captured into the
 * snapshot envelope, bound by the fingerprint and never sent to the reviewer.
 * A key present with a contract-violating value type is treated as unknown
 * (→ INPUT_MISMATCH), as is any key outside this contract.
 */
const SHELL_ENVELOPE_INPUT_KEYS: Readonly<Record<string, "number" | "boolean" | "string">> = {
  timeout: "number",
  background: "boolean",
}

/**
 * Narrow the unknown tool input (docs/03). Documented envelope keys with
 * conforming types are bound; anything else makes the request ineligible.
 */
export function toToolSnapshot(event: SdkToolBeforeEventLike, capturedAt: number): ToolSnapshot | null {
  const input = event.input
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null
  const record = input as Record<string, unknown>
  const command = record["command"]
  if (typeof command !== "string") return null
  const workdir = record["workdir"]
  const knownKeys = new Set<string>(["command", "workdir", ...Object.keys(SHELL_ENVELOPE_INPUT_KEYS)])
  const envelope: Record<string, string | number | boolean> = {}
  const extraInputKeys: string[] = []
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue
    if (!knownKeys.has(key)) {
      extraInputKeys.push(key)
      continue
    }
    const expectedType = SHELL_ENVELOPE_INPUT_KEYS[key]
    if (expectedType === undefined) continue
    if (
      (typeof value !== "number" && typeof value !== "boolean" && typeof value !== "string") ||
      typeof value !== expectedType
    ) {
      // Contract-violating value type: treat as unknown input (docs/03).
      extraInputKeys.push(key)
      continue
    }
    envelope[key] = value
  }
  return {
    toolCallID: event.id,
    sessionID: event.sessionID,
    messageID: event.messageID,
    agent: event.agent,
    command,
    workdir: typeof workdir === "string" ? workdir : null,
    envelope,
    extraInputKeys,
    capturedAt,
  }
}

/** Apply a controller directive to the SDK event: the only mutation point. */
export async function handleSdkPermissionEvaluate(event: SdkPermissionEventLike, controller: GuardController): Promise<void> {
  const directive = await controller.handleEvaluate(toPermissionEventView(event))
  if (directive.commit === "allow" && event.effect === "ask") {
    event.effect = "allow"
    event.message = directive.message
  }
}

function realConfigDeps(env: Readonly<Record<string, string | undefined>>): ConfigDeps {
  return {
    readTextFile(path) {
      try {
        return readFileSync(path, "utf8")
      } catch {
        return null
      }
    },
    statPath(path): PathStat | null {
      try {
        const lstat = lstatSync(path)
        const stat = statSync(path)
        return { isDirectory: stat.isDirectory(), isSymlink: lstat.isSymbolicLink() }
      } catch {
        return null
      }
    },
    env,
  }
}

export interface GuardWiringOverrides {
  readonly configState?: GuardConfigState
  readonly makeAudit?: (config: GuardConfig) => AuditPort
  /** Reviewer factory per chain model (primary first, then escalation stages). */
  readonly makeReviewer?: (config: GuardConfig, model: ModelRef) => ReviewerPort | null
  readonly makeTrace?: (config: GuardConfig) => TracePort | null
  readonly clock?: () => number
  readonly isoNow?: () => string
  readonly fingerprintSalt?: string
}

export interface GuardWiring {
  readonly controller: GuardController
  readonly dispose: () => Promise<void>
}

/**
 * Load the trusted reviewer instruction shipped next to the installed plugin
 * (docs/06). A missing/broken prompt file means the installation is broken:
 * the guard stays up but the reviewer is unavailable (→ ask/MODEL_UNAVAILABLE).
 */
function loadReviewerInstruction(pluginDirectory: string | undefined): string | null {
  if (pluginDirectory === undefined) return null
  try {
    const text = readFileSync(join(pluginDirectory, "prompts", "reviewer-system.txt"), "utf8")
    return text.trim().length > 0 ? text : null
  } catch {
    return null
  }
}

/**
 * Positive availability check for every chain model (primary + escalation) in
 * the host catalog (lifecycle L30/L43): true when all present, false when any
 * is provably absent — a missing stage never silently downgrades the chain.
 * An unavailable catalog API is not evidence of absence → undefined (no gate).
 */
async function checkModelAvailable(
  modelApi: SdkModelListLike | undefined,
  configState: GuardConfigState,
): Promise<boolean | undefined> {
  const config = configState.status === "active" ? configState.config : null
  if (modelApi === undefined || config === null) return undefined
  const models = reviewerChain(config)
  try {
    const list = await modelApi.list()
    for (const model of models) {
      const entry = list.data.find((item) => item.id === model.id && item.providerID === model.providerID)
      if (entry === undefined) return false
      if (model.variant !== undefined && !(entry.variants ?? []).some((variant) => variant.id === model.variant)) {
        return false
      }
    }
    return true
  } catch {
    return undefined
  }
}

/** Wire the guard to a host surface. Returns the controller and an async dispose for cleanup. */
export async function wireGuard(surface: GuardHostSurface, overrides: GuardWiringOverrides = {}): Promise<GuardWiring> {
  const env = () => process.env
  const configState = overrides.configState ?? loadGuardConfig(realConfigDeps(process.env))
  const clock = overrides.clock ?? Date.now
  const configHome = resolveConfigPath(process.env)
  const guardConfigDirs = [dirname(configHome), dirname(dirname(configHome))]

  const instruction = loadReviewerInstruction(surface.pluginDirectory)
  const instructionSha256 = instruction !== null ? createHash("sha256").update(instruction).digest("hex") : null
  const modelAvailable = await checkModelAvailable(surface.model, configState)
  const defaultReviewer = (config: GuardConfig, model: ModelRef): ReviewerPort | null =>
    surface.generate !== undefined && instruction !== null ? new GenerateTextReviewer(surface.generate, model, instruction) : null
  /** Opt-in LLM trace (docs/07): disabled unless diagnostics.llmTrace.enabled is set. */
  const defaultTrace = (config: GuardConfig): TracePort | null => {
    const trace = config.diagnostics?.llmTrace
    if (trace === undefined || !trace.enabled) return null
    return new FileTraceWriter(
      trace.directory ?? config.audit.directory,
      trace.maxFileBytes ?? 5_242_880,
      trace.retainedFiles ?? 7,
    )
  }

  const controller = new GuardController({
    config: configState,
    reviewerFor: (model) =>
      configState.status === "active" ? (overrides.makeReviewer ?? defaultReviewer)(configState.config, model) : null,
    audit:
      configState.status === "active"
        ? (overrides.makeAudit ?? ((config: GuardConfig) => new FileAuditWriter(config.audit.directory, config.audit.maxFileBytes, config.audit.retainedFiles)))(
            configState.config,
          )
        : { append: async () => undefined },
    trace:
      configState.status === "active"
        ? (overrides.makeTrace ?? defaultTrace)(configState.config)
        : null,
    clock,
    isoNow: overrides.isoNow ?? (() => new Date().toISOString()),
    env,
    randomUUID: () => crypto.randomUUID(),
    fingerprintSalt: overrides.fingerprintSalt ?? randomFingerprintSalt(),
    guardConfigDirs,
    locationDirectory: surface.location.directory,
    ...(modelAvailable !== undefined ? { modelAvailable } : {}),
    ...(instructionSha256 !== null ? { promptSha256: instructionSha256 } : {}),
  })

  // Registrations are started without awaiting setup completion: the host may
  // serialize setup/hook RPCs, and awaiting here can deadlock registration.
  // M0 probe evidence: fire-and-forget registration delivers events reliably.
  const registrationEvaluate = surface.permission.hook("evaluate", (event) =>
    handleSdkPermissionEvaluate(event, controller),
  )
  const registrationBefore = surface.tool.hook("execute.before", (event) => {
    const snapshot = toToolSnapshot(event, clock())
    if (snapshot !== null && snapshot.command.length > 0) controller.captureSnapshot(snapshot)
  })
  const registrationAfter = surface.tool.hook("execute.after", (event) => {
    controller.releaseSnapshot(event.id)
  })

  const dispose = async (): Promise<void> => {
    controller.unload()
    const settled = await Promise.allSettled([registrationEvaluate, registrationBefore, registrationAfter])
    const disposals = settled
      .filter((result): result is PromiseFulfilledResult<RegistrationLike> => result.status === "fulfilled")
      .map((result) => result.value.dispose())
    await Promise.allSettled(disposals)
  }
  return { controller, dispose }
}
