import { describe, expect, test } from "bun:test"
import { mapAssessmentToThreshold } from "../../src/threshold.js"
import type { Assessment, AutoAllowPolicy } from "../../src/types.js"

function assessment(overrides: Partial<Assessment> = {}): Assessment {
  return {
    schemaVersion: 2,
    risk: "LOW",
    categories: ["READ"],
    confidence: "HIGH",
    signals: [],
    summary: "test",
    ...overrides,
  }
}

const STRICT: AutoAllowPolicy = { maxRisk: "LOW", minConfidence: "HIGH", allowedCategories: ["READ"] }
const MEDIUM_POLICY: AutoAllowPolicy = { maxRisk: "MEDIUM", minConfidence: "MEDIUM", allowedCategories: ["READ", "WRITE"] }

describe("mapAssessmentToThreshold (default LOW/READ/HIGH)", () => {
  test("conforming LOW/READ/HIGH passes", () => {
    expect(mapAssessmentToThreshold(assessment(), STRICT)).toEqual({ withinThreshold: true, reason: "RISK_WITHIN_THRESHOLD" })
  })

  test("MEDIUM risk is above the LOW threshold", () => {
    expect(mapAssessmentToThreshold(assessment({ risk: "MEDIUM" }), STRICT).reason).toBe("RISK_ABOVE_THRESHOLD")
  })

  test("UNKNOWN risk is never within any threshold", () => {
    for (const policy of [STRICT, MEDIUM_POLICY]) {
      expect(mapAssessmentToThreshold(assessment({ risk: "UNKNOWN", confidence: "LOW", categories: ["UNKNOWN"] }), policy).reason).toBe("RISK_ABOVE_THRESHOLD")
    }
  })

  test("confidence below minimum blocks", () => {
    expect(mapAssessmentToThreshold(assessment({ confidence: "MEDIUM" }), STRICT).reason).toBe("CONFIDENCE_BELOW_MINIMUM")
    expect(mapAssessmentToThreshold(assessment({ confidence: "LOW" }), STRICT).reason).toBe("CONFIDENCE_BELOW_MINIMUM")
  })

  test("category outside the allowed set blocks", () => {
    expect(mapAssessmentToThreshold(assessment({ categories: ["READ", "WRITE"] }), STRICT).reason).toBe("CATEGORY_NOT_ALLOWED")
  })

  test("defensive: LOW risk with signals is rejected", () => {
    expect(mapAssessmentToThreshold(assessment({ signals: ["OTHER"] }), STRICT).reason).toBe("RISK_ABOVE_THRESHOLD")
  })
})

describe("threshold matrix (L51–L54 shape)", () => {
  test("maxRisk=MEDIUM admits MEDIUM/READ/HIGH-confidence", () => {
    const result = mapAssessmentToThreshold(assessment({ risk: "MEDIUM" }), { maxRisk: "MEDIUM", minConfidence: "HIGH", allowedCategories: ["READ"] })
    expect(result.withinThreshold).toBe(true)
  })

  test("minConfidence=MEDIUM admits MEDIUM confidence", () => {
    const result = mapAssessmentToThreshold(assessment({ confidence: "MEDIUM" }), { maxRisk: "LOW", minConfidence: "MEDIUM", allowedCategories: ["READ"] })
    expect(result.withinThreshold).toBe(true)
  })

  test("extended allowedCategories admit WRITE", () => {
    const result = mapAssessmentToThreshold(assessment({ categories: ["WRITE"] }), { maxRisk: "LOW", minConfidence: "HIGH", allowedCategories: ["READ", "WRITE"] })
    expect(result.withinThreshold).toBe(true)
  })

  test("structurally unconfigurable: HIGH/CRITICAL/UNKNOWN risk and UNKNOWN category never pass", () => {
    for (const risk of ["HIGH", "CRITICAL", "UNKNOWN"] as const) {
      for (const policy of [STRICT, MEDIUM_POLICY, { maxRisk: "MEDIUM" as const, minConfidence: "MEDIUM" as const, allowedCategories: ["READ", "WRITE", "EXEC", "NETWORK", "STATE_CHANGE"] as const }]) {
        const a = assessment({ risk, confidence: risk === "UNKNOWN" ? "LOW" : "HIGH", categories: risk === "UNKNOWN" ? ["UNKNOWN"] : ["READ"] })
        expect(mapAssessmentToThreshold(a, policy).withinThreshold).toBe(false)
      }
    }
    expect(mapAssessmentToThreshold(assessment({ categories: ["UNKNOWN"], risk: "UNKNOWN", confidence: "LOW" }), MEDIUM_POLICY).withinThreshold).toBe(false)
  })
})
