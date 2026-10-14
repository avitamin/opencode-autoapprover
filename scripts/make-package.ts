/**
 * M4 packaging step (docs/08, IMPLEMENTATION_PLAN M4): stage the built plugin
 * OUTSIDE the agent-mutable working tree, the way an operator would install it.
 *
 * The staged package is the artifact under test for the host smoke:
 *   <stage>/opencode-llm-approval/   package.json (main → dist/src/index.js)
 *                                   dist/          compiled JS (from `bun run build`)
 *                                   prompts/       reviewer instruction
 *                                   node_modules/  production deps via bun.lock
 *   <stage>/m4-harness/              mock-generation test harness (index.ts)
 *   <stage>/scripts/                 per-run scenario scripts for the harness
 *
 * Usage: bun scripts/make-package.ts [--stage DIR] [--skip-install]
 * Requires `bun run build` to have produced dist/ (script fails otherwise).
 * Never touches anything inside the repository except reading it.
 * Refuses a nonempty stage instead of replacing an earlier package.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const repo = join(import.meta.dir, "..")
const stage = process.argv.includes("--stage")
  ? (process.argv[process.argv.indexOf("--stage") + 1] ?? "/tmp/opencode/pkg")
  : "/tmp/opencode/pkg"

const dist = join(repo, "dist")
if (!existsSync(join(dist, "src", "index.js")) || !existsSync(join(dist, "src", "opencode", "adapter.js"))) {
  console.error("dist/ is missing or incomplete — run `bun run build` first")
  process.exit(1)
}
if (!existsSync(join(repo, "prompts", "reviewer-system.txt"))) {
  console.error("prompts/reviewer-system.txt is missing")
  process.exit(1)
}

mkdirSync(stage, { recursive: true })
if (readdirSync(stage).length > 0) {
  console.error(`staged directory is not empty: ${stage}`)
  process.exit(1)
}

// 1. Plugin package: entry via package.json main → dist/index.js (host-loading
//    of a package dir is itself part of the packaged-install verification).
//    Dependencies stay exactly as pinned in the repo; dev tooling is dropped.
const pkg = join(stage, "opencode-llm-approval")
mkdirSync(pkg)
cpSync(dist, join(pkg, "dist"), { recursive: true })
cpSync(join(repo, "prompts"), join(pkg, "prompts"), { recursive: true })
// Host fact (M4, opencode v2.0.18): a config `plugins: [<dir>]` entry resolves
// <dir>/index.ts and does NOT consult package.json main — a package dir
// without index.ts is silently skipped. Ship the shim entry.
writeFileSync(join(pkg, "index.ts"), 'export { default } from "./dist/src/index.js"\n')
const repoPackage = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as {
  version: string
  license: string
  dependencies: Record<string, string>
}
writeFileSync(
  join(pkg, "package.json"),
  JSON.stringify(
    {
      name: "opencode-llm-approval",
      version: repoPackage.version,
      type: "module",
      license: repoPackage.license,
      main: "dist/src/index.js",
      dependencies: repoPackage.dependencies,
    },
    null,
    2,
  ) + "\n",
)
// index.ts shim is written separately (see above); main is kept for tooling.

// 2. Harness plugin: mock-generation instrument wired to the packaged modules.
const harness = join(stage, "m4-harness")
mkdirSync(harness)
cpSync(join(repo, "tests", "manual", "m4-harness-index.ts"), join(harness, "index.ts"))

// 3. Scenario scripts consumed by the harness via M4_SCRIPT.
const scripts = join(stage, "scripts")
mkdirSync(scripts)
const lowJson =
  '{"schemaVersion":2,"risk":"LOW","categories":["READ"],"confidence":"HIGH","signals":[],"summary":"Ограниченное чтение обычного файла."}'
const unknownJson =
  '{"schemaVersion":2,"risk":"UNKNOWN","categories":["UNKNOWN"],"confidence":"LOW","signals":["AMBIGUOUS_SYNTAX"],"summary":"Недостаточно сведений о поведении."}'
const scenarios: Record<string, unknown> = {
  // B1/B2/B5: conforming LOW/READ/HIGH — reaches shadow_would_allow.
  "low.json": { response: lowJson, delayMs: 0 },
  // B3: valid UNKNOWN — deterministic threshold rejection.
  "unknown.json": { response: unknownJson, delayMs: 0 },
  // B4: conforming response that arrives after the LLM deadline.
  "slow-low.json": { response: lowJson, delayMs: 8000 },
}
for (const [name, body] of Object.entries(scenarios)) {
  writeFileSync(join(scripts, name), JSON.stringify(body) + "\n")
}

console.log(`staged package at ${stage}`)
console.log(`plugin dir: ${pkg}`)
console.log("next: bun install --production inside the staged dir (dev deps dropped, so no --frozen-lockfile)")
