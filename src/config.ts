/**
 * Trusted guard configuration (docs/05): single fixed global path, strict JSON,
 * JSON-Schema validation plus semantic rules, frozen snapshot. Missing or
 * invalid file → inactive guard. No partial values are ever applied.
 */
import Ajv2020 from "ajv/dist/2020.js"
import configSchemaJson from "../schemas/config.schema.json" with { type: "json" }
import { parseStrictJson } from "./json.js"
import type { GuardConfig, GuardConfigState, ModelRef } from "./types.js"

export interface PathStat {
  readonly isDirectory: boolean
  readonly isSymlink: boolean
}

export interface ConfigDeps {
  /** Returns file text or null when the file does not exist / cannot be read. */
  readonly readTextFile: (path: string) => string | null
  /** Returns path metadata or null when the path does not exist. */
  readonly statPath: (path: string) => PathStat | null
  readonly env: Readonly<Record<string, string | undefined>>
  /** Override for tests; defaults to resolveConfigPath(env). */
  readonly configPath?: string
}

export const KILL_SWITCH_ENV = "OPENCODE_LLM_APPROVAL_DISABLE"

export function resolveConfigPath(env: Readonly<Record<string, string | undefined>>): string {
  const base = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0 ? env.XDG_CONFIG_HOME : `${env.HOME ?? ""}/.config`
  return `${base.replace(/\/+$/, "")}/opencode-llm-approval/config.json`
}

let ajvValidate: ((data: unknown) => { ok: boolean; errors: string[] }) | null = null

function schemaValidator(): (data: unknown) => { ok: boolean; errors: string[] } {
  if (ajvValidate === null) {
    const ajv = new Ajv2020({ strict: true, allErrors: true })
    const validate = ajv.compile(configSchemaJson)
    ajvValidate = (data: unknown) => {
      const ok = validate(data) as boolean
      return { ok, errors: ok ? [] : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message ?? ""}`.trim()) }
    }
  }
  return ajvValidate
}

/** Lexical path normalization: resolves "." and ".." components without touching the filesystem. */
export function normalizeAbsolutePath(path: string): string {
  const parts = path.split("/")
  const out: string[] = []
  for (const part of parts) {
    if (part === "" || part === ".") continue
    if (part === "..") {
      out.pop()
      continue
    }
    out.push(part)
  }
  return `/${out.join("/")}`
}

function isInside(child: string, parent: string): boolean {
  if (child === parent) return true
  return child.startsWith(`${parent}/`)
}

const BUILTIN_EXCLUDED_ROOT_PREFIXES = ["/proc", "/sys", "/dev", "/run"]

/** Placeholder used by examples; a config containing it is operationally invalid (docs/05). */
const PLACEHOLDER = "REPLACE_ME"

function containsPlaceholder(value: string): boolean {
  return value.includes(PLACEHOLDER)
}

interface SemanticFailure {
  readonly message: string
}

/** Escalation config with all optional fields resolved (docs/05 defaults). */
export interface EffectiveEscalation {
  readonly models: readonly ModelRef[]
  readonly triggerOn: { readonly unknownRisk: boolean; readonly invalidResponse: boolean; readonly lowConfidence: boolean }
  readonly timeoutMs: number
}

export const DEFAULT_ESCALATION_TIMEOUT_MS = 9000

/** Resolve escalation defaults; null when the chain is absent → single-model behavior. */
export function effectiveEscalation(config: GuardConfig): EffectiveEscalation | null {
  const escalation = config.escalation
  if (escalation === undefined) return null
  const triggerOn = escalation.triggerOn ?? {}
  return {
    models: escalation.models,
    triggerOn: {
      unknownRisk: triggerOn.unknownRisk ?? true,
      invalidResponse: triggerOn.invalidResponse ?? true,
      lowConfidence: triggerOn.lowConfidence ?? true,
    },
    timeoutMs: escalation.timeoutMs ?? DEFAULT_ESCALATION_TIMEOUT_MS,
  }
}

/** Ordered reviewer chain: the primary model first, then escalation stages (D3). */
export function reviewerChain(config: GuardConfig): readonly ModelRef[] {
  return [config.model, ...(config.escalation?.models ?? [])]
}

/**
 * Hard ceiling for limits.hookDeadlineMs: mirrored by the JSON schema maximum,
 * but enforced here as well so the code rejects any schema drift independently
 * of the packaged schema (docs/01, docs/05). Config cannot override it.
 */
export const HOOK_DEADLINE_HARD_MAX_MS = 120_000

function semanticValidation(config: GuardConfig, deps: ConfigDeps): SemanticFailure | null {
  const { limits, policy, audit, privacy, model } = config

  if (limits.hookDeadlineMs > HOOK_DEADLINE_HARD_MAX_MS) {
    return { message: `hookDeadlineMs must not exceed the hard ceiling of ${HOOK_DEADLINE_HARD_MAX_MS}ms` }
  }

  if (limits.llmTimeoutMs + 500 > limits.hookDeadlineMs) {
    return { message: "llmTimeoutMs must leave >=500ms before hookDeadlineMs" }
  }

  for (const value of [model.providerID, model.id, ...(model.variant ? [model.variant] : []), privacy.destinationReview]) {
    if (containsPlaceholder(value)) return { message: "model/privacy contains REPLACE_ME placeholder" }
  }

  if (config.escalation !== undefined) {
    // Non-null by construction: the section exists, so effectiveEscalation resolves it.
    const escalation = effectiveEscalation(config)!
    for (const escalationModel of escalation.models) {
      for (const value of [escalationModel.providerID, escalationModel.id, ...(escalationModel.variant ? [escalationModel.variant] : [])]) {
        if (containsPlaceholder(value)) return { message: "escalation.models contains REPLACE_ME placeholder" }
      }
    }
    // Uniqueness includes the primary model: a duplicate stage is pure cost with no new information.
    const keys = [model, ...escalation.models].map((m) => `${m.providerID}/${m.id}/${m.variant ?? ""}`)
    if (new Set(keys).size !== keys.length) {
      return { message: "escalation.models must be unique and differ from the primary model" }
    }
    // Worst-case chain budget must fit the hook deadline.
    const chainBudgetMs = limits.llmTimeoutMs + escalation.models.length * escalation.timeoutMs
    if (chainBudgetMs > limits.hookDeadlineMs) {
      return { message: `llmTimeoutMs + escalation stages (${chainBudgetMs}ms) must fit hookDeadlineMs (${limits.hookDeadlineMs}ms)` }
    }
  }

  for (const root of policy.workspaceRoots) {
    if (containsPlaceholder(root)) return { message: "workspaceRoots contains REPLACE_ME placeholder" }
  }
  if (containsPlaceholder(audit.directory)) return { message: "audit.directory contains REPLACE_ME placeholder" }

  const home = deps.env.HOME && deps.env.HOME.length > 0 ? normalizeAbsolutePath(deps.env.HOME) : null
  const configHome = normalizeAbsolutePath(
    deps.env.XDG_CONFIG_HOME && deps.env.XDG_CONFIG_HOME.length > 0 ? deps.env.XDG_CONFIG_HOME : `${home ?? ""}/.config`,
  )

  const roots = policy.workspaceRoots.map(normalizeAbsolutePath)
  for (let i = 0; i < roots.length; i++) {
    const root = roots[i]!
    if (root === "/" ) return { message: "workspace root must not be /" }
    if (root === home) return { message: "workspace root must not be the entire home directory" }
    if (root === configHome || isInside(root, configHome) || isInside(configHome, root)) {
      return { message: "workspace root must not overlap the global configuration directory" }
    }
    for (const prefix of BUILTIN_EXCLUDED_ROOT_PREFIXES) {
      if (root === prefix || isInside(root, prefix)) return { message: `workspace root must not be inside ${prefix}` }
    }
    const stat = deps.statPath(policy.workspaceRoots[i]!)
    if (stat === null || !stat.isDirectory || stat.isSymlink) {
      return { message: `workspace root ${policy.workspaceRoots[i]} must be an existing non-symlink directory` }
    }
    for (let j = 0; j < roots.length; j++) {
      if (i !== j && isInside(roots[i]!, roots[j]!)) {
        return { message: "workspace roots must not contain each other" }
      }
    }
  }

  const auditDir = normalizeAbsolutePath(audit.directory)
  for (const root of roots) {
    if (isInside(auditDir, root) || isInside(root, auditDir)) {
      return { message: "audit directory must not overlap a workspace root" }
    }
  }
  const auditStat = deps.statPath(audit.directory)
  if (auditStat !== null && auditStat.isSymlink) {
    return { message: "audit directory must not be a symlink" }
  }

  // Effective trace directory only needs its own checks when overridden;
  // the default (audit.directory) is already validated above.
  const traceDirRaw = config.diagnostics?.llmTrace?.directory
  if (traceDirRaw !== undefined) {
    if (containsPlaceholder(traceDirRaw)) {
      return { message: "diagnostics.llmTrace.directory contains REPLACE_ME placeholder" }
    }
    const traceDir = normalizeAbsolutePath(traceDirRaw)
    for (const root of roots) {
      if (isInside(traceDir, root) || isInside(root, traceDir)) {
        return { message: "diagnostics.llmTrace.directory must not overlap a workspace root" }
      }
    }
    const traceStat = deps.statPath(traceDirRaw)
    if (traceStat !== null && traceStat.isSymlink) {
      return { message: "diagnostics.llmTrace.directory must not be a symlink" }
    }
  }

  for (const prefix of policy.alwaysAskPathPrefixes) {
    if (prefix.startsWith("/")) return { message: "alwaysAskPathPrefixes must be workspace-relative" }
    if (prefix.split("/").includes("..")) return { message: "alwaysAskPathPrefixes must not contain '..'" }
    if (/[*?[\]]/.test(prefix)) return { message: "alwaysAskPathPrefixes must be literal (no wildcards)" }
  }

  if (config.mode !== "off" && privacy.destinationReview.trim().length === 0) {
    return { message: "destinationReview must be filled for shadow/auto modes" }
  }

  return null
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
    Object.freeze(value)
  }
  return value
}

/** Load and validate the guard config. Never throws; invalid → inactive guard. */
export function loadGuardConfig(deps: ConfigDeps): GuardConfigState {
  const path = deps.configPath ?? resolveConfigPath(deps.env)
  const text = deps.readTextFile(path)
  if (text === null) {
    return { status: "inactive", reason: "CONFIG_INVALID", detail: `config file not found: ${path}` }
  }
  const parsed = parseStrictJson(text)
  if (!parsed.ok) {
    return { status: "inactive", reason: "CONFIG_INVALID", detail: `config is not strict JSON: ${parsed.error}` }
  }
  const schemaResult = schemaValidator()(parsed.value)
  if (!schemaResult.ok) {
    return { status: "inactive", reason: "CONFIG_INVALID", detail: `config schema violation: ${schemaResult.errors.join("; ")}` }
  }
  const config = deepFreeze(parsed.value as unknown as GuardConfig)
  const failure = semanticValidation(config, deps)
  if (failure !== null) {
    return { status: "inactive", reason: "CONFIG_INVALID", detail: `config semantic violation: ${failure.message}` }
  }
  return { status: "active", config }
}
