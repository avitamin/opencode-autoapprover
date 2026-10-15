/**
 * Ask-funnel aggregator (eval stage 1): read-only analysis of the live guard
 * logs (audit.jsonl + trace-*.jsonl) that answers two questions:
 *   1) what mostly falls into `ask` (by reason, by pipeline stage, by day);
 *   2) which of those asks should not have happened (model-side false asks).
 *
 * Output: committable markdown to stdout. Personal paths are normalized
 * (home -> /home/user) so nothing machine-specific lands in the report.
 * Never executes anything from the logs; commands are data only (AGENTS.md).
 *
 * Usage: bun scripts/eval/ask-funnel.ts [--dir ~/.local/state/opencode-llm-approval]
 */
import { readFileSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const HOME = homedir()

interface Args {
  readonly dir: string
}

function parseArgs(): Args {
  const argv = process.argv.slice(2)
  let dir = join(HOME, ".local", "state", "opencode-llm-approval")
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir" && argv[i + 1] !== undefined) {
      dir = argv[i + 1]!
      i++
    }
  }
  return { dir }
}

/** Strip machine-specific prefixes so examples are committable. */
function normalize(text: string): string {
  return text.split(HOME).join("/home/user")
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

interface AuditRecord {
  readonly timestamp?: string
  readonly outcome?: string
  readonly reasonCode?: string
}

interface TraceRecord {
  readonly timestamp?: string
  readonly command?: string
  readonly resources?: readonly string[]
  readonly llmCalled?: boolean
  readonly outcome?: string
  readonly reasonCode?: string
  readonly llmLatencyMs?: number
  readonly assessment?: {
    readonly risk?: string
    readonly categories?: readonly string[]
    readonly confidence?: string
  }
}

function readJsonl(path: string): readonly unknown[] {
  const out: unknown[] = []
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      out.push(JSON.parse(trimmed))
    } catch {
      // Torn tail lines from async writers are expected; skip them.
    }
  }
  return out
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Map<string, number> {
  const map = new Map<string, number>()
  for (const item of items) {
    const k = key(item)
    map.set(k, (map.get(k) ?? 0) + 1)
  }
  return map
}

function renderCounts(map: Map<string, number>): string {
  const rows = [...map.entries()].sort((a, b) => b[1] - a[1])
  const total = rows.reduce((sum, [, n]) => sum + n, 0)
  return rows
    .map(([k, n]) => `| ${n} | ${(100 * n / Math.max(total, 1)).toFixed(1)}% | ${k} |`)
    .join("\n")
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(idx, 0)] ?? 0
}

const PIPELINE_BLOCKERS = new Set([
  "INPUT_MISMATCH",
  "INPUT_UNBOUND",
  "TIMEOUT",
  "PAYLOAD_TOO_LARGE",
  "SECRET_DETECTED",
  "OUTSIDE_SCOPE",
  "PRIVACY_BLOCKED",
  "DUPLICATE_EVENT",
  "MODEL_UNAVAILABLE",
])

function main(): void {
  const { dir } = parseArgs()
  const audit = readJsonl(join(dir, "audit.jsonl")) as readonly AuditRecord[]
  const traces: readonly TraceRecord[] = readdirSync(dir)
    .filter((name) => name.startsWith("trace-") && name.endsWith(".jsonl"))
    .sort((a, b) => a.localeCompare(b))
    .flatMap((name) => readJsonl(join(dir, name)) as readonly TraceRecord[])

  const lines: string[] = []
  const emit = (s = "") => lines.push(s)

  emit("# Ask-воронка: агрегат по живым логам guard")
  emit()
  emit(`Источник: \`${normalize(dir)}\` (audit: ${audit.length} записей, trace: ${traces.length} записей).`)
  emit("Команды нормализованы (домашний каталог -> /home/user); ничего не исполнялось.")
  emit()

  // 1. Overall funnel (audit).
  emit("## 1. Общая воронка (audit, всё время)")
  emit()
  emit("| Событий | Доля | outcome/reason |")
  emit("|---:|---:|---|")
  emit(renderCounts(countBy(audit, (r) => `${r.outcome ?? "?"}/${r.reasonCode ?? "?"}`)))
  emit()

  // 2. Pipeline blockers per day.
  emit("## 2. Динамика ask-блокеров по дням (audit)")
  emit()
  const byDay = countBy(
    audit.filter((r) => (r.outcome ?? "") === "ask" && PIPELINE_BLOCKERS.has(r.reasonCode ?? "")),
    (r) => `${(r.timestamp ?? "?").slice(0, 10)} ${r.reasonCode}`,
  )
  const days = [...new Set([...byDay.keys()].map((k) => k.split(" ")[0]))].sort()
  const reasons = [...new Set([...byDay.keys()].map((k) => k.split(" ")[1] ?? "?"))].sort()
  emit(`| День | ${reasons.join(" | ")} |`)
  emit(`|---|${reasons.map(() => "---:").join("|")}|`)
  for (const day of days) {
    const cells = reasons.map((reason) => String(byDay.get(`${day} ${reason}`) ?? 0))
    emit(`| ${day} | ${cells.join(" | ")} |`)
  }
  emit()

  // 3. LLM-reached segmentation (trace).
  const llm = traces.filter((r) => r.llmCalled === true)
  emit("## 3. Дошедшие до LLM (trace)")
  emit()
  emit("| Событий | Доля | outcome/reason |")
  emit("|---:|---:|---|")
  emit(renderCounts(countBy(llm, (r) => `${r.outcome ?? "?"}/${r.reasonCode ?? "?"}`)))
  emit()

  // 4. Model-side asks: risk x confidence x categories.
  const riskAsks = llm.filter((r) => (r.reasonCode ?? "") === "RISK_ABOVE_THRESHOLD")
  emit("## 4. Ask по вердикту модели (RISK_ABOVE_THRESHOLD, trace)")
  emit()
  emit("| Событий | risk | confidence | categories |")
  emit("|---:|---|---|---|")
  const askProfile = countBy(
    riskAsks,
    (r) =>
      `${r.assessment?.risk ?? "?"}|${r.assessment?.confidence ?? "?"}|${(r.assessment?.categories ?? []).join(",")}`,
  )
  for (const [k, n] of [...askProfile.entries()].sort((a, b) => b[1] - a[1])) {
    const [risk, confidence, categories] = k.split("|")
    emit(`| ${n} | ${risk} | ${confidence} | ${categories} |`)
  }
  emit()
  emit("Топ команд (нормализовано, до 72 символов):")
  emit()
  const topAsks = countBy(riskAsks, (r) => truncate(normalize(r.command ?? "?"), 72))
  for (const [cmd, n] of [...topAsks.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    emit(`- ${n}× \`${cmd}\``)
  }
  emit()

  // 5. Model-side asks that are NOT risk-based (LOW risk but asked).
  const lowAsks = llm.filter(
    (r) => (r.outcome ?? "") === "ask" && r.assessment?.risk === "LOW" && (r.reasonCode ?? "") !== "TIMEOUT",
  )
  emit("## 5. LOW-risk ask (не риск, а confidence/категория — кандидаты разблокировки)")
  emit()
  if (lowAsks.length === 0) {
    emit("_нет_")
  } else {
    for (const r of lowAsks.slice(0, 10)) {
      emit(
        `- [${r.timestamp?.slice(11, 19)}] ${r.reasonCode}: \`${truncate(normalize(r.command ?? "?"), 72)}\` (conf=${r.assessment?.confidence}, cats=${(r.assessment?.categories ?? []).join(",")})`,
      )
    }
  }
  emit()

  // 6. Allows (what already passes) + latency.
  const allows = llm.filter((r) => (r.outcome ?? "") === "allow_prepared")
  emit("## 6. Уже проходящее (allow_prepared) и латентность")
  emit()
  const topAllows = countBy(allows, (r) => truncate(normalize(r.command ?? "?"), 72))
  for (const [cmd, n] of [...topAllows.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    emit(`- ${n}× \`${cmd}\``)
  }
  const latencies = allows.map((r) => r.llmLatencyMs ?? 0).sort((a, b) => a - b)
  emit()
  emit(
    `Латентность allow-оценок: n=${latencies.length}, p50=${percentile(latencies, 50)} мс, p95=${percentile(latencies, 95)} мс, max=${latencies[latencies.length - 1] ?? 0} мс.`,
  )
  emit()

  console.log(lines.join("\n"))
}

main()
