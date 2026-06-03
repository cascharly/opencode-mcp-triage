/*
 * opencode-mcp-triage — Subagent Router Plugin
 * ==============================================
 * Version: 0.8.0
 * License: MIT
 *
 * Routes MCP work to scoped subagents. On first run, automatically
 * disables all MCP tools globally in opencode.jsonc so they don't
 * consume tokens in the main agent. Subagents re-enable specific
 * servers via tool scoping.
 *
 * How it works:
 * 1. Plugin init: reads MCP servers + subagents from config
 * 2. Writes "servername_*": false to project config (disables MCP tools in main session)
 * 3. Exposes triage_mcp tool: scores user query against subagent names/descriptions/MCP names
 * 4. Returns best-matching subagent — user invokes it via @name or Task tool
 *
 * Token savings: MCP tools have large descriptions. Disabling them in the
 * main session saves ~80% of MCP-related tokens. Subagents only carry
 * their scoped servers' tools.
 *
 * Install:  { "plugin": ["opencode-mcp-triage"] }  in opencode.jsonc
 * Docs:     https://github.com/cascharly/opencode-mcp-triage
 */

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import type { McpServer, Subagent } from "./types.js"
import { readMcpConfig, readSubagentConfig } from "./config.js"
import { scoreSubagents, THRESHOLD } from "./triage.js"
import { ensureToolsDisabled, ensureSubagentsCreated, removeToolsDisable } from "./writer.js"
import { isTriageEnabled, toggleTriage, readLock } from "./lock.js"
import { calcAssignedMcps } from "./utils.js"

/** Cache TTL: 5 seconds — balances freshness with performance */
const CACHE_TTL_MS = 5000

/** Reload debounce: 1 second cooldown to prevent spam */
const RELOAD_COOLDOWN_MS = 1000

/**
 * Mutable plugin state — updated on init and reload.
 *
 * mcpServers: all MCP servers from config (name + description)
 * subagents: agents with MCP tool scoping
 * mcpNames: flat list of MCP server names (for display)
 * assignedMcps: set of MCP names that have at least one subagent
 */
interface State {
  mcpServers: McpServer[]
  subagents: Subagent[]
  mcpNames: string[]
  assignedMcps: Set<string>
}

/**
 * Generic cache with TTL.
 * Stores a value with an expiry timestamp. Returns null if expired.
 */
interface CacheEntry<T> {
  value: T
  expiresAt: number
}

interface Cache<T> {
  get(): T | null
  set(value: T): void
  invalidate(): void
  /** Returns remaining TTL in ms, or 0 if expired/empty */
  remainingTtl(): number
}

function createCache<T>(ttlMs: number): Cache<T> {
  let entry: CacheEntry<T> | null = null

  return {
    get(): T | null {
      if (entry && Date.now() < entry.expiresAt) {
        return entry.value
      }
      return null
    },
    set(value: T) {
      entry = { value, expiresAt: Date.now() + ttlMs }
    },
    invalidate() {
      entry = null
    },
    remainingTtl(): number {
      if (!entry) return 0
      const remaining = entry.expiresAt - Date.now()
      return remaining > 0 ? remaining : 0
    },
  }
}

/**
 * Builds state from raw config data.
 *
 * assignedMcps tracks which MCP servers are covered by subagents.
 * Used to report unassigned servers (no subagent handles them).
 */
function buildState(mcpServers: McpServer[], subagents: Subagent[]): State {
  return {
    mcpServers,
    subagents,
    mcpNames: mcpServers.map((s) => s.name),
    assignedMcps: calcAssignedMcps(subagents),
  }
}

/**
 * Sends a TUI toast notification via OpenCode client.
 * Gracefully handles missing client.tui (older OpenCode versions).
 */
function showToast(
  client: unknown,
  message: string,
  variant: "success" | "info" | "error" = "info"
) {
  try {
    const c = client as { tui?: { showToast?: (...args: unknown[]) => unknown } }
    c.tui?.showToast?.({ message, variant })
  } catch {
    // TUI not available — silently skip
  }
}

/**
 * OpenCode plugin entry point.
 *
 * Runs once when OpenCode starts. Must complete before returning —
 * ensureToolsDisabled writes to config file and must finish before
 * the main agent starts using tools.
 *
 * Returns two tools:
 * - triage_mcp: routes queries to the best subagent
 * - mcp_stats: shows routing status and token savings
 */
export const server: Plugin = async ({ directory, client }) => {
  // Config caches with 5s TTL — picks up CLI toggles without restart
  const mcpCache = createCache<McpServer[]>(CACHE_TTL_MS)
  const subagentCache = createCache<Subagent[]>(CACHE_TTL_MS)

  // Reload debounce: track last reload time to prevent spam
  let lastReloadAt = 0

  // Read locks: prevent redundant concurrent config reads when cache is cold
  let mcpReadLock: Promise<McpServer[]> | null = null

  async function getCachedMcpServers(): Promise<McpServer[]> {
    const cached = mcpCache.get()
    if (cached) return cached
    if (mcpReadLock) return mcpReadLock
    mcpReadLock = (async () => {
      try {
        const result = await readMcpConfig(directory)
        mcpCache.set(result)
        return result
      } finally {
        mcpReadLock = null
      }
    })()
    return mcpReadLock
  }

  let subagentReadLock: Promise<Subagent[]> | null = null

  async function getCachedSubagents(): Promise<Subagent[]> {
    const cached = subagentCache.get()
    if (cached) return cached
    if (subagentReadLock) return subagentReadLock
    subagentReadLock = (async () => {
      try {
        const result = await readSubagentConfig(directory)
        subagentCache.set(result)
        return result
      } finally {
        subagentReadLock = null
      }
    })()
    return subagentReadLock
  }

  const mcpServers = await getCachedMcpServers()
  const mcpNames = mcpServers.map((s) => s.name)

  // Check if triage is enabled (lock file, defaults to true)
  const triageEnabled = await isTriageEnabled(directory)

  let subagents: Subagent[] = []

  if (triageEnabled) {
    // Phase 1: disable all MCP tools in main agent
    // This MUST complete before returning — otherwise main session
    // could use MCP tools before they're disabled
    await ensureToolsDisabled(directory, mcpNames)

    // Phase 2: read current subagents, then auto-create for unassigned MCPs
    subagents = await getCachedSubagents()
    const created = await ensureSubagentsCreated(directory, mcpServers, subagents)
    if (created > 0) {
      // Re-read after auto-create so state is accurate
      subagentCache.invalidate()
      subagents = await getCachedSubagents()
    }
  }

  const state = buildState(mcpServers, subagents)

  return {
    tool: {
      /**
       * Triage Tool: matches a user query to the best subagent.
       *
       * Scoring uses keyword matching against subagent name, description,
       * and assigned MCP server names. Returns the top match if the score
       * gap exceeds THRESHOLD, otherwise shows multiple options.
       *
       * Special queries:
       * - "reload": re-reads config without restarting OpenCode
       * - "": lists all available subagents
       */
      triage_mcp: tool({
        description:
          "Route a task to the best MCP subagent via keyword matching. " +
          "Call before MCP work; use 'reload' to refresh config.",
        args: {
          query: tool.schema
            .string()
            .describe(
              "Short task description, or 'reload' to refresh MCP config"
            ),
        },
        async execute(args, context) {
          // Abort signal handling — check if request was cancelled
          if (context?.abort?.aborted) {
            return "Triage cancelled."
          }

          const query = args.query.trim()

          // "toggle" — enable/disable triage
          if (query.toLowerCase() === "toggle") {
            const current = await isTriageEnabled(directory)
            const next = !current
            if (next) {
              const mcpServers = await getCachedMcpServers()
              const mcpNames = mcpServers.map((s) => s.name)
              await ensureToolsDisabled(directory, mcpNames)
              await toggleTriage(directory, true)
              subagentCache.invalidate()
              const sa = await getCachedSubagents()
              const fresh = buildState(await getCachedMcpServers(), sa)
              Object.assign(state, fresh)
            } else {
              // Re-fetch to ensure we remove disable entries for any MCPs added
              // since the cache was last populated.
              const mcpServers = await getCachedMcpServers()
              const mcpNames = mcpServers.map((s) => s.name)
              await removeToolsDisable(directory, mcpNames)
              await toggleTriage(directory, false)
              Object.assign(state, buildState(mcpServers, []))
            }
            showToast(client, `Triage ${next ? "enabled" : "disabled"}`, next ? "success" : "info")
            const status = next ? "● on" : "○ off"
            return `Triage ${status}. ${next ? `MCP tools hidden from main session (${state.mcpServers.length} server(s)).` : "MCP tools restored to main session."}`
          }

          // "reload" — re-read config files without restarting
          if (query.toLowerCase() === "reload") {
            // Debounce: prevent spam reloads
            const now = Date.now()
            if (now - lastReloadAt < RELOAD_COOLDOWN_MS) {
              return "Reload cooldown active. Try again in a moment."
            }
            lastReloadAt = now

            mcpCache.invalidate()
            subagentCache.invalidate()
            state.mcpServers = await getCachedMcpServers()
            let sa = await getCachedSubagents()
            const created = await ensureSubagentsCreated(
              directory,
              state.mcpServers,
              sa
            )
            if (created > 0) {
              subagentCache.invalidate()
              sa = await getCachedSubagents()
            }
            state.subagents = sa
            const fresh = buildState(state.mcpServers, state.subagents)
            Object.assign(state, fresh)
            const lines = ["MCP config reloaded."]
            if (created > 0) {
              lines.push(`Auto-created ${created} subagent(s) for new MCP(s).`)
            }
            lines.push(
              `Subagents: ${state.subagents.map((s) => s.name).join(", ") || "none"}`
            )
            lines.push(
              `MCP servers: ${state.mcpServers.map((s) => s.name).join(", ") || "none"}`
            )
            showToast(client, "MCP config reloaded", "success")
            return lines.join("\n")
          }

          // Empty query — list all subagents
          if (!query) {
            if (state.subagents.length === 0) {
              return [
                "No MCP subagents configured.",
                "",
                "Add subagents in opencode.jsonc under 'agent' section with tool scoping.",
              ].join("\n")
            }
            const lines = ["Available subagents:"]
            for (const sa of state.subagents) {
              const mcps = sa.mcpServers.join(", ")
              lines.push(
                `  @${sa.name} — ${sa.description || "no description"}${mcps ? ` [${mcps}]` : ""}`
              )
            }
            lines.push("")
            lines.push("Use @agent-name in your message to invoke a subagent.")
            return lines.join("\n")
          }

          // No subagents configured — show setup instructions
          if (state.subagents.length === 0) {
            return [
              "No MCP subagents configured.",
              "",
              "Add subagents in opencode.jsonc:",
              `  "agent": { "myserver": { "mode": "subagent", "description": "...", "tools": { "myserver_*": true } } }`,
            ].join("\n")
          }

          // Score and rank subagents
          const scored = scoreSubagents(query, state.subagents)
            .filter((s) => s.score > 0)
            .sort((a, b) => b.score - a.score)

          // No matches — show available options
          if (scored.length === 0) {
            const names = state.subagents.map((s) => s.name).join(", ")
            showToast(client, `No match for "${query}"`, "error")
            return [
              `No subagent matches "${query}".`,
              `Available: ${names}`,
              "",
              "Try broader keywords or call triage_mcp with empty query to list all.",
            ].join("\n")
          }

          // Check if top match is clearly better than runner-up
          const gap = scored[0].score - (scored[1]?.score ?? 0)

          if (gap >= THRESHOLD || scored.length === 1) {
            // Clear winner — route to it
            const match = scored[0]
            const mcps = match.subagent.mcpServers.join(", ")
            const lines = [
              `ROUTED: @${match.subagent.name}`,
              match.subagent.description
                ? `  ${match.subagent.description}`
                : "",
              mcps ? `  MCP: ${mcps}` : "",
              `  Matched by: ${match.matchedBy.join(", ")}`,
              "",
              `Invoke with @${match.subagent.name} in your message, or use the Task tool:`,
              `  task({ subagent_type: "${match.subagent.name}", prompt: "..." })`,
            ]
            showToast(client, `Routed to @${match.subagent.name}`, "success")
            return lines.join("\n")
          }

          // Too close to call — show top 5 options
          const top = scored.slice(0, 5)
          const lines = [`Multiple subagents match "${query}":`, ""]
          top.forEach((s, i) => {
            const mcps = s.subagent.mcpServers.join(", ")
            lines.push(
              `  ${i + 1}. @${s.subagent.name}${s.subagent.description ? ` — ${s.subagent.description}` : ""}${mcps ? ` [${mcps}]` : ""}`
            )
          })
          lines.push("")
          lines.push(
            `Be more specific, or name the subagent directly: @${top[0].subagent.name}`
          )
          showToast(client, `${scored.length} subagents match`, "info")
          return lines.join("\n")
        },
      }),

      /**
       * Stats tool: displays routing status and token savings.
       *
       * Shows:
       * - Subagent routing map (which subagent handles which MCP servers)
       * - Unassigned servers (no subagent covers them)
       * - Token savings confirmation (0 MCP tokens in main session)
       * - Coverage percentage
       */
      mcp_stats: tool({
        description:
          "Show MCP subagent routing status and token savings. " +
          "Displays which MCP servers are routed to which subagents. " +
          "MCP tools in main session are disabled — only subagents carry them.",
        args: {},
        async execute() {
          const lines: string[] = []
          const { subagents: sa, mcpNames, assignedMcps } = state

          lines.push("MCP Subagent Routing Status")
          lines.push("")

          if (sa.length === 0) {
            lines.push("  No subagents configured.")
            lines.push("")
            lines.push(
              "  Configure subagents with MCP tool scoping for token savings."
            )
            return lines.join("\n")
          }

          lines.push(
            `  Strategy: Global disable → Subagent enable via tool scoping`
          )
          lines.push(
            `  Subagents: ${sa.length}  |  MCP servers: ${mcpNames.length}`
          )
          lines.push("")
          lines.push("  Subagent routing map:")
          lines.push("  ─".repeat(30))

          for (const s of sa) {
            const mcps = s.mcpServers.join(", ")
            lines.push(
              `  @${s.name.padEnd(18)} → ${mcps || "no MCP servers"}`
            )
            if (s.description) {
              lines.push(`  ${" ".repeat(19)}${s.description}`)
            }
          }

          // Find MCP servers not assigned to any subagent
          const unassigned = mcpNames.filter(
            (n) => !sa.some((s) => s.mcpServers.includes(n))
          )
          if (unassigned.length > 0) {
            lines.push("")
            lines.push(
              `  Unassigned: ${unassigned.join(", ")} (no subagent)`
            )
          }

          const assigned = assignedMcps.size
          const pct = mcpNames.length > 0
            ? Math.round((assigned / mcpNames.length) * 100)
            : 0

          lines.push("")
          lines.push("  ─".repeat(30))
          lines.push(
            `  MCP tools in main session: 0 tokens (globally disabled)`
          )
          lines.push(
            `  MCP coverage: ${assigned}/${mcpNames.length} servers routed (${pct}%)`
          )

          return lines.join("\n")
        },
      }),
    },

    /**
     * Cache warming: pre-fetch config on user message when cache near expiry.
     * Skips if TTL > 1s remaining to avoid unnecessary I/O.
     * Ensures triage tool has fresh data without waiting for first call.
     */
    async "chat.message"() {
      if (mcpCache.remainingTtl() < 1000) {
        getCachedMcpServers().catch(() => {})
      }
      if (subagentCache.remainingTtl() < 1000) {
        getCachedSubagents().catch(() => {})
      }
    },

    /**
     * System prompt transform: inject MCP routing status into system prompt.
     *
     * Adds a compact summary of available MCP subagents so the AI knows
     * about routing without needing to call triage_mcp first.
     *
     * Guard: output.system must exist and be an array (handles undefined,
     * null, or non-array values that would crash on .push()).
     */
    async "experimental.chat.system.transform"(_input, output) {
      if (!output?.system || !Array.isArray(output.system)) return

      const mcpServers = await getCachedMcpServers()
      const subagents = await getCachedSubagents()

      if (subagents.length === 0) return

      // Strip only chars that would break the system prompt line — quotes,
      // backslashes, newlines, and control chars. Keep unicode, hyphens,
      // dots, slashes, etc. for human-readable subagent/MCP names.
      const sanitize = (s: string) => s.replace(/["\\\n\r\t\0]/g, "")

      const routes = subagents
        .map((sa) => `@${sanitize(sa.name)} → ${sa.mcpServers.map(sanitize).join(", ")}`)
        .join("; ")

      const routingInfo = `MCP Routing: ${subagents.length} subagent(s) available. ${routes}. Use triage_mcp tool to route queries.`
      output.system.push(routingInfo)
    },
  }
}
