/**
 * Corpus: tests/fixtures/assessments.jsonl (docs/08).
 * Each `raw` string is parsed as literal reviewer output. `transportError`
 * fixtures never reach the parser (covered by contract tests). The response
 * byte ceiling (limits.maxResponseBytes, fixture R26) is checked before parsing.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { parseAssessmentText } from "../../src/assessment.js"
import { mapAssessmentToThreshold } from "../../src/threshold.js"
import type { AutoAllowPolicy } from "../../src/types.js"

const DEFAULT_POLICY: AutoAllowPolicy = { maxRisk: "LOW", minConfidence: "HIGH", allowedCategories: ["READ"] }
const MAX_RESPONSE_BYTES = 8192

interface AssessmentFixture {
  readonly id: string
  readonly expectedValid: boolean
  readonly expectedModelEligibility: boolean
  readonly reason: string
  readonly raw?: string
  readonly transportError?: string
}

function loadFixtures(): AssessmentFixture[] {
  const text = readFileSync("tests/fixtures/assessments.jsonl", "utf8") as string
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as AssessmentFixture)
}

describe("corpus: assessments.jsonl", () => {
  const fixtures = loadFixtures()

  test("corpus is loaded completely", () => {
    expect(fixtures.length).toBe(34)
  })

  for (const fixture of fixtures) {
    test(`${fixture.id}: ${fixture.reason}`, () => {
      if (fixture.transportError !== undefined) {
        // A transport failure is never a valid response; nothing to parse.
        expect(fixture.expectedValid).toBe(false)
        return
      }
      const raw = fixture.raw ?? ""
      const overCeiling = new TextEncoder().encode(raw).length > MAX_RESPONSE_BYTES
      const parsed = parseAssessmentText(raw)
      const valid = parsed.ok && !overCeiling
      expect(valid).toBe(fixture.expectedValid)
      if (valid && parsed.ok) {
        expect(mapAssessmentToThreshold(parsed.assessment, DEFAULT_POLICY).withinThreshold).toBe(
          fixture.expectedModelEligibility,
        )
      }
      if (!valid && fixture.expectedModelEligibility) {
        throw new Error(`${fixture.id}: eligibility asserted for an invalid response`)
      }
    })
  }

  test("R29: __proto__ field stays an own property and pollutes nothing", () => {
    const protoFixture = fixtures.find((f) => f.id === "R29")
    expect(protoFixture).toBeDefined()
    const parsed = parseAssessmentText(protoFixture!.raw ?? "")
    expect(parsed.ok).toBe(false) // additionalProperties: false
    expect(({} as Record<string, unknown>).approved).toBeUndefined()
  })
})
