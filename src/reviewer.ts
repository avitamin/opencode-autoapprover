/**
 * Reviewer ports (docs/02): the controller knows only this interface.
 * The stateless native reviewer (ctx.generate.text) lives in
 * opencode/generate-reviewer.ts (M3); the mock below is for offline tests.
 */
import type { ReviewInput, ReviewerFailure, ReviewerPort, ReviewerResult } from "./types.js"

/** Deterministic scripted reviewer for offline tests. Not shipped into any live path. */
export class ScriptedReviewer implements ReviewerPort {
  private readonly queue: (ReviewerResult | Error)[]
  readonly calls: ReviewInput[] = []
  private readonly pendingSignals: AbortSignal[] = []

  constructor(results: readonly (ReviewerResult | Error)[] = []) {
    this.queue = [...results]
  }

  assess(input: ReviewInput, signal: AbortSignal): Promise<ReviewerResult> {
    this.calls.push(input)
    this.pendingSignals.push(signal)
    const next = this.queue.shift()
    if (next === undefined) {
      return Promise.reject(new Error("ScriptedReviewer: queue is empty"))
    }
    if (next instanceof Error) return Promise.reject(next)
    return Promise.resolve(next)
  }

  get callCount(): number {
    return this.calls.length
  }

  get lastSignal(): AbortSignal | undefined {
    return this.pendingSignals[this.pendingSignals.length - 1]
  }

  static text(text: string): ReviewerResult {
    return { ok: true, text }
  }

  static timeout(): ReviewerResult {
    return { kind: "timeout" } satisfies ReviewerFailure
  }

  static transport(message: string, code?: string): ReviewerResult {
    return { kind: "transport", message, ...(code !== undefined ? { code } : {}) } satisfies ReviewerFailure
  }
}
