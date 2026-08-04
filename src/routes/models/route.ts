import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { state } from "~/lib/state"
import { cacheModels } from "~/lib/utils"

export const modelRoutes = new Hono()

modelRoutes.get("/", async (c) => {
  try {
    // Codex appends client_version and expects its own model-catalog schema.
    // An empty catalog keeps Codex's bundled metadata and instructions; partial
    // remote entries would replace them instead of merging individual fields.
    if (c.req.query("client_version") !== undefined) {
      return c.json({ models: [] })
    }

    if (!state.models) {
      // This should be handled by startup logic, but as a fallback.
      await cacheModels()
    }

    const models = state.models?.data.map((model) => ({
      id: model.id,
      object: "model",
      type: "model",
      created: 0, // No date available from source
      created_at: new Date(0).toISOString(), // No date available from source
      owned_by: model.vendor,
      display_name: model.name,
      capabilities: model.capabilities,
      supported_capabilities: inferClaudeCodeCapabilities(model),
    }))

    return c.json({
      object: "list",
      data: models,
      has_more: false,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})

function inferClaudeCodeCapabilities(
  model: NonNullable<typeof state.models>["data"][number],
): Array<string> {
  const capabilities = new Set<string>()
  const supports = model.capabilities.supports

  if (supports.reasoning_effort?.length) {
    capabilities.add("effort")
    if (supports.reasoning_effort.includes("xhigh")) {
      capabilities.add("xhigh_effort")
    }
    if (supports.reasoning_effort.includes("max")) {
      capabilities.add("max_effort")
    }
  }

  if (supports.adaptive_thinking) {
    capabilities.add("thinking")
    capabilities.add("adaptive_thinking")
    capabilities.add("interleaved_thinking")
  }

  return [...capabilities]
}
