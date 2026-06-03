#!/usr/bin/env node
/*
 * opencode-mcp-triage CLI v0.8.0 — Subagent Router for MCP Tools
 *
 * Reads MCP config and shows server status, subagent routing,
 * and tool visibility. Reuses src/ config readers — no duplication.
 *
 * Features:
 * - Colored output matching opencode-triage style
 * - Hidden vs exposed MCP tool visibility
 * - Levenshtein typo correction for commands
 * - JSON output mode (--json)
 * - Benchmarking (--benchmark)
 */

import { readRawConfig, findConfigPath, readMcpConfig, readSubagentConfig } from "./config.js"
import type { McpConfigEntry } from "./types.js"
import { calcAssignedMcps } from "./utils.js"
import { levenshtein, suggestCommand } from "./utils.js"
import { ensureToolsDisabled, removeToolsDisable, removeAutoSubagents, removePluginEntry } from "./writer.js"
import { isTriageEnabled, toggleTriage, readLock } from "./lock.js"
import { unlink } from "node:fs/promises"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { homedir } from "node:os"
import { spawn } from "node:child_process"

const PLUGIN_NAME = "opencode-mcp-triage"

/** MCP protocol version announced during initialize. Override via MCP_PROTOCOL_VERSION env. */
const MCP_PROTOCOL_VERSION = process.env.MCP_PROTOCOL_VERSION || "2024-11-05"

const COMMANDS: Record<string, string> = {
  status: "Show MCP server status, hidden/exposed tools, and subagent routing",
  list: "List all configured MCP servers and subagents",
  measure: "Measure token savings by connecting to each MCP server",
  enable: "Enable triage — disable MCP tools in main session",
  disable: "Disable triage — restore MCP tools to main session",
  uninstall: "Remove plugin: delete disable entries, auto-created subagents, lock file",
  help: "Show available commands",
}

const YELLOW = "\x1b[33m"
const GREEN = "\x1b[32m"
const RED = "\x1b[31m"
const CYAN = "\x1b[36m"
const RESET = "\x1b[0m"
const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"

// ── Config helpers ─────────────────────────────────────────

function isPluginActive(
  config: Record<string, unknown> | null,
  searchPath: string
): boolean {
  if (!config) return false
  const plugins = config.plugin as unknown[] | undefined
  if (!Array.isArray(plugins)) return false
  // Match either the npm package name, a file: path pointing at the plugin,
  // or a local path whose last segment contains the package name. Anchored
  // with path separator or start/end to avoid matching unrelated paths that
  // happen to contain "opencode-mcp-triage" as a substring.
  return plugins.some((pl) => {
    if (typeof pl !== "string") return false
    if (pl === PLUGIN_NAME) return true
    if (pl.startsWith("file:")) {
      // Accept file: URL of the installed package, or a local dev path
      return pl === "file:" + searchPath || /[\\/]opencode-mcp-triage([\\/]|$)/.test(pl)
    }
    return false
  })
}

/**
 * Extracts tool patterns explicitly disabled (set to false).
 * Takes tools map directly (not whole config) for flexibility.
 */
function extractDisabledPatterns(
  tools: Record<string, unknown>
): string[] {
  return Object.entries(tools)
    .filter(([, v]) => v === false)
    .map(([k]) => k)
}

/**
 * Merged configs from both levels with project-over-global semantics.
 * Single read reduces I/O — used by cmdStatus, cmdList, cmdMeasure.
 */
interface MergedConfigs {
  project: Record<string, unknown> | null
  global: Record<string, unknown> | null
  mcp: Record<string, McpConfigEntry>
  agent: Record<string, { mode?: string; description?: string; tools?: Record<string, boolean> }>
  tools: Record<string, unknown>
}

/**
 * Reads global + project config in parallel and merges all sections.
 * Project overrides global for same-named entries.
 */
async function loadMergedConfigs(cwd: string): Promise<MergedConfigs> {
  const [project, global] = await Promise.all([
    readRawConfig(cwd),
    readRawConfig(homedir()),
  ])
  return {
    project,
    global,
    mcp: {
      ...(global?.mcp as Record<string, McpConfigEntry> || {}),
      ...(project?.mcp as Record<string, McpConfigEntry> || {}),
    },
    agent: {
      ...(global?.agent as Record<string, { mode?: string; description?: string; tools?: Record<string, boolean> }> || {}),
      ...(project?.agent as Record<string, { mode?: string; description?: string; tools?: Record<string, boolean> }> || {}),
    },
    tools: {
      ...(global?.tools as Record<string, unknown> || {}),
      ...(project?.tools as Record<string, unknown> || {}),
    },
  }
}

// ── Commands ───────────────────────────────────────────────

async function cmdStatus(
  cwd: string,
  asJson: boolean
): Promise<void> {
  const config = await loadMergedConfigs(cwd)

  const localActive = isPluginActive(config.project, cwd)
  const globalActive = isPluginActive(config.global, "")

  const mcpServers = await readMcpConfig(cwd)
  const subagents = await readSubagentConfig(cwd)
  const triageOn = await isTriageEnabled(cwd)

  const disabledPatterns = extractDisabledPatterns(config.tools)
  const mcpNames = mcpServers.map((s) => s.name)

  const assigned = calcAssignedMcps(subagents)

  const hidden = mcpNames.filter((n) =>
    disabledPatterns.some((p) => p === `${n}_*`)
  )
  const exposed = mcpNames.filter((n) =>
    !disabledPatterns.some((p) => p === `${n}_*`)
  )

  const outOfSync: string[] = []
  if (localActive && exposed.length > 0) {
    outOfSync.push(`${exposed.length} MCP tool(s) exposed in project while plugin is ACTIVE`)
  }
  if (globalActive && exposed.length > 0) {
    outOfSync.push(`${exposed.length} MCP tool(s) exposed globally while plugin is ACTIVE`)
  }

  if (asJson) {
    const routingMap = subagents.map((sa) => ({
      name: sa.name,
      mcps: sa.mcpServers,
      description: sa.description,
    }))
    console.log(JSON.stringify({
      project: {
        plugin: localActive ? "active" : "inactive",
        mcpServers: mcpNames.length,
        subagents: subagents.length,
      },
      global: {
        plugin: globalActive ? "active" : "inactive",
      },
      mcpVisibility: { hidden, exposed },
      routingMap,
      unassigned: mcpNames.filter((n) => !assigned.has(n)),
      outOfSync: outOfSync.length > 0 ? outOfSync : null,
    }, null, 2))
    return
  }

  const scopeSummary: string[] = []
  if (localActive) scopeSummary.push(GREEN + "●" + RESET + DIM + " local" + RESET)
  if (globalActive) scopeSummary.push(GREEN + "●" + RESET + DIM + " global" + RESET)
  if (!localActive && !globalActive) scopeSummary.push(DIM + "○ inactive" + RESET)

  console.log()
  console.log(BOLD + "● MCP Triage Status" + RESET + DIM + " — " + scopeSummary.join(DIM + " · " + RESET + DIM) + RESET)
  console.log()
  console.log(`  ${DIM}MCP servers:${RESET} ${mcpNames.length}  │  ${DIM}Subagents:${RESET} ${subagents.length}  │  ${DIM}Assigned:${RESET} ${assigned.size}/${mcpNames.length}`)
  console.log()

  if (outOfSync.length > 0) {
    console.log(`  ${YELLOW}⚠ ${outOfSync.join("; ")} — run plugin init to hide them${RESET}`)
    console.log()
  }

  if (hidden.length > 0) {
    console.log(`  ${DIM}── Hidden (disabled in main session) ─────────────────${RESET}`)
    for (const n of hidden) {
      console.log(`  ${GREEN}[hidden]${RESET}  ${n}`)
    }
    console.log()
  }

  if (exposed.length > 0) {
    console.log(`  ${DIM}── Exposed (visible in main session) ─────────────────${RESET}`)
    for (const n of exposed) {
      console.log(`  ${YELLOW}[exposed]${RESET}  ${n}`)
    }
    console.log()
  }

  console.log(`  ${DIM}Triage state:${RESET}  ${triageOn ? GREEN + "● on" + RESET : YELLOW + "○ off" + RESET}`)
  console.log()

  if (hidden.length === 0 && exposed.length === 0) {
    console.log(`  ${DIM}(no MCP servers configured)${RESET}`)
    console.log()
  }

  if (subagents.length > 0) {
    console.log(`  ${DIM}── Subagent routing map ──────────────────────────────${RESET}`)
    for (const sa of subagents) {
      const mcps = sa.mcpServers.join(", ")
      console.log(`  ${CYAN}@${sa.name.padEnd(18)}${RESET} → ${mcps || "no MCP"}${sa.description ? DIM + ` (${sa.description})` + RESET : ""}`)
    }
    console.log()
  }

  if (hidden.length > 0 && exposed.length === 0) {
    console.log(`  ${GREEN}All MCP tools hidden from main session${RESET}`)
  } else if (exposed.length > 0) {
    console.log(`  ${YELLOW}${exposed.length} MCP tool(s) still visible in main session${RESET}`)
  }

  console.log()
  console.log(`  ${DIM}── Token savings ───────────────────────────────────────${RESET}`)
  console.log(`  ${DIM}Run ${CYAN}opencode-mcp-triage measure${RESET}${DIM} to connect and measure${RESET}`)
  console.log(`  ${DIM}actual token savings from each MCP server.${RESET}`)
  console.log()
}

async function cmdList(
  cwd: string,
  asJson: boolean
): Promise<void> {
  const config = await loadMergedConfigs(cwd)

  if (asJson) {
    const servers = Object.entries(config.mcp).map(([name, entry]) => ({
      name,
      type: entry.type || "unknown",
      enabled: entry.enabled !== false,
      location: entry.type === "remote" ? entry.url || "" : (entry.command || []).join(" "),
    }))
    const subagents = Object.entries(config.agent)
      .filter(([, e]) => e.mode !== "primary")
      .map(([name, entry]) => {
        const mcps = entry.tools
          ? Object.keys(entry.tools).filter((k) => k.endsWith("_*") && entry.tools![k] === true).map((k) => k.replace(/_?\*$/, ""))
          : []
        return { name, mcps, description: entry.description || "" }
      })
    const disabled = Object.entries(config.tools).filter(([, v]) => v === false).map(([p]) => p)
    console.log(JSON.stringify({ servers, subagents, disabled }, null, 2))
    return
  }

  console.log()
  console.log(BOLD + "MCP Servers" + RESET)
  console.log()

  const entries = Object.entries(config.mcp)
  if (entries.length === 0) {
    console.log(DIM + "  No MCP servers configured." + RESET)
  } else {
    for (const [name, entry] of entries) {
      const enabled = entry.enabled !== false
      const type = entry.type || "unknown"
      const location = type === "remote" ? entry.url || "" : (entry.command || []).join(" ")
      const status = enabled ? GREEN + "enabled" + RESET : RED + "disabled" + RESET
      console.log(`  ${name.padEnd(16)} [${type}]  ${status}  ${DIM}${location}${RESET}`)
    }
  }

  console.log()
  console.log(BOLD + "Subagents (MCP router)" + RESET)
  console.log()

  const subagents = await readSubagentConfig(cwd)
  if (subagents.length === 0) {
    console.log(DIM + "  No MCP subagents configured." + RESET)
  } else {
    for (const sa of subagents) {
      const mcps = sa.mcpServers.join(", ")
      console.log(`  ${CYAN}@${sa.name.padEnd(18)}${RESET} → ${mcps || DIM + "no MCP" + RESET}${sa.description ? DIM + ` (${sa.description})` + RESET : ""}`)
    }
  }

  console.log()
  console.log(BOLD + "Global tool disables" + RESET)
  const disabled = Object.entries(config.tools).filter(([, v]) => v === false)
  if (disabled.length === 0) {
    console.log(DIM + "  No MCP tools disabled (all loaded in main session)" + RESET)
  } else {
    for (const [pattern] of disabled) {
      console.log(`  ${GREEN}${pattern}${RESET}`)
    }
  }
  console.log()
}

async function cmdEnable(cwd: string): Promise<void> {
  const mcpServers = await readMcpConfig(cwd)
  const mcpNames = mcpServers.map((s) => s.name)
  const modified = await ensureToolsDisabled(cwd, mcpNames)
  await toggleTriage(cwd, true)
  if (modified) {
    console.log(`\n  ${GREEN}●${RESET} Triage enabled. ${mcpNames.length} MCP tool(s) hidden from main session.\n`)
  } else {
    console.log(`\n  ${GREEN}●${RESET} Triage already enabled. No changes needed.\n`)
  }
}

async function cmdDisable(cwd: string): Promise<void> {
  const mcpServers = await readMcpConfig(cwd)
  const mcpNames = mcpServers.map((s) => s.name)
  const removed = await removeToolsDisable(cwd, mcpNames)
  await toggleTriage(cwd, false)
  if (removed) {
    console.log(`\n  ${YELLOW}○${RESET} Triage disabled. ${mcpNames.length} MCP tool(s) restored to main session.\n`)
  } else {
    console.log(`\n  ${YELLOW}○${RESET} Triage already disabled. No changes needed.\n`)
  }
}

/**
 * Prompts the user for a y/N answer. Returns true for "y" or "Y", false otherwise.
 * Skips the prompt entirely when running non-interactively (no TTY) and the caller
 * didn't pass --yes; in that case we abort to be safe.
 */
async function confirmOrAbort(prompt: string, yes: boolean): Promise<boolean> {
  if (yes) return true
  if (!process.stdin.isTTY) {
    console.log(`\n  ${YELLOW}!${RESET} Non-interactive shell detected. Re-run with ${BOLD}--yes${RESET} to confirm.`)
    return false
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(prompt, (a) => resolve(a))
    })
    return answer.trim().toLowerCase().startsWith("y")
  } finally {
    rl.close()
  }
}

/**
 * Full uninstall: reverses the install.
 * - Removes the plugin from the `plugin` array
 * - Removes all "servername_*": false entries (preserves other tool entries)
 * - Removes subagents that triage auto-created (tracked in lock file).
 *   User-written subagents are never touched.
 * - Deletes .opencode/mcp-triage.json (the lock file)
 *
 * Always prints a preview and asks for confirmation unless --yes is passed.
 * The MCP `mcp` block itself is preserved — that's user config, not ours.
 */
async function cmdUninstall(cwd: string, yes: boolean): Promise<void> {
  console.log()
  console.log(BOLD + "Triage uninstall" + RESET)
  console.log(DIM + "  Scans the project config and lock file, then asks before changing anything." + RESET)
  console.log()

  // --- Gather what would change -------------------------------------------
  const mcpServers = await readMcpConfig(cwd)
  const mcpNames = mcpServers.map((s) => s.name)
  const lock = await readLock(cwd)
  const autoCreated = lock?.autoCreated ?? []
  const configPath = await findConfigPath(cwd)
  const lockPath = join(cwd, ".opencode", "mcp-triage.json")

  // --- Preview ------------------------------------------------------------
  type Step = { label: string; count: number; detail: string }
  const steps: Step[] = []

  // Plugin entry
  let pluginFound = false
  if (configPath) {
    const cfg = await readRawConfig(cwd)
    const plugins = cfg?.plugin as unknown[] | undefined
    if (Array.isArray(plugins)) {
      pluginFound = plugins.some(
        (p) => typeof p === "string" && matchesPluginValue(p, cwd)
      )
    }
  }
  steps.push({
    label: "Plugin entry",
    count: pluginFound ? 1 : 0,
    detail: pluginFound
      ? `remove "opencode-mcp-triage" from "plugin" array in ${shortPath(configPath)}`
      : `not present in "plugin" array (skipped)`,
  })

  // MCP disable entries
  steps.push({
    label: "MCP disable entries",
    count: mcpNames.length,
    detail: mcpNames.length > 0
      ? `remove ${mcpNames.length} "name_*": false entries from "tools" (non-MCP entries preserved)`
      : "no MCP servers found (nothing to remove)",
  })

  // Auto-created subagents
  steps.push({
    label: "Auto-created subagents",
    count: autoCreated.length,
    detail: autoCreated.length > 0
      ? `remove ${autoCreated.length} subagent(s) from "agent": ${autoCreated.join(", ")}`
      : "none tracked in lock (skipped)",
  })

  // Lock file
  const lockExists = lock !== null
  steps.push({
    label: "Lock file",
    count: lockExists ? 1 : 0,
    detail: lockExists
      ? `delete ${shortPath(lockPath)}`
      : "not present (skipped)",
  })

  console.log(BOLD + "  Changes to make:" + RESET)
  for (const s of steps) {
    const marker = s.count > 0 ? `${GREEN}●${RESET}` : `${DIM}○${RESET}`
    console.log(`    ${marker} ${BOLD}${s.label}${RESET}  ${DIM}(${s.count})${RESET}`)
    console.log(`        ${s.detail}`)
  }

  const totalChanges = steps.reduce((acc, s) => acc + s.count, 0)
  console.log()
  if (totalChanges === 0) {
    console.log(`  ${DIM}Nothing to remove. Plugin not installed (or already cleaned up).${RESET}`)
    console.log()
    return
  }

  // --- Confirm ------------------------------------------------------------
  const ok = await confirmOrAbort(`  Proceed with ${totalChanges} change(s)? [y/N] `, yes)
  if (!ok) {
    console.log(`\n  ${YELLOW}○${RESET} Cancelled. No changes written.\n`)
    return
  }
  console.log()

  // --- Execute ------------------------------------------------------------
  let pluginsRemoved = 0
  let toolsRemoved = 0
  let subagentsRemoved = 0
  let lockRemoved = false

  if (pluginFound) {
    const ok = await removePluginEntry(cwd)
    pluginsRemoved = ok ? 1 : 0
    console.log(`  ${ok ? GREEN + "✓" : YELLOW + "!"}${RESET} Plugin entry: ${ok ? "removed" : "could not remove (skipped)"}`)
  } else {
    console.log(`  ${DIM}○${RESET} Plugin entry: not present (skipped)`)
  }

  if (mcpNames.length > 0) {
    const ok = await removeToolsDisable(cwd, mcpNames)
    toolsRemoved = ok ? mcpNames.length : 0
    console.log(`  ${ok ? GREEN + "✓" : YELLOW + "!"}${RESET} MCP disable entries: ${ok ? `${mcpNames.length} removed` : "none found (skipped)"}`)
  } else {
    console.log(`  ${DIM}○${RESET} MCP disable entries: nothing to remove`)
  }

  if (autoCreated.length > 0) {
    const removed = await removeAutoSubagents(cwd, autoCreated)
    subagentsRemoved = removed
    console.log(`  ${removed > 0 ? GREEN + "✓" : YELLOW + "!"}${RESET} Auto-created subagents: ${removed} of ${autoCreated.length} removed`)
    if (removed < autoCreated.length) {
      const missing = autoCreated.filter((n) => !inAgent(cwd, n))
      // missing may be empty if user manually removed them; that's fine
      void missing
    }
  } else {
    console.log(`  ${DIM}○${RESET} Auto-created subagents: none tracked`)
  }

  if (lockExists) {
    try {
      await unlink(lockPath)
      lockRemoved = true
      console.log(`  ${GREEN}✓${RESET} Lock file: deleted`)
    } catch {
      console.log(`  ${YELLOW}!${RESET} Lock file: could not delete (you can remove it manually)`)
    }
  } else {
    console.log(`  ${DIM}○${RESET} Lock file: not present`)
  }

  // --- Summary ------------------------------------------------------------
  console.log()
  console.log(BOLD + "  Summary" + RESET)
  console.log(`    Plugin entries removed:     ${pluginsRemoved}`)
  console.log(`    MCP disable entries removed: ${mcpNames.length - (mcpNames.length - toolsRemoved)}`)
  console.log(`    Subagents removed:          ${subagentsRemoved}`)
  console.log(`    Lock file:                  ${lockRemoved ? "deleted" : "kept"}`)
  console.log()
  console.log(`  ${GREEN}●${RESET} ${BOLD}Uninstall complete.${RESET}`)
  console.log(`  ${DIM}Restart OpenCode for plugin changes to take effect.${RESET}`)
  console.log(`  ${DIM}Your MCP servers in the "mcp" block are untouched.${RESET}`)
  console.log(`  ${DIM}To reinstall: ${CYAN}npm install -g opencode-mcp-triage${RESET}${DIM} or run ${CYAN}triage enable${RESET}${DIM} after adding the plugin back.${RESET}`)
  console.log()
}

function matchesPluginValue(value: string, searchPath: string): boolean {
  if (value === "opencode-mcp-triage") return true
  if (value === "file:" + searchPath) return true
  if (value.startsWith("file:")) {
    return /[\\/]opencode-mcp-triage([\\/]|$)/.test(value)
  }
  return false
}

function shortPath(p: string | null): string {
  if (!p) return "(unknown)"
  return p
}

async function inAgent(cwd: string, name: string): Promise<boolean> {
  const subs = await readSubagentConfig(cwd)
  return subs.some((s) => s.name === name)
}

function cmdHelp(): void {
  console.log()
  console.log(BOLD + "opencode-mcp-triage v0.8.0" + RESET + " — Subagent Router for MCP Tools")
  console.log()
  console.log("  Reduces MCP token usage by disabling all MCP tools globally")
  console.log("  and routing work to scoped subagents via @mentions.")
  console.log()
  console.log(BOLD + "COMMANDS" + RESET)
  console.log()
  console.log("  status        Show MCP server status, hidden/exposed tools, and subagent routing")
  console.log("  list          List all configured MCP servers and subagents")
  console.log("  measure       Connect to MCP servers and measure token savings per turn")
  console.log("  enable        Enable triage — disable MCP tools in main session")
  console.log("  disable       Disable triage — restore MCP tools to main session")
  console.log("  uninstall     Remove plugin: disable entries, auto-created subagents, lock file")
  console.log("  help          Show this help")
  console.log()
  console.log(BOLD + "FLAGS" + RESET)
  console.log()
  console.log("  --json          Output as JSON (all commands)")
  console.log("  --verbose       Show error diagnostics during measure")
  console.log("  --timeout=N     Per-server timeout in seconds (default: 60)")
  console.log("  --yes, -y       Skip the uninstall confirmation prompt")
  console.log()
  console.log(BOLD + "HOW IT WORKS" + RESET)
  console.log()
  console.log("  1. Global tool disables remove MCP tools from main session")
  console.log("  2. Subagents keep scoped MCP tools via agent.tools")
  console.log("  3. triage_mcp() routes queries to matching @subagent")
  console.log("  4. LLM invokes subagent via Task tool or @mention")
  console.log()
  console.log(BOLD + "CONFIGURE" + RESET)
  console.log()
  console.log('  "tools": { "mymcp_*": false }            # disable globally')
  console.log('  "agent": { "myagent": {                   # create subagent')
  console.log('    "mode": "subagent",')
  console.log('    "description": "...",')
  console.log('    "tools": { "mymcp_*": true }')
  console.log('  } }')
  console.log()
}

// ── Measure (token savings) ────────────────────────────────

interface MeasureStats {
  tools: number
  chars: number
  tokensEst: number
}

function parseSse(text: string): unknown[] {
  const results: unknown[] = []
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) {
      try { results.push(JSON.parse(line.slice(6))) } catch { /* skip */ }
    }
  }
  return results
}

function calcStats(tools: unknown[]): MeasureStats {
  let total = 0
  for (const t of tools) total += JSON.stringify(t).length
  return { tools: tools.length, chars: total, tokensEst: Math.round(total / 4) }
}

/**
 * MCP initialize + tools/list handshake over HTTP.
 * Shared by measureViaHttp (remote servers) and measureViaCachedToken (mcp-remote).
 * Handles both SSE stream and JSON response content types.
 */
async function mcpListTools(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  name: string,
  verbose: boolean
): Promise<unknown[] | null> {
  const initResp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0", id: "1", method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {},
        clientInfo: { name: "scanner", version: "1.0.0" },
      },
    }),
    signal,
  })
  if (!initResp.ok) {
    if (verbose) process.stderr.write(` [${name}: HTTP ${initResp.status}]`)
    return null
  }
  const text = await initResp.text()
  const initResults = (initResp.headers.get("content-type") || "").includes("text/event-stream")
    ? parseSse(text)
    : [JSON.parse(text)]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const initResult = initResults.find((r: any) => r?.result)
  if (!initResult) {
    if (verbose) process.stderr.write(` [${name}: no init result]`)
    return null
  }
  const sessionId = initResp.headers.get("Mcp-Session-Id")
  if (sessionId) headers["Mcp-Session-Id"] = sessionId

  const toolsResp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: "2", method: "tools/list" }),
    signal,
  })
  if (!toolsResp.ok) {
    if (verbose) process.stderr.write(` [${name}: tools/list HTTP ${toolsResp.status}]`)
    return null
  }
  const toolsText = await toolsResp.text()
  const toolsData = (toolsResp.headers.get("content-type") || "").includes("text/event-stream")
    ? parseSse(toolsText)
    : [JSON.parse(toolsText)]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toolsResult = toolsData.find((d: any) => d?.result && !d?.error)
  if (!toolsResult) {
    const errData = toolsData.find((d: any) => d?.error)
    if (errData && verbose) process.stderr.write(` [${name}: ${(errData as any).error.message}]`)
    return null
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((toolsResult as any)?.result?.tools) || []
}

/**
 * Generic HTTP measure wrapper with timeout + AbortController.
 * Accepts lazy buildHeaders() so callers can construct auth headers per attempt.
 * Eliminates duplicate init/tools/list code between remote and cached-token paths.
 */
async function measureViaHttp(
  name: string,
  url: string,
  buildHeaders: () => Record<string, string> | null,
  verbose: boolean,
  timeoutMs: number
): Promise<MeasureStats | null> {
  if (!/^https:\/\//.test(url)) {
    if (verbose) process.stderr.write(` [${name}: not https]`)
    return null
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers = buildHeaders()
    if (!headers) return null
    const tools = await mcpListTools(url, headers, controller.signal, name, verbose)
    return tools ? calcStats(tools) : null
  } catch (e: unknown) {
    if (verbose) process.stderr.write(` [${name}: ${(e as Error).message}]`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * MCP measure: spawns the local command and reads tools/list.
 * mcp-remote commands are spawned like any other local server — they
 * handle their own auth via the env passed through. We do NOT auto-inject
 * cached tokens from ~/.mcp-auth here, since doing so without scoping to
 * the target server risks leaking access tokens to attacker-controlled URLs
 * in a tampered config.
 */
async function measureLocal(
  name: string,
  entry: McpConfigEntry,
  verbose: boolean,
  timeoutMs: number
): Promise<MeasureStats | null> {
  const cmdParts = entry.command || []
  let [cmd, ...args] = cmdParts
  if (!cmd) return null

  const env: Record<string, string> = { ...process.env as Record<string, string> }
  if (entry.env) Object.assign(env, entry.env)
  if (entry.environment) Object.assign(env, entry.environment)

  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(cmd, args, { env, stdio: ["pipe", "pipe", "pipe"] })
    } catch (e: unknown) {
      if (verbose) process.stderr.write(` [${name}: spawn ${(e as Error).message}]`)
      return resolve(null)
    }
    let stdout = ""
    let done = false

    proc.stdout!.setEncoding("utf-8")
    proc.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk
      if (done) return
      const lines = stdout.split("\n").filter(Boolean)
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line)
          if ((parsed.id === 2 || parsed.id === "2") && (parsed.result || parsed.error)) {
            done = true
            proc.stdin!.end()
            proc.kill()
            if (parsed.error && verbose) process.stderr.write(` [${name}: rpc ${parsed.error.message}]`)
            resolve(parsed.error ? null : calcStats(parsed.result.tools || []))
            return
          }
        } catch { /* skip */ }
      }
    })
    proc.stdout!.on("error", (e: Error) => {
      if (!done) { done = true; proc.kill(); if (verbose) process.stderr.write(` [${name}: stdout ${e.message}]`); resolve(null) }
    })
    proc.on("error", (e: Error) => {
      if (!done) { done = true; if (verbose) process.stderr.write(` [${name}: proc ${e.message}]`); resolve(null) }
    })
    proc.on("exit", (code: number | null) => {
      if (!done) { done = true; if (verbose && code !== 0) process.stderr.write(` [${name}: exited ${code}]`); resolve(null) }
    })

    function send(msg: unknown) {
      try { proc.stdin!.write(JSON.stringify(msg) + "\n") } catch { /* skip */ }
    }

    setTimeout(() => {
      if (!done) { done = true; proc.kill(); if (verbose) process.stderr.write(` [${name}: timeout]`); resolve(null) }
    }, timeoutMs)
    send({
      jsonrpc: "2.0", id: "1", method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {},
        clientInfo: { name: "scanner", version: "1.0.0" },
      },
    })
    setTimeout(() => {
      send({ jsonrpc: "2.0", method: "notifications/initialized" })
      send({ jsonrpc: "2.0", id: "2", method: "tools/list" })
    }, 2000)
  })
}

async function measureRemote(
  name: string,
  entry: McpConfigEntry,
  verbose: boolean,
  timeoutMs: number
): Promise<MeasureStats | null> {
  const url = entry.url
  if (!url) return null
  return measureViaHttp(name, url, () => ({
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    ...(entry.headers || {}),
  }), verbose, timeoutMs)
}

async function cmdMeasure(
  cwd: string,
  asJson: boolean,
  verbose: boolean,
  perServerTimeout: number
): Promise<void> {
  const config = await loadMergedConfigs(cwd)
  const mcps = config.mcp
  const names = Object.keys(mcps)
  const savings: Record<string, MeasureStats> = {}

  if (!asJson) process.stderr.write("  Measuring")
  for (const name of names) {
    const entry = mcps[name]
    if (entry.enabled === false) continue

    let result: MeasureStats | null = null
    try {
      if (!asJson) process.stderr.write(".")
      if (entry.type === "local") {
        result = await measureLocal(name, entry, verbose, perServerTimeout)
      } else {
        result = await measureRemote(name, entry, verbose, perServerTimeout)
      }
    } catch (e: unknown) {
      if (verbose) process.stderr.write(` [${name}: ${(e as Error).message}]`)
    }
    if (result) savings[name] = result
  }
  if (!asJson) process.stderr.write(" done\n")

  if (asJson) {
    console.log(JSON.stringify({ savings }, null, 2))
    return
  }

  const allNames = Object.keys(savings)
  if (allNames.length === 0) {
    console.log(`\n  ${DIM}(no MCP servers connected or all failed)${RESET}\n`)
    return
  }

  let grandChars = 0, grandTokenEst = 0, grandTools = 0
  console.log(`\n${BOLD}  TOKENS SAVED PER TURN${RESET} ${DIM}(by routing MCPs to subagents)${RESET}\n`)
  for (const name of allNames) {
    const s = savings[name]
    const line = `  ${name.padEnd(12)} ${GREEN}${String(s.tools).padStart(3)} tools${RESET}  ${String(s.chars).padStart(7)} chars  ~${CYAN}${String(s.tokensEst).padStart(5)} tokens${RESET}`
    console.log(line)
    grandChars += s.chars
    grandTokenEst += s.tokensEst
    grandTools += s.tools
  }
  console.log(`  ${DIM}${"-".repeat(52)}${RESET}`)
  console.log(`  ${BOLD}${"TOTAL".padEnd(12)}${RESET} ${GREEN}${String(grandTools).padStart(3)} tools${RESET}  ${String(grandChars).padStart(7)} chars  ~${CYAN}${String(grandTokenEst).padStart(6)} tokens${RESET}`)
  console.log(`  ${DIM}${"=".repeat(52)}${RESET}`)
  console.log(`  ${BOLD}Each user turn saves ~${grandTokenEst.toLocaleString()} tokens${RESET}`)
  console.log(`  ${DIM}that would otherwise be sent with every prompt.${RESET}\n`)
}

// ── Main ───────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const rawCmd = args[0] || "help"
  const flags = args.slice(1)
  const asJson = flags.includes("--json")
  const verbose = flags.includes("--verbose")
  const yes = flags.includes("--yes") || flags.includes("-y")

  let perServerTimeout = 60000
  const timeoutFlag = flags.find((f) => /^--timeout(=.+)?$/.test(f))
  if (timeoutFlag) {
    const val = timeoutFlag.includes("=")
      ? timeoutFlag.split("=")[1]
      : flags[flags.indexOf(timeoutFlag) + 1]
    const n = parseInt(val, 10)
    if (n > 0) perServerTimeout = n * 1000
  }

  const cwd = process.cwd()
  const globalPath = await findConfigPath(homedir())
  const projectPath = await findConfigPath(cwd)

  if (!globalPath && !projectPath && rawCmd !== "help") {
    console.log("No opencode.jsonc found in project or global config.")
    process.exit(1)
  }

  const validCommands = Object.keys(COMMANDS)
  if (!validCommands.includes(rawCmd)) {
    const suggestion = suggestCommand(rawCmd, validCommands)
    if (suggestion) {
      console.log(`Did you mean "${suggestion}"? (typo: "${rawCmd}")`)
      console.log("")
    } else {
      console.log(`Unknown command: "${rawCmd}"`)
      console.log("")
    }
    cmdHelp()
    process.exit(1)
  }

  switch (rawCmd) {
    case "list":
      await cmdList(cwd, asJson)
      break
    case "status":
      await cmdStatus(cwd, asJson)
      break
    case "measure":
      await cmdMeasure(cwd, asJson, verbose, perServerTimeout)
      break
    case "enable":
      await cmdEnable(cwd)
      break
    case "disable":
      await cmdDisable(cwd)
      break
    case "uninstall":
      await cmdUninstall(cwd, yes)
      break
    case "help":
    default:
      cmdHelp()
  }
}

main().catch((e: Error) => {
  process.stderr.write(`\n  Fatal: ${e.message}\n`)
  process.exit(1)
})
