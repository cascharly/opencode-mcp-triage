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
import { ensureToolsDisabled, removeToolsDisable } from "./writer.js"
import { isTriageEnabled, toggleTriage } from "./lock.js"
import { homedir } from "node:os"
import { join } from "node:path"
import { readFileSync, readdirSync } from "node:fs"
import { spawn } from "node:child_process"

const PLUGIN_NAME = "opencode-mcp-triage"

const COMMANDS: Record<string, string> = {
  status: "Show MCP server status, hidden/exposed tools, and subagent routing",
  list: "List all configured MCP servers and subagents",
  measure: "Measure token savings by connecting to each MCP server",
  enable: "Enable triage — disable MCP tools in main session",
  disable: "Disable triage — restore MCP tools to main session",
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
  return plugins.some(
    (pl) =>
      typeof pl === "string" &&
      (pl.includes(PLUGIN_NAME) || pl === "file:" + searchPath)
  )
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
  console.log("  help          Show this help")
  console.log()
  console.log(BOLD + "FLAGS" + RESET)
  console.log()
  console.log("  --json          Output as JSON (all commands)")
  console.log("  --verbose       Show error diagnostics during measure")
  console.log("  --timeout=N     Per-server timeout in seconds (default: 60)")
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

interface TokenCache {
  token: string
  type: string
}

interface MeasureStats {
  tools: number
  chars: number
  tokensEst: number
}

async function loadCachedTokens(verbose: boolean): Promise<TokenCache[]> {
  const results: TokenCache[] = []
  const authDir = join(homedir(), ".mcp-auth")
  try {
    const entries = readdirSync(authDir, { withFileTypes: true })
    for (const entry of entries) {
      const full = join(authDir, entry.name)
      if (entry.isDirectory()) {
        const sub = readdirSync(full, { withFileTypes: true })
        for (const s of sub) {
          const sf = join(full, s.name)
          if (s.isDirectory()) continue
          if (!s.name.endsWith("_tokens.json")) continue
          try {
            const raw = readFileSync(sf, "utf-8")
            const tokens = JSON.parse(raw) as { access_token?: string; token_type?: string }
            if (tokens.access_token) {
              results.push({
                token: tokens.access_token,
                type: tokens.token_type || "Bearer",
              })
            }
          } catch {
            // Generic error — don't leak token filenames to stderr
            if (verbose) process.stderr.write(` [mcp-auth: token read error]`)
          }
        }
      }
    }
  } catch {
    if (verbose) process.stderr.write(` [mcp-auth: dir not found]`)
  }
  return results
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
        protocolVersion: "2024-11-05", capabilities: {},
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
 * Iterates cached auth tokens against a remote MCP URL.
 * Falls through tokens silently until one succeeds or all fail.
 * Delegates actual HTTP handshake to measureViaHttp + mcpListTools.
 */
async function measureViaCachedToken(
  name: string,
  url: string,
  cachedTokens: TokenCache[],
  envHeaders: Record<string, string> | undefined,
  verbose: boolean,
  timeoutMs: number
): Promise<MeasureStats | null> {
  const baseHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    ...(envHeaders || {}),
  }
  for (const ct of cachedTokens) {
    const result = await measureViaHttp(name, url, () => ({
      ...baseHeaders,
      "Authorization": `${ct.type} ${ct.token}`,
    }), verbose, timeoutMs)
    if (result !== null) return result
  }
  return null
}

async function measureLocal(
  name: string,
  entry: McpConfigEntry,
  verbose: boolean,
  timeoutMs: number
): Promise<MeasureStats | null> {
  const cmdParts = entry.command || []
  let [cmd, ...args] = cmdParts
  if (!cmd) return null
  const SHORTHAND: Record<string, string[]> = { "netlify-mcp": ["npx", "-y", "@netlify/mcp"] }
  const resolved = SHORTHAND[cmd]
  if (resolved) { cmd = resolved[0]; args = [...resolved.slice(1), ...args] }

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
        protocolVersion: "2024-11-05", capabilities: {},
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
  const cachedTokens = await loadCachedTokens(verbose)
  const savings: Record<string, MeasureStats> = {}

  if (!asJson) process.stderr.write("  Measuring")
  for (const name of names) {
    const entry = mcps[name]
    if (entry.enabled === false) continue

    let result: MeasureStats | null = null
    const isMcpRemote = entry.type === "local" &&
      entry.command?.[0] === "mcp-remote" &&
      entry.command?.[1]

    try {
      if (!asJson) process.stderr.write(".")
      if (isMcpRemote) {
        result = await measureViaCachedToken(name, entry.command![1], cachedTokens, entry.headers, verbose, perServerTimeout)
      } else if (entry.type === "local") {
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

  if (!globalPath && !projectPath) {
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
    case "help":
    default:
      cmdHelp()
  }
}

main().catch((e: Error) => {
  process.stderr.write(`\n  Fatal: ${e.message}\n`)
  process.exit(1)
})
