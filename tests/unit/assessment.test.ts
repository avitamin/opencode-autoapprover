import { describe, expect, test } from "bun:test"
import { parseAssessmentText } from "../../src/assessment.js"

const VALID = JSON.stringify({
  schemaVersion: 2,
  risk: "LOW",
  categories: ["READ"],
  confidence: "HIGH",
  signals: [],
  summary: "safe read-only command",
})

describe("parseAssessmentText", () => {
  test("accepts a single strict JSON object, outer whitespace tolerated", () => {
    expect(parseAssessmentText(VALID).ok).toBe(true)
    expect(parseAssessmentText(`\n  ${VALID}  \n`).ok).toBe(true)
  })

  test("syntax failures: fences, prose, duplicates, NaN, arrays, two objects", () => {
    expect(parseAssessmentText("```json\n" + VALID + "\n```").ok).toBe(false)
    expect(parseAssessmentText("Here is my assessment: " + VALID).ok).toBe(false)
    const dup = '{"schemaVersion":2,"risk":"LOW","risk":"LOW","categories":["READ"],"confidence":"HIGH","signals":[],"summary":"x"}'
    expect(parseAssessmentText(dup).ok).toBe(false)
    expect(parseAssessmentText("NaN").ok).toBe(false)
    expect(parseAssessmentText("[1,2]").ok).toBe(false)
    expect(parseAssessmentText(`${VALID}${VALID}`).ok).toBe(false)
  })

  test("schema failures", () => {
    expect(parseAssessmentText('{"schemaVersion":2,"risk":"LOW","categories":[],"confidence":"HIGH","signals":[],"summary":"x"}').ok).toBe(false) // empty categories
    expect(parseAssessmentText('{"schemaVersion":2,"risk":"LOW","categories":["READ"],"confidence":"HIGH","signals":[],"summary":""}').ok).toBe(false) // empty summary
    expect(parseAssessmentText('{"schemaVersion":2,"risk":"LOW","categories":["READ"],"confidence":"HIGH","signals":[],"summary":"' + "x".repeat(301) + '"}').ok).toBe(false)
    expect(parseAssessmentText('{"schemaVersion":2,"risk":"EXTREME","categories":["READ"],"confidence":"HIGH","signals":[],"summary":"x"}').ok).toBe(false)
    expect(parseAssessmentText('{"schemaVersion":2,"risk":"LOW","categories":["READ"],"confidence":"HIGH","signals":[],"summary":"x","extra":1}').ok).toBe(false)
    expect(parseAssessmentText('{"schemaVersion":1,"risk":"LOW","categories":["READ"],"confidence":"HIGH","signals":[],"summary":"x"}').ok).toBe(false)
  })

  test("schema coherence: dangerous signal requires risk >= MEDIUM; LOW carries no signals", () => {
    const dangerous = '{"schemaVersion":2,"risk":"LOW","categories":["READ"],"confidence":"HIGH","signals":["DESTRUCTIVE"],"summary":"x"}'
    expect(parseAssessmentText(dangerous)).toMatchObject({ ok: false, kind: "SCHEMA" })
    const withMedium = '{"schemaVersion":2,"risk":"MEDIUM","categories":["READ"],"confidence":"HIGH","signals":["DESTRUCTIVE"],"summary":"x"}'
    expect(parseAssessmentText(withMedium).ok).toBe(true)
  })

  test("schema coherence: UNKNOWN risk shape", () => {
    const unknown = '{"schemaVersion":2,"risk":"UNKNOWN","categories":["UNKNOWN"],"confidence":"LOW","signals":["AMBIGUOUS_SYNTAX"],"summary":"x"}'
    expect(parseAssessmentText(unknown).ok).toBe(true)
    const badUnknown = '{"schemaVersion":2,"risk":"UNKNOWN","categories":["UNKNOWN"],"confidence":"HIGH","signals":[],"summary":"x"}'
    expect(parseAssessmentText(badUnknown).ok).toBe(false)
  })

  test("extra coherence: UNKNOWN category forces UNKNOWN risk", () => {
    const mixed = '{"schemaVersion":2,"risk":"LOW","categories":["READ","UNKNOWN"],"confidence":"HIGH","signals":[],"summary":"x"}'
    const result = parseAssessmentText(mixed)
    expect(result).toMatchObject({ ok: false, kind: "COHERENCE" })
  })

  test("full graduation range parses", () => {
    const cases = [
      '{"schemaVersion":2,"risk":"CRITICAL","categories":["EXEC","STATE_CHANGE"],"confidence":"HIGH","signals":["DESTRUCTIVE","PRIVILEGE"],"summary":"rm -rf with sudo"}',
      '{"schemaVersion":2,"risk":"MEDIUM","categories":["NETWORK"],"confidence":"MEDIUM","signals":["NETWORK_EGRESS"],"summary":"outbound request"}',
    ]
    for (const text of cases) expect(parseAssessmentText(text).ok).toBe(true)
  })
})
