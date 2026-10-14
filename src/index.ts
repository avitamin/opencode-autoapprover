/**
 * Plugin entry point (docs/02): load, registration, cleanup — minimum logic.
 *
 * M3: the stateless native reviewer (ctx.generate.text) is wired through the
 * adapter with the configured model, the shipped reviewer instruction and the
 * host model catalog gate. Live LLM traffic still requires the operator's
 * privacy consent + non-off mode in the installed guard config (M4/M5).
 */
import { Plugin } from "@opencode/plugin"
import { fileURLToPath } from "node:url"
import { wireGuard } from "./opencode/adapter.js"

/** Directory of the installed plugin package (prompts/ ships beside the entry). */
// Built entry is dist/src/index.js; the bundled prompts/ directory is at the package root.
const pluginDirectory = fileURLToPath(new URL("../..", import.meta.url))

export default Plugin.define({
  id: "opencode-llm-approval",
  async setup(ctx) {
    const guard = await wireGuard({
      location: ctx.location,
      pluginDirectory,
      permission: ctx.permission,
      tool: ctx.tool,
      // Detached calls keep the original SDK receivers bound.
      generate: (input, requestOptions) => ctx.generate.text(input, requestOptions),
      model: { list: () => ctx.model.list() },
    })
    return guard.dispose
  },
})
