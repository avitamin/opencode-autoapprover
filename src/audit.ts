/**
 * Minimized local audit (docs/07): JSONL outside the workspace, per-process
 * serialized appends, size-based rotation, restrictive file modes. An append
 * failure means "no auto" for that request; failures are never re-logged into
 * the same broken sink.
 */
import { appendFile, access, constants, mkdir, rename, stat, unlink } from "node:fs/promises"
// access/constants back the real checkWritable; the class itself stays fully injectable.
import type { AuditPort, AuditRecord } from "./types.js"

export interface AuditFsDeps {
  readonly mkdir: (dir: string) => Promise<void>
  readonly statSize: (path: string) => Promise<number | null>
  readonly appendFile: (path: string, data: string) => Promise<void>
  readonly rename: (from: string, to: string) => Promise<void>
  readonly unlink: (path: string) => Promise<void>
  /** Rejects when the directory is not writable (W_OK probe). */
  readonly checkWritable: (dir: string) => Promise<void>
}

const realDeps: AuditFsDeps = {
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
  checkWritable: (dir) => access(dir, constants.W_OK),
}

export class FileAuditWriter implements AuditPort {
  private readonly dir: string
  private readonly maxFileBytes: number
  private readonly retainedFiles: number
  private readonly fs: AuditFsDeps
  private queue: Promise<void> = Promise.resolve()
  private dirReady: Promise<void> | null = null

  constructor(dir: string, maxFileBytes: number, retainedFiles: number, fsDeps: AuditFsDeps = realDeps) {
    this.dir = dir
    this.maxFileBytes = maxFileBytes
    this.retainedFiles = retainedFiles
    this.fs = fsDeps
  }

  private currentFile(): string {
    return `${this.dir}/audit.jsonl`
  }

  private rotatedFile(index: number): string {
    return `${this.dir}/audit-${index}.jsonl`
  }

  private ensureDir(): Promise<void> {
    if (this.dirReady === null) {
      this.dirReady = this.fs.mkdir(this.dir)
    }
    return this.dirReady
  }

  private async writeOnce(record: AuditRecord): Promise<void> {
    await this.ensureDir()
    const line = `${JSON.stringify(record)}\n`
    const file = this.currentFile()
    const size = await this.fs.statSize(file)
    if (size !== null && size + line.length > this.maxFileBytes) {
      await this.rotate()
    }
    await this.fs.appendFile(file, line)
  }

  private async rotate(): Promise<void> {
    // audit-(n-1) .. audit-1 shifted up by one; oldest removed; current becomes audit-1.
    for (let index = this.retainedFiles - 1; index >= 1; index--) {
      const from = index === 1 ? this.currentFile() : this.rotatedFile(index - 1)
      const to = this.rotatedFile(index)
      const size = await this.fs.statSize(from)
      if (size !== null) {
        await this.fs.rename(from, to)
      }
    }
  }

  /** Serialized append; a rejected append propagates to the caller (controller → ask). */
  append(record: AuditRecord): Promise<void> {
    const next = this.queue.then(() => this.writeOnce(record))
    // Keep the chain alive on failure so later appends are still attempted.
    this.queue = next.catch(() => undefined)
    return next
  }

  /** Directory is creatable/writable: checked before any LLM call so a broken sink cannot coexist with auto-allow. */
  async healthy(): Promise<boolean> {
    try {
      await this.ensureDir()
      await this.fs.checkWritable(this.dir)
      return true
    } catch {
      return false
    }
  }
}
