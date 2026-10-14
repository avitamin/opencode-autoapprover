import { describe, expect, test } from "bun:test"
import { commandTouchesSensitivePath, detectSecretLike, resourcesConsistentWithCommand, runPreflight } from "../../src/preflight.js"
import { GUARD_CONFIG_DIRS, TEST_ROOT, makeConfig, makeEvent, makeSnapshot } from "../helpers.js"
import type { ToolSnapshot } from "../../src/types.js"

const config = makeConfig()
const OPTS = { effectiveCwd: TEST_ROOT, allowCommandTransmission: true, guardConfigDirs: GUARD_CONFIG_DIRS }

describe("detectSecretLike", () => {
  test("known token forms", () => {
    expect(detectSecretLike("AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE")).toBe(true)
    expect(detectSecretLike("curl -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9' https://x")).toBe(true)
    expect(detectSecretLike("echo -----BEGIN OPENSSH PRIVATE KEY-----")).toBe(true)
    expect(detectSecretLike("git clone https://user:hunter2@example.com/repo.git")).toBe(true)
    expect(detectSecretLike("export GITHUB_TOKEN=ghp_16C7e42F292c6912E7710c838347Ae178B4a")).toBe(true)
    expect(detectSecretLike("api_key=8f3c91d7a2b64e0f9c5d3a8b1e6f2d7c")).toBe(true)
  })

  test("ordinary commands are not secrets", () => {
    expect(detectSecretLike("pwd")).toBe(false)
    expect(detectSecretLike("cat README.md | wc -l")).toBe(false)
    expect(detectSecretLike("cd . && printf probe_cd")).toBe(false)
    expect(detectSecretLike("echo $AWS_SECRET_ACCESS_KEY")).toBe(false) // reference, not value
    expect(detectSecretLike("npm run build --token=short")).toBe(false)
  })
})

describe("commandTouchesSensitivePath / resourcesConsistentWithCommand", () => {
  const DIRS = ["/home/example/.config/opencode-llm-approval", "/home/example/.config/opencode"]
  const PREFIXES = ["secrets", "credentials", "production"]

  test("sensitive operands are caught lexically", () => {
    expect(commandTouchesSensitivePath("cat .env", PREFIXES, DIRS)).toBe(true)
    expect(commandTouchesSensitivePath("cat .env.production", PREFIXES, DIRS)).toBe(true)
    expect(commandTouchesSensitivePath("cat ~/.ssh/id_rsa", PREFIXES, DIRS)).toBe(true)
    expect(commandTouchesSensitivePath("cat /home/example/.config/opencode/auth.json", PREFIXES, DIRS)).toBe(true)
    expect(commandTouchesSensitivePath("cat secrets/token.txt", PREFIXES, DIRS)).toBe(true)
    expect(commandTouchesSensitivePath("cat production/settings.json", PREFIXES, DIRS)).toBe(true)
    expect(commandTouchesSensitivePath("cat docs/link.md", PREFIXES, DIRS)).toBe(false)
    expect(commandTouchesSensitivePath("cat secrets-notes/file", PREFIXES, DIRS)).toBe(false) // component boundary
  })

  test("scanner resources must occur in the raw command", () => {
    expect(resourcesConsistentWithCommand(["cat README.md"], "cat README.md")).toBe(true)
    expect(resourcesConsistentWithCommand(["printf probe_cd"], "cd . && printf probe_cd")).toBe(true)
    expect(resourcesConsistentWithCommand(["rm -rf ./cache"], "cat README.md")).toBe(false)
    expect(resourcesConsistentWithCommand(["cat .env"], "cat README.md")).toBe(false)
    expect(resourcesConsistentWithCommand([], "cat README.md")).toBe(true)
  })
})

describe("runPreflight", () => {
  test("bound ordinary command passes and builds the minimal review DTO", () => {
    const result = runPreflight(makeSnapshot(), makeEvent(), config.policy, config.limits, OPTS)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.review.command).toBe("pwd")
      expect(result.review.cwdRelative).toBe(".")
      expect(result.review.workspaceLabel).toBe("guard-test-root")
      expect(result.review.localFacts).toEqual({ scopeAuthorized: true, commandComplete: true, sensitiveDataDetected: false })
      expect(JSON.stringify(result.review)).not.toContain("ses_")
      expect(JSON.stringify(result.review)).not.toContain(TEST_ROOT)
    }
  })

  test("binding failures", () => {
    expect(runPreflight(makeSnapshot(), makeEvent({ sourceToolCallID: null }), config.policy, config.limits, OPTS)).toMatchObject({ ok: false, reason: "INPUT_UNBOUND" })
    expect(runPreflight(makeSnapshot(), makeEvent({ sourceToolCallID: "call_other" }), config.policy, config.limits, OPTS)).toMatchObject({ ok: false, reason: "INPUT_UNBOUND" })
    expect(runPreflight(makeSnapshot(), makeEvent({ sessionID: "ses_2" }), config.policy, config.limits, OPTS)).toMatchObject({ ok: false, reason: "INPUT_UNBOUND" })
    expect(runPreflight(makeSnapshot({ command: "" }), makeEvent(), config.policy, config.limits, OPTS)).toMatchObject({ ok: false, reason: "INPUT_UNBOUND" })
  })

  test("unknown tool input keys and empty resources make the request ineligible", () => {
    expect(runPreflight(makeSnapshot({ extraInputKeys: ["env"] }), makeEvent(), config.policy, config.limits, OPTS)).toMatchObject({ ok: false, reason: "INPUT_MISMATCH", detail: "extraInputKeys" })
    expect(runPreflight(makeSnapshot(), makeEvent({ resources: [] }), config.policy, config.limits, OPTS)).toMatchObject({ ok: false, reason: "INPUT_MISMATCH", detail: "resourcesEmpty" })
  })

  test("resources inconsistent with the full command report their detail", () => {
    expect(runPreflight(makeSnapshot(), makeEvent({ resources: ["totally-different"] }), config.policy, config.limits, OPTS)).toMatchObject({ ok: false, reason: "INPUT_MISMATCH", detail: "resourcesInconsistent" })
  })

  test("size and control-character limits", () => {
    const long = "a".repeat(5000)
    expect(runPreflight(makeSnapshot({ command: long }), makeEvent({ resources: [long] }), config.policy, config.limits, OPTS)).toMatchObject({ ok: false, reason: "PAYLOAD_TOO_LARGE" })
    expect(runPreflight(makeSnapshot({ command: "ls\u0000" }), makeEvent({ resources: ["ls\u0000"] }), config.policy, config.limits, OPTS)).toMatchObject({ ok: false, reason: "PAYLOAD_TOO_LARGE" })
    const many = Array.from({ length: 9 }, (_, i) => `cmd${i}`)
    expect(runPreflight(makeSnapshot({ command: `printf ${many.join(" ")}` }), makeEvent({ resources: many }), config.policy, config.limits, OPTS)).toMatchObject({ ok: false, reason: "PAYLOAD_TOO_LARGE" })
  })

  test("secrets stop transmission before any LLM call", () => {
    const secret = "curl https://x --header 'Authorization: Bearer aabbccdd1122'"
    expect(runPreflight(makeSnapshot({ command: secret }), makeEvent({ resources: [secret] }), config.policy, config.limits, OPTS)).toMatchObject({ ok: false, reason: "SECRET_DETECTED" })
  })

  test("compound commands are NOT a local stop (graduated-v1)", () => {
    const compound = "cd . && printf probe_cd"
    expect(runPreflight(makeSnapshot({ command: compound }), makeEvent({ resources: ["printf probe_cd"] }), config.policy, config.limits, OPTS).ok).toBe(true)
    const pipeline = "cat README.md | wc -l"
    expect(runPreflight(makeSnapshot({ command: pipeline }), makeEvent({ resources: ["cat README.md", "wc -l"] }), config.policy, config.limits, OPTS).ok).toBe(true)
    const substitution = "echo $(git rev-parse HEAD)"
    expect(runPreflight(makeSnapshot({ command: substitution }), makeEvent({ resources: [substitution] }), config.policy, config.limits, OPTS).ok).toBe(true)
  })

  test("scope: cwd admission", () => {
    expect(runPreflight(makeSnapshot({ workdir: "/etc" }), makeEvent(), config.policy, config.limits, { ...OPTS, effectiveCwd: "/etc" })).toMatchObject({ ok: false, reason: "OUTSIDE_SCOPE" })
    expect(runPreflight(makeSnapshot({ workdir: `${TEST_ROOT}/.git` }), makeEvent(), config.policy, config.limits, { ...OPTS, effectiveCwd: `${TEST_ROOT}/.git` })).toMatchObject({ ok: false, reason: "OUTSIDE_SCOPE" })
    expect(runPreflight(makeSnapshot({ workdir: `${TEST_ROOT}/.env.local` }), makeEvent(), config.policy, config.limits, { ...OPTS, effectiveCwd: `${TEST_ROOT}/.env.local` })).toMatchObject({ ok: false, reason: "OUTSIDE_SCOPE" })
    expect(runPreflight(makeSnapshot({ workdir: `${TEST_ROOT}/src` }), makeEvent(), config.policy, config.limits, { ...OPTS, effectiveCwd: `${TEST_ROOT}/src` }).ok).toBe(true)
    // ../ inside workdir cannot escape the root check after lexical normalization
    expect(runPreflight(makeSnapshot({ workdir: `${TEST_ROOT}/../outside` }), makeEvent(), config.policy, config.limits, { ...OPTS, effectiveCwd: `${TEST_ROOT}/../outside` })).toMatchObject({ ok: false, reason: "OUTSIDE_SCOPE" })
  })

  test("operator always-ask prefixes and guard config dirs", () => {
    expect(runPreflight(makeSnapshot({ workdir: `${TEST_ROOT}/secrets` }), makeEvent(), config.policy, config.limits, { ...OPTS, effectiveCwd: `${TEST_ROOT}/secrets` })).toMatchObject({ ok: false, reason: "OUTSIDE_SCOPE" })
    expect(runPreflight(makeSnapshot({ workdir: `${TEST_ROOT}/credentials/live` }), makeEvent(), config.policy, config.limits, { ...OPTS, effectiveCwd: `${TEST_ROOT}/credentials/live` })).toMatchObject({ ok: false, reason: "OUTSIDE_SCOPE" })
    expect(runPreflight(makeSnapshot({ workdir: `${TEST_ROOT}/secrets-notes` }), makeEvent(), config.policy, config.limits, { ...OPTS, effectiveCwd: `${TEST_ROOT}/secrets-notes` }).ok).toBe(true) // component boundary
    expect(runPreflight(makeSnapshot({ workdir: "/home/tester/.config/opencode" }), makeEvent(), config.policy, config.limits, { ...OPTS, effectiveCwd: "/home/tester/.config/opencode" })).toMatchObject({ ok: false, reason: "OUTSIDE_SCOPE" })
  })

  test("consent gate", () => {
    expect(runPreflight(makeSnapshot(), makeEvent(), config.policy, config.limits, { ...OPTS, allowCommandTransmission: false })).toMatchObject({ ok: false, reason: "PRIVACY_BLOCKED" })
  })

  test("payload size bound applies to the assembled review DTO", () => {
    const big = makeSnapshot({ command: "b".repeat(2000) })
    const result = runPreflight(big, makeEvent({ resources: ["b".repeat(2000)] }), config.policy, { ...config.limits, maxPayloadBytes: 512 }, OPTS)
    expect(result).toMatchObject({ ok: false, reason: "PAYLOAD_TOO_LARGE" })
  })
})
