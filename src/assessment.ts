/**
 * Reviewer response validation (docs/06): the raw model text must be ONE strict
 * JSON value (outer whitespace tolerated; fences/prose/repair attempts are not).
 * Schema v2 + coherence rules beyond JSON Schema.
 */
import Ajv2020 from "ajv/dist/2020.js"
import assessmentSchemaJson from "../schemas/assessment.schema.json" with { type: "json" }
import { parseStrictJson, type JsonValue } from "./json.js"
import type { Assessment } from "./types.js"

export type AssessmentInvalidKind = "SYNTAX" | "SCHEMA" | "COHERENCE"

export type AssessmentValidation =
  | { readonly ok: true; readonly assessment: Assessment }
  | { readonly ok: false; readonly kind: AssessmentInvalidKind; readonly detail: string }

let ajvValidate: ((data: unknown) => { ok: boolean; errors: string[] }) | null = null

function schemaValidator(): (data: unknown) => { ok: boolean; errors: string[] } {
  if (ajvValidate === null) {
    const ajv = new Ajv2020({ strict: true, allErrors: true })
    const validate = ajv.compile(assessmentSchemaJson)
    ajvValidate = (data: unknown) => {
      const ok = validate(data) as boolean
      return { ok, errors: ok ? [] : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message ?? ""}`.trim()) }
    }
  }
  return ajvValidate
}

const DANGEROUS_SIGNALS = new Set<string>(["SECRET_LIKE", "DESTRUCTIVE", "PRIVILEGE", "NETWORK_EGRESS", "INJECTION_ATTEMPT"])

/** Summary must stay inert when displayed: raw or escaped control characters are rejected (terminal escapes, injection hygiene). */
function summaryIsInert(summary: string): boolean {
  for (let i = 0; i < summary.length; i++) {
    const code = summary.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

/**
 * Coherence beyond the schema:
 * - any dangerous signal ⇒ risk ≥ MEDIUM (schema also enforces this; kept as defense)
 * - LOW risk ⇒ no signals at all (schema enforces; kept as defense)
 * - UNKNOWN category anywhere ⇒ overall risk must be UNKNOWN
 * - summary must not contain control characters (raw controls already fail strict JSON; \u escapes land here)
 */
function coherence(value: Assessment): string | null {
  const hasDangerousSignal = value.signals.some((s) => DANGEROUS_SIGNALS.has(s))
  if (hasDangerousSignal && value.risk !== "MEDIUM" && value.risk !== "HIGH" && value.risk !== "CRITICAL") {
    return "dangerous signal requires risk >= MEDIUM"
  }
  if (value.risk === "LOW" && value.signals.length > 0) {
    return "LOW risk must not carry signals"
  }
  if (value.categories.includes("UNKNOWN") && value.risk !== "UNKNOWN") {
    return "UNKNOWN category requires UNKNOWN risk"
  }
  if (!summaryIsInert(value.summary)) {
    return "summary contains control characters"
  }
  return null
}

/** Validate the reviewer's raw response text into an Assessment. No retry, no repair; escalation to another chain model is a controller decision (D3). */
export function parseAssessmentText(raw: string): AssessmentValidation {
  const parsed = parseStrictJson(raw)
  if (!parsed.ok) return { ok: false, kind: "SYNTAX", detail: parsed.error }
  const value: JsonValue = parsed.value
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, kind: "SCHEMA", detail: "assessment must be a JSON object" }
  }
  const schemaResult = schemaValidator()(value)
  if (!schemaResult.ok) {
    return { ok: false, kind: "SCHEMA", detail: schemaResult.errors.join("; ") }
  }
  const assessment = value as unknown as Assessment
  const coherenceFailure = coherence(assessment)
  if (coherenceFailure !== null) {
    return { ok: false, kind: "COHERENCE", detail: coherenceFailure }
  }
  return { ok: true, assessment }
}
