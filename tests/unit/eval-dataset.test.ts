/**
 * Dataset contract tests (eval stage 2): eval/dataset/cases.jsonl must stay
 * schema-valid, balanced, privacy-normalized, and every case must map onto a
 * DTO that conforms to the prod schemas/review-input.schema.json contract.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import Ajv2020 from "ajv/dist/2020.js"
import casesSchemaJson from "../../eval/dataset/cases.schema.json" with { type: "json" }
import reviewInputSchemaJson from "../../schemas/review-input.schema.json" with { type: "json" }

interface EvalCase {
  readonly id: string
  readonly command: string
  readonly resources: readonly string[]
  readonly cwdRelative: string
  readonly workspaceLabel: string
  readonly expectedRisk: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"
  readonly expectedEffect: "allow" | "ask"
  readonly tag: "positive" | "negative" | "borderline"
  readonly source: string
  readonly reason: string
}

const CASES: readonly EvalCase[] = readFileSync("eval/dataset/cases.jsonl", "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as EvalCase)

const TAG_PREFIX: Readonly<Record<EvalCase["tag"], string>> = {
  positive: "pos-",
  negative: "neg-",
  borderline: "brd-",
}

function tagCount(tag: EvalCase["tag"]): number {
  return CASES.filter((c) => c.tag === tag).length
}

describe("eval dataset: schema and shape", () => {
  test("every case conforms to eval/dataset/cases.schema.json", () => {
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(casesSchemaJson)
    for (const c of CASES) {
      const ok = validate(c)
      if (!ok) throw new Error(`${c.id}: ${JSON.stringify(validate.errors)}`)
    }
    expect(CASES.length).toBeGreaterThanOrEqual(90)
    expect(CASES.length).toBeLessThanOrEqual(110)
  })

  test("ids are unique and tagged with the matching prefix", () => {
    const ids = new Set(CASES.map((c) => c.id))
    expect(ids.size).toBe(CASES.length)
    for (const c of CASES) {
      expect(c.id.startsWith(TAG_PREFIX[c.tag])).toBe(true)
    }
  })

  test("tag balance: positives >= 30, negatives >= 35, borderlines >= 15", () => {
    expect(tagCount("positive")).toBeGreaterThanOrEqual(30)
    expect(tagCount("negative")).toBeGreaterThanOrEqual(35)
    expect(tagCount("borderline")).toBeGreaterThanOrEqual(15)
  })

  test("expectations are coherent per tag", () => {
    for (const c of CASES) {
      if (c.tag === "positive") {
        expect(c.expectedEffect).toBe("allow")
        expect(c.expectedRisk).toBe("LOW")
      } else {
        expect(c.expectedEffect).toBe("ask")
        if (c.tag === "negative") {
          expect(["MEDIUM", "HIGH", "CRITICAL"]).toContain(c.expectedRisk)
        } else {
          expect(["LOW", "MEDIUM"]).toContain(c.expectedRisk)
        }
      }
    }
  })

  test("privacy: no absolute home paths, usernames or placeholders leak into the dataset", () => {
    for (const c of CASES) {
      expect(c.command.includes("/home/")).toBe(false)
      expect(c.command.toLowerCase().includes("avi")).toBe(false)
      expect(c.command.includes("REPLACE_ME")).toBe(false)
    }
  })

  test("every case maps onto a DTO conforming to schemas/review-input.schema.json within payload limits", () => {
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(reviewInputSchemaJson)
    for (const c of CASES) {
      const dto = {
        schemaVersion: 2,
        command: c.command,
        resources: [...c.resources],
        cwdRelative: c.cwdRelative,
        workspaceLabel: c.workspaceLabel,
        localFacts: { scopeAuthorized: true, commandComplete: true, sensitiveDataDetected: false },
      }
      const ok = validate(dto)
      if (!ok) throw new Error(`${c.id}: ${JSON.stringify(validate.errors)}`)
      expect(Buffer.byteLength(JSON.stringify(dto), "utf8")).toBeLessThanOrEqual(8192)
    }
  })
})
