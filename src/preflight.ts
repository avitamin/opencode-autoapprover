/**
 * Local preflight gates (docs/04): minimal, non-duplicating deterministic stops
 * that run BEFORE any LLM call. Compound commands, substitutions, redirects,
 * globs and unknown executables are NOT stops anymore — the reviewer model
 * judges their meaning; only transmission-scope facts are checked here.
 */
import type {
  GuardConfig,
  GuardLimits,
  InputMismatchDetail,
  PermissionEventView,
  ReasonCode,
  ReviewInput,
  ToolSnapshot,
} from "./types.js"
import { isDriveShapedPath, normalizeAbsolutePath } from "./config.js"

export type PreflightFailureReason = Extract<
  ReasonCode,
  "INPUT_UNBOUND" | "INPUT_MISMATCH" | "SECRET_DETECTED" | "OUTSIDE_SCOPE" | "PRIVACY_BLOCKED" | "PAYLOAD_TOO_LARGE"
>

export type PreflightResult =
  | { readonly ok: true; readonly review: ReviewInput }
  | { readonly ok: false; readonly reason: PreflightFailureReason; readonly detail?: InputMismatchDetail }

export interface PreflightOptions {
  /** Effective cwd of the command: tool-input workdir or the location fallback. */
  readonly effectiveCwd: string
  readonly allowCommandTransmission: boolean
  readonly guardConfigDirs: readonly string[]
}

/** Whole-component sensitive names (docs/04 built-in exclusions). */
const SENSITIVE_COMPONENTS = new Set<string>([
  ".git",
  ".ssh",
  ".aws",
  ".kube",
  ".gnupg",
  "id_rsa",
  "id_ed25519",
])

function isSensitiveComponent(component: string): boolean {
  return SENSITIVE_COMPONENTS.has(component) || component === ".env" || component.startsWith(".env.")
}

/** Absolute-path token: leading "/", leading "\", or a Windows drive prefix like "C:\" / "C:/". */
function isAbsoluteLikePath(token: string): boolean {
  return token.startsWith("/") || token.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(token)
}

/** Token lexically anchored to a Windows volume: drive prefix ("C:\", "C:/") or "\"-rooted. */
function isWindowsAnchoredToken(token: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(token) || token.startsWith("\\")
}

/**
 * Lexical scan of command operands for sensitive path areas (docs/04 built-in
 * exclusions + operator prefixes + guard/OpenCode config dirs). This is NOT a
 * command grammar: tokens are split on whitespace, quotes stripped, components
 * matched whole on both "/" and "\" separators (Windows-compatible). It only
 * ever tightens (ask), never authorizes.
 *
 * Component/prefix comparison follows the filesystem the path lives on
 * (commit-review N1): Windows-anchored tokens (drive prefix, "\"-rooted) and —
 * under a drive-shaped evaluation cwd — every non-POSIX-absolute token
 * (relative, "~", "%VAR%") are case-folded, so ".SSH"/"Secrets/" cannot slip
 * past the stop on a case-insensitive filesystem. POSIX-absolute ("/…") tokens
 * and non-drive cwd keep exact case.
 */
export function commandTouchesSensitivePath(
  command: string,
  prefixes: readonly string[],
  guardConfigDirs: readonly string[],
  windowsFsContext = false,
): boolean {
  for (const rawToken of command.split(/\s+/)) {
    const token = rawToken.replace(/^["']+/, "").replace(/["']+$/, "")
    if (token.length === 0) continue
    if (isAbsoluteLikePath(token)) {
      const normalizedToken = normalizeAbsolutePath(token)
      for (const dir of guardConfigDirs) {
        const normalizedDir = normalizeAbsolutePath(dir)
        if (normalizedToken === normalizedDir || normalizedToken.startsWith(`${normalizedDir}/`)) return true
      }
    }
    const windowsFs = isWindowsAnchoredToken(token) || (windowsFsContext && !token.startsWith("/"))
    const components = token.split(/[\\/]/).filter((part) => part.length > 0)
    if (components.some((component) => isSensitiveComponent(windowsFs ? component.toLowerCase() : component))) return true
    // Operator prefixes are workspace-relative: they apply to relative operand paths only.
    if (!isAbsoluteLikePath(token) && !token.startsWith("~")) {
      const first = components[0] ?? token
      const firstCmp = windowsFs ? first.toLowerCase() : first
      for (const prefix of prefixes) {
        if (firstCmp === (windowsFs ? prefix.toLowerCase() : prefix)) return true
      }
    }
  }
  return false
}

/**
 * Scanner resources must be consistent with the full raw command (docs/03):
 * each resource is derived from the command, so a resource that does not occur
 * in it indicates an unbound/mismatched binding. Conservative and semantic-free.
 */
export function resourcesConsistentWithCommand(resources: readonly string[], command: string): boolean {
  for (const resource of resources) {
    const trimmed = resource.trim()
    if (trimmed.length === 0) return false
    if (!command.includes(trimmed)) return false
  }
  return true
}

/**
 * Conservative transmission prefilter (docs/04): known token forms, private-key
 * markers, credentials in URLs, authorization/header-like literals. A hit means
 * the string is never sent to the provider — not even redacted.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*(PRIVATE KEY|BLOCK)-----/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bglpat-[A-Za-z0-9_-]{16,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i,
  /\b(?:authorization|proxy-authorization)\b[^A-Za-z0-9]{0,6}(?:bearer\s+)?["']?[A-Za-z0-9._+/=-]{12,}/i,
  /\bbearer\s+["']?[A-Za-z0-9._+/=-]{12,}/i,
  /\b(?:api[_-]?key|apikey|secret|token|passwd|password|pwd)\b\s*[=:]\s*["']?[A-Za-z0-9+/_-]{16,}/i,
]

export function detectSecretLike(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text))
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * Raw control characters make the request ineligible: anything except TAB/LF
 * (legitimate in multiline commands) is rejected, including NUL and DEL.
 */
function hasDisallowedControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === 0x09 || code === 0x0a) continue
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

export function findWorkspaceRoot(cwd: string, roots: readonly string[]): string | null {
  const normalized = normalizeAbsolutePath(cwd)
  let best: string | null = null
  for (const rawRoot of roots) {
    const root = normalizeAbsolutePath(rawRoot)
    if (normalized === root || normalized.startsWith(`${root}/`)) {
      if (best === null || root.length > best.length) best = root
    }
  }
  return best
}

function relativeComponents(cwd: string, root: string): string[] {
  const normalized = normalizeAbsolutePath(cwd)
  return normalized.slice(root.length).split("/").filter((part) => part.length > 0)
}

/**
 * Run all preflight gates for a bound snapshot. Pure: no filesystem, no clock,
 * no LLM. The returned ReviewInput is the only payload that may be transmitted.
 */
export function runPreflight(
  snapshot: ToolSnapshot,
  event: PermissionEventView,
  policy: GuardConfig["policy"],
  limits: GuardLimits,
  options: PreflightOptions,
): PreflightResult {
  // 1. Binding: complete snapshot correlated with the permission source.
  if (
    event.sourceToolCallID === null ||
    snapshot.toolCallID !== event.sourceToolCallID ||
    snapshot.sessionID !== event.sessionID ||
    (event.sourceMessageID !== null && snapshot.messageID !== event.sourceMessageID)
  ) {
    return { ok: false, reason: "INPUT_UNBOUND" }
  }

  // 2. Unknown tool-input keys can change shell/env/sandbox/execution (docs/03).
  //    Documented envelope keys (timeout, background) were already bound by the
  //    adapter; extraInputKeys here means keys outside that contract.
  if (snapshot.extraInputKeys.length > 0) {
    return { ok: false, reason: "INPUT_MISMATCH", detail: "extraInputKeys" }
  }
  if (snapshot.command.length === 0) {
    return { ok: false, reason: "INPUT_UNBOUND" }
  }
  // Scanner resources must be present and bound to the same operation.
  if (event.resources.length === 0) {
    return { ok: false, reason: "INPUT_MISMATCH", detail: "resourcesEmpty" }
  }
  if (!resourcesConsistentWithCommand(event.resources, snapshot.command)) {
    return { ok: false, reason: "INPUT_MISMATCH", detail: "resourcesInconsistent" }
  }

  // 3. Size and control characters.
  if (hasDisallowedControlChars(snapshot.command) || event.resources.some(hasDisallowedControlChars)) {
    return { ok: false, reason: "PAYLOAD_TOO_LARGE" }
  }
  if (utf8Bytes(snapshot.command) > limits.maxCommandBytes) {
    return { ok: false, reason: "PAYLOAD_TOO_LARGE" }
  }
  if (event.resources.length > limits.maxResources) {
    return { ok: false, reason: "PAYLOAD_TOO_LARGE" }
  }
  for (const resource of event.resources) {
    if (utf8Bytes(resource) > limits.maxCommandBytes) {
      return { ok: false, reason: "PAYLOAD_TOO_LARGE" }
    }
  }

  // 4. Secret prefilter on the raw command and every scanner resource.
  if (detectSecretLike(snapshot.command) || event.resources.some((r) => detectSecretLike(r))) {
    return { ok: false, reason: "SECRET_DETECTED" }
  }

  // 5. Scope: effective cwd inside an admitted root, not in a sensitive area;
  //    command operands must not touch sensitive path areas either (docs/04).
  const root = findWorkspaceRoot(options.effectiveCwd, policy.workspaceRoots)
  if (root === null) {
    return { ok: false, reason: "OUTSIDE_SCOPE" }
  }
  const components = relativeComponents(options.effectiveCwd, root)
  if (components.some(isSensitiveComponent)) {
    return { ok: false, reason: "OUTSIDE_SCOPE" }
  }
  const relativePath = components.join("/")
  for (const prefix of policy.alwaysAskPathPrefixes) {
    if (relativePath === prefix || relativePath.startsWith(`${prefix}/`)) {
      return { ok: false, reason: "OUTSIDE_SCOPE" }
    }
  }
  const normalizedCwd = normalizeAbsolutePath(options.effectiveCwd)
  for (const dir of options.guardConfigDirs) {
    const normalizedDir = normalizeAbsolutePath(dir)
    if (normalizedCwd === normalizedDir || normalizedCwd.startsWith(`${normalizedDir}/`)) {
      return { ok: false, reason: "OUTSIDE_SCOPE" }
    }
  }
  const windowsFsContext = isDriveShapedPath(normalizedCwd)
  if (commandTouchesSensitivePath(snapshot.command, policy.alwaysAskPathPrefixes, options.guardConfigDirs, windowsFsContext)) {
    return { ok: false, reason: "OUTSIDE_SCOPE" }
  }

  // 6. Operator consent for the minimal transmission payload.
  if (!options.allowCommandTransmission) {
    return { ok: false, reason: "PRIVACY_BLOCKED" }
  }

  // DTO labels (commit-review N2): workspaceLabel keeps the operator-written case
  // (raw root string — unique after normalization thanks to the nesting rule);
  // cwdRelative inherits the canonical (case-folded on Windows) form — risk-neutral.
  const rawRoot = policy.workspaceRoots.find((r) => normalizeAbsolutePath(r) === root) ?? root
  const review: ReviewInput = {
    schemaVersion: 2,
    command: snapshot.command,
    resources: [...event.resources],
    cwdRelative: relativePath.length > 0 ? relativePath : ".",
    workspaceLabel: rawRoot.split(/[\\/]/).filter((p) => p.length > 0).slice(-1)![0]!.slice(0, 80),
    localFacts: { scopeAuthorized: true, commandComplete: true, sensitiveDataDetected: false },
  }
  if (utf8Bytes(JSON.stringify(review)) > limits.maxPayloadBytes) {
    return { ok: false, reason: "PAYLOAD_TOO_LARGE" }
  }
  return { ok: true, review }
}
