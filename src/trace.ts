/**
 * Opt-in LLM trace writer (docs/07): JSONL files split by UTC day
 * (trace-YYYY-MM-DD.jsonl), size-based rotation within a day
 * (trace-YYYY-MM-DD-NN.jsonl, NN counted up per day) and retention across
 * files. Restrictive file modes, per-process serialized appends.
 *
 * Unlike the audit sink this writer is best-effort by contract: the
 * controller never awaits it on the decision path and swallows append
 * failures, so a broken trace sink cannot change any effect.
 */
import { appendFile, mkdir, readdir, rename, stat, unlink } from "node:fs/promises"
import type { TracePort, TraceRecord } from "./types.js"

export interface TraceFsDeps {
  readonly mkdir: (dir: string) => Promise<void>
  readonly statSize: (path: string) => Promise<number | null>
  readonly appendFile: (path: string, data: string) => Promise<void>
  readonly rename: (from: string, to: string) => Promise<void>
  readonly readdir: (dir: string) => Promise<readonly string[]>
  readonly unlink: (path: string) => Promise<void>
}

const realDeps: TraceFsDeps = {
  async mkdir(dir) {
    await mkdir(dir, { recursive: true, mode: 0o700 })
  },
  async statSize(path) {
    try {
      return (await stat(path)).size
    } catch {
      return null
    }
  },
  async appendFile(path, data) {
    await appendFile(path, data, { mode: 0o600 })
  },
  rename: (from, to) => rename(from, to),
  async unlink(path) {
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    })
  },
  readdir: (dir) => readdir(dir),
}

/** Own files only: never touches audit.jsonl / audit-N.jsonl in a shared directory. */
const TRACE_FILE = /^trace-(\d{4}-\d{2}-\d{2})(?:-(\d{2,}))?\.jsonl$/

/** UTC day of an ISO timestamp ("2026-09-29T…" → "2026-09-29"). */
function dayOf(timestamp: string): string {
  return timestamp.slice(0, 10)
}

export class FileTraceWriter implements TracePort {
  private readonly dir: string
  private readonly maxFileBytes: number
  private readonly retainedFiles: number
  private readonly fs: TraceFsDeps
  private queue: Promise<void> = Promise.resolve()
  private dirReady: Promise<void> | null = null

  constructor(dir: string, maxFileBytes: number, retainedFiles: number, fsDeps: TraceFsDeps = realDeps) {
    this.dir = dir
    this.maxFileBytes = maxFileBytes
    this.retainedFiles = retainedFiles
    this.fs = fsDeps
  }

  private ensureDir(): Promise<void> {
    if (this.dirReady === null) {
      this.dirReady = this.fs.mkdir(this.dir)
    }
    return this.dirReady
  }

  private currentFile(day: string): string {
    return `${this.dir}/trace-${day}.jsonl`
  }

  /** Highest used rotation index for the day plus one (01, 02, …). */
  private async nextIndex(day: string): Promise<number> {
    let max = 0
    for (const name of await this.fs.readdir(this.dir)) {
      const match = TRACE_FILE.exec(name)
      if (match !== null && match[1] === day && match[2] !== undefined) {
        const index = Number.parseInt(match[2], 10)
        if (Number.isFinite(index) && index > max) max = index
      }
    }
    return max + 1
  }

  /**
   * Keep only the newest retainedFiles trace files. Lexicographic name order
   * is chronological here: older dates sort first, and within a day the
   * rotated index files (older content) sort before the base file because
   * "-" precedes "." in ASCII.
   */
  private async prune(): Promise<void> {
    const names = (await this.fs.readdir(this.dir))
      .filter((name) => TRACE_FILE.test(name))
      .sort()
    while (names.length > this.retainedFiles) {
      const name = names.shift()
      if (name === undefined) break
      await this.fs.unlink(`${this.dir}/${name}`)
    }
  }

  private async writeOnce(record: TraceRecord): Promise<void> {
    await this.ensureDir()
    const line = `${JSON.stringify(record)}\n`
    const day = dayOf(record.timestamp)
    const file = this.currentFile(day)
    const size = await this.fs.statSize(file)
    if (size !== null && size + line.length > this.maxFileBytes) {
      const suffix = String(await this.nextIndex(day)).padStart(2, "0")
      await this.fs.rename(file, `${this.dir}/trace-${day}-${suffix}.jsonl`)
    }
    await this.fs.appendFile(file, line)
    await this.prune()
  }

  /** Serialized append; rejections propagate to the caller (controller swallows them). */
  append(record: TraceRecord): Promise<void> {
    const next = this.queue.then(() => this.writeOnce(record))
    // Keep the chain alive on failure so later appends are still attempted.
    this.queue = next.catch(() => undefined)
    return next
  }
}
