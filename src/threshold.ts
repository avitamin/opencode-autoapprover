/**
 * Pure deterministic threshold mapping (docs/02, docs/04): the ONLY place where
 * a validated assessment is authorized. Structural ceilings of
 * schemas/config.schema.json guarantee HIGH/CRITICAL/UNKNOWN risk, LOW
 * confidence and UNKNOWN categories can never be configured as allowed.
 */
import type { Assessment, AutoAllowPolicy, ReasonCode } from "./types.js"

export type ThresholdReason = Extract<
  ReasonCode,
  "RISK_WITHIN_THRESHOLD" | "RISK_ABOVE_THRESHOLD" | "CONFIDENCE_BELOW_MINIMUM" | "CATEGORY_NOT_ALLOWED"
>

export interface ThresholdOutcome {
  readonly withinThreshold: boolean
  readonly reason: ThresholdReason
}

const RISK_ORDER: Readonly<Record<Assessment["risk"], number>> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
  UNKNOWN: Number.POSITIVE_INFINITY,
}

const CONFIDENCE_ORDER: Readonly<Record<Assessment["confidence"], number>> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
}

/**
 * Fail-closed, ordered checks: risk → confidence → categories.
 * Defensively rejects an incoherent LOW-risk answer that still carries signals
 * (assessment validation makes this unreachable; the threshold does not trust it).
 */
export function mapAssessmentToThreshold(assessment: Assessment, policy: AutoAllowPolicy): ThresholdOutcome {
  if (RISK_ORDER[assessment.risk] > RISK_ORDER[policy.maxRisk]) {
    return { withinThreshold: false, reason: "RISK_ABOVE_THRESHOLD" }
  }
  if (assessment.signals.length > 0 && assessment.risk === "LOW") {
    return { withinThreshold: false, reason: "RISK_ABOVE_THRESHOLD" }
  }
  if (CONFIDENCE_ORDER[assessment.confidence] < CONFIDENCE_ORDER[policy.minConfidence]) {
    return { withinThreshold: false, reason: "CONFIDENCE_BELOW_MINIMUM" }
  }
  const allowed = new Set<string>(policy.allowedCategories)
  for (const category of assessment.categories) {
    if (!allowed.has(category)) {
      return { withinThreshold: false, reason: "CATEGORY_NOT_ALLOWED" }
    }
  }
  return { withinThreshold: true, reason: "RISK_WITHIN_THRESHOLD" }
}
