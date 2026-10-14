/**
 * M4 mock-generation harness (docs/08 testing, S02–S07): a TEST-BUILD plugin
 * that wires the PACKAGED guard modules to the real host surface with the
 * generation transport replaced by a scripted in-process mock. It records a
 * trace JSONL for later assertions. Nothing here ships in the production
 * plugin; the production entry never reads M4_* env vars.
 *
 * Staged (copied) outside the working tree by scripts/make-package.ts and
 * loaded as a local plugin. Reads at setup time:
 *   M4_PKG_DIR  staged package dir (dist/ + prompts/)        [required]
 *   M4_TRACE    trace output JSONL path                       [required]
 *   M4_SCRIPT   scenario JSON { response, delayMs }           [required]
 *   M4_MODEL    "providerID/id" marker to look for in the host model catalog
 *
 * The plugin surface is described structurally (no SDK import needed inside
 * the staged harness dir; the packaged adapter resolves its own dependencies).
 */
import { appendFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { GuardHostSurface, wireGuard } from "../../src/opencode/adapter.js"
import type { GenerateTextLike } from "../../src/opencode/generate-reviewer.js"

type PermissionDomainLike = GuardHostSurface["permission"]
type ToolDomainLike = GuardHostSurface["tool"]
type ModelDomainLike = GuardHostSurface["model"]
/** Host generation API domain (GenerateApi): an object with a text method. */
type GenerateDomainObject = { readonly text: GenerateTextLike }

/** ctx.plugin.list (composition evidence); not part of GuardHostSurface. */
interface PluginDomainLike {
  list: () => Promise<{ data: readonly { id?: string; source: { type: string; path?: string; target?: string }; state: { status: string; error?: string } }[] }>
}

interface HarnessContext {
  readonly app: { readonly name: string; readonly version: string; readonly channel: string }
  readonly location: { readonly directory: string }
  readonly permission: PermissionDomainLike
  readonly tool: ToolDomainLike
  readonly model?: ModelDomainLike
  readonly plugin?: PluginDomainLike
  /** Present in live mode: the host's real generation API domain ({text}). */
  readonly generate?: GenerateDomainObject
  readonly [key: string]: unknown
}

type WireGuardFn = typeof wireGuard

function env(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.length === 0) throw new Error(`missing env ${name}`)
  return value
}

function makeTrace(path: string): (type: string, data: Record<string, unknown>) => void {
  return (type, data) => {
    try {
      appendFileSync(path, `${JSON.stringify({ t: new Date().toISOString(), type, ...data })}\n`)
    } catch {
      // The trace must never break the host process.
    }
  }
}

function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal !== undefined && signal.aborted) {
      reject(new DOMException("aborted", "AbortError"))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new DOMException("aborted", "AbortError"))
    }
    const timer = setTimeout(() => {
      if (signal !== undefined) signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    if (signal !== undefined) signal.addEventListener("abort", onAbort, { once: true })
  })
}

export default {
  id: "m4-mock-harness",
  async setup(ctx: HarnessContext): Promise<() => Promise<void>> {
    const trace = makeTrace(env("M4_TRACE"))
    const pkgDir = env("M4_PKG_DIR")
    const mode = process.env.M4_MODE === "live" ? "live" : "mock"
    const script =
      mode === "live"
        ? { response: "", delayMs: 0 }
        : (JSON.parse(readFileSync(env("M4_SCRIPT"), "utf8")) as { response: string; delayMs: number })
    const modelMarker = process.env.M4_MODEL ?? ""
    const [markerProvider, markerId] = modelMarker.split("/")

    trace("setup", {
      mode,
      app: { name: ctx.app.name, version: ctx.app.version, channel: ctx.app.channel },
      surfaceKeys: Object.keys(ctx).sort(),
      script: { delayMs: script.delayMs, responseBytes: script.response.length },
    })

    // Composition evidence: the real loaded-plugin list of this host run.
    if (ctx.plugin !== undefined) {
      try {
        const listed = await ctx.plugin.list()
        trace("plugin.list", {
          plugins: listed.data.map((p) => ({ id: p.id ?? null, source: p.source.type, status: p.state.status })),
        })
      } catch (error) {
        trace("plugin.list", { error: String(error).slice(0, 200) })
      }
    } else {
      trace("plugin.list", { missing: true })
    }

    // The substituted piece depends on M4_MODE:
    //  - "mock" (default): scripted in-process transport, no network.
    //  - "live" (T11, operator-consented): a recording pass-through that
    //    calls the REAL ctx.generate.text and traces the raw response.
    const realGenerate = ctx.generate
    const generate: GenerateTextLike = async (input, requestOptions) => {
      trace("generate.call", {
        mode,
        promptBytes: input.prompt.length,
        promptHead: input.prompt.slice(0, 160),
        promptTail: input.prompt.slice(-240),
        model: input.model,
        hasSignal: requestOptions?.signal !== undefined,
      })
      if (mode === "live" && realGenerate !== undefined) {
        const startedAt = Date.now()
        try {
          const result = await realGenerate.text(input, requestOptions)
          trace("generate.settle", { kind: "fulfilled-live", latencyMs: Date.now() - startedAt, response: result.text })
          return result
        } catch (error) {
          trace("generate.settle", {
            kind: error instanceof Error && error.name === "AbortError" ? "aborted" : "error",
            latencyMs: Date.now() - startedAt,
            name: error instanceof Error ? error.name : null,
            message: error instanceof Error ? error.message.slice(0, 200) : null,
          })
          throw error
        }
      }
      try {
        await abortableDelay(script.delayMs, requestOptions?.signal)
      } catch (error) {
        trace("generate.settle", { kind: "aborted", name: error instanceof Error ? error.name : null })
        throw error
      }
      trace("generate.settle", { kind: "fulfilled" })
      return { text: script.response }
    }

    const hostModel = ctx.model
    const model =
      hostModel === undefined
        ? undefined
        : {
            list: async () => {
              const listed = await hostModel.list()
              const configuredModelPresent =
                markerId !== undefined && markerId.length > 0
                  ? listed.data.some((entry) => entry.providerID === markerProvider && entry.id === markerId)
                  : null
              trace("model.list", { total: listed.data.length, configuredModelPresent })
              return listed
            },
          }

    const adapter = (await import(join(pkgDir, "dist", "src", "opencode", "adapter.js"))) as {
      wireGuard: WireGuardFn
    }
    const guard = await adapter.wireGuard({
      location: ctx.location,
      pluginDirectory: pkgDir,
      permission: ctx.permission,
      tool: ctx.tool,
      generate,
      ...(model !== undefined ? { model } : {}),
    })

    return async () => {
      trace("dispose", {})
      await guard.dispose()
    }
  },
}
