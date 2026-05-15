#!/usr/bin/env node
/*
 * opencode-mcp-triage CLI v0.6.1 — /mcp-triage slash command handler
 *
 * Reads MCP config and shows server status, subagent routing,
 * and tool visibility. Runs out-of-process so cannot access
 * runtime plugin state (use mcp_stats tool for that).
 *
 * Features:
 * - Colored output matching opencode-triage style
 * - Hidden vs exposed MCP tool visibility
 * - Levenshtein typo correction for commands
 * - JSON output mode (--json)
 * - Benchmarking (--benchmark)
 */
const { readFileSync, readdirSync, existsSync } = require("node:fs")
const { join } = require("node:path")
const { homedir } = require("node:os")

const COMMANDS = {
  status: "Show MCP server status, hidden/exposed tools, and subagent routing",
  list: "List all configured MCP servers and subagents",
  measure: "Measure token savings by connecting to each MCP server",
  help: "Show available commands",
}

const YELLOW = "\x1b[33m"
const GREEN = "\x1b[32m"
const RED = "\x1b[31m"
const CYAN = "\x1b[36m"
const RESET = "\x1b[0m"
const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"

const PLUGIN_NAME = "opencode-mcp-triage"

const GLOBAL_CFG_PATH = join(homedir(), ".config", "opencode", "opencode.jsonc")
const GLOBAL_CFG_PATH_JSON = join(homedir(), ".config", "opencode", "opencode.json")

function levenshtein(a, b) {
  const matrix = Array.from({ length: b.length + 1 }, (_, i) => [i])
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = b[i - 1] === a[j - 1] ? 0 : 1
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      )
    }
  }
  return matrix[b.length][a.length]
}

function suggestCommand(typo, validCommands) {
  let best = null
  let bestDist = Infinity
  for (const cmd of validCommands) {
    const dist = levenshtein(typo, cmd)
    if (dist < bestDist) {
      bestDist = dist
      best = cmd
    }
  }
  return bestDist <= 3 ? best : null
}

function stripJsonc(raw) {
  let result = ""
  let inString = false
  let escape = false
  let i = 0

  while (i < raw.length) {
    const ch = raw[i]

    if (inString) {
      result += ch
      if (escape) {
        escape = false
      } else if (ch === "\\") {
        escape = true
      } else if (ch === '"') {
        inString = false
      }
      i++
      continue
    }

    // Block comment: /* ... */
    if (ch === "/" && i + 1 < raw.length && raw[i + 1] === "*") {
      i += 2
      while (i < raw.length) {
        if (raw[i] === "*" && i + 1 < raw.length && raw[i + 1] === "/") {
          i += 2
          break
        }
        i++
      }
      continue
    }

    // Line comment: // ... (only when not inside a string)
    if (ch === "/" && i + 1 < raw.length && raw[i + 1] === "/") {
      i += 2
      while (i < raw.length && raw[i] !== "\n") {
        i++
      }
      continue
    }

    if (ch === '"') {
      inString = true
    }

    result += ch
    i++
  }

  // Strip trailing commas before } or ]
  result = result.replace(/,(?=\s*[}\]])/g, "")
  return result
}

function stripBOM(s) {
  if (s.charCodeAt(0) === 0xfeff) return s.slice(1)
  return s
}

function findConfig(baseDir) {
  const isGlobal = baseDir === homedir()
  const paths = isGlobal
    ? [
        join(baseDir, ".config", "opencode", "opencode.jsonc"),
        join(baseDir, ".config", "opencode", "opencode.json"),
      ]
    : [
        join(baseDir, ".opencode", "opencode.json"),
        join(baseDir, ".opencode", "opencode.jsonc"),
        join(baseDir, "opencode.jsonc"),
        join(baseDir, "opencode.json"),
      ]

  for (const p of paths) {
    if (existsSync(p)) {
      try {
        const raw = stripBOM(readFileSync(p, "utf-8"))
        if (raw.length > 1024 * 1024) continue
        return JSON.parse(stripJsonc(raw))
      } catch {
        // try next
      }
    }
  }
  return null
}

function collectConfigState() {
  let localActive = false
  const cwd = process.cwd()
  const localPaths = [
    join(cwd, ".opencode", "opencode.json"),
    join(cwd, ".opencode", "opencode.jsonc"),
    join(cwd, "opencode.jsonc"),
    join(cwd, "opencode.json"),
  ]
  for (const p of localPaths) {
    if (existsSync(p)) {
      try {
        const cfg = JSON.parse(stripJsonc(stripBOM(readFileSync(p, "utf-8"))))
        localActive = (cfg.plugin || []).some(
          (pl) => typeof pl === "string" && (pl.includes(PLUGIN_NAME) || pl === "file:" + process.cwd())
        )
      } catch {}
      break
    }
  }

  let globalActive = false
  for (const p of [GLOBAL_CFG_PATH, GLOBAL_CFG_PATH_JSON]) {
    if (existsSync(p)) {
      try {
        const cfg = JSON.parse(stripJsonc(stripBOM(readFileSync(p, "utf-8"))))
        globalActive = (cfg.plugin || []).some(
          (pl) => typeof pl === "string" && pl.includes(PLUGIN_NAME)
        )
      } catch {}
      break
    }
  }

  return { localActive, globalActive }
}

function extractMcpServers(config) {
  const mcp = config.mcp || {}
  return Object.entries(mcp)
    .filter(([, entry]) => entry.enabled !== false)
    .map(([name, entry]) => ({
      name,
      type: entry.type || "unknown",
      enabled: entry.enabled !== false,
      description: entry.description || "",
      url: entry.url || "",
      command: entry.command || [],
    }))
}

function extractSubagents(config) {
  const agent = config.agent || {}
  const result = []
  for (const [name, entry] of Object.entries(agent)) {
    if (entry.mode === "primary") continue
    if (!entry.tools || typeof entry.tools !== "object") continue
    const mcps = Object.keys(entry.tools)
      .filter((k) => k.endsWith("_*") && entry.tools[k] === true)
      .map((k) => k.replace(/_?\*$/, ""))
    if (mcps.length === 0) continue
    result.push({ name, description: entry.description || "", mcps })
  }
  return result
}

function extractDisabledPatterns(config) {
  const tools = config.tools || {}
  return Object.entries(tools)
    .filter(([, v]) => v === false)
    .map(([k]) => k)
}

function cmdStatus(config, asJson) {
  const { localActive, globalActive } = collectConfigState()
  const mcpServers = extractMcpServers(config)
  const subagents = extractSubagents(config)
  const disabledPatterns = extractDisabledPatterns(config)
  const mcpNames = mcpServers.map((s) => s.name)

  const assigned = new Set()
  for (const sa of subagents) {
    for (const m of sa.mcps) assigned.add(m)
  }

  const hidden = mcpNames.filter((n) =>
    disabledPatterns.some((p) => p === `${n}_*`)
  )
  const exposed = mcpNames.filter((n) =>
    !disabledPatterns.some((p) => p === `${n}_*`)
  )

  const outOfSync = []
  if (localActive && exposed.length > 0) {
    outOfSync.push(`${exposed.length} MCP tool(s) exposed in project while plugin is ACTIVE`)
  }
  if (globalActive && exposed.length > 0) {
    outOfSync.push(`${exposed.length} MCP tool(s) exposed globally while plugin is ACTIVE`)
  }

  if (asJson) {
    const routingMap = subagents.map((sa) => ({
      name: sa.name,
      mcps: sa.mcps,
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
      mcpVisibility: {
        hidden,
        exposed,
      },
      routingMap,
      unassigned: mcpNames.filter((n) => !assigned.has(n)),
      outOfSync: outOfSync.length > 0 ? outOfSync : null,
    }, null, 2))
    return
  }

  const scopeSummary = []
  if (localActive) scopeSummary.push(GREEN + "●" + RESET + " local")
  if (globalActive) scopeSummary.push(GREEN + "●" + RESET + " global")
  if (!localActive && !globalActive) scopeSummary.push(DIM + "○ inactive" + RESET)

  console.log()
  console.log(BOLD + "● MCP Triage Status" + RESET + DIM + " — " + scopeSummary.join(" · ") + RESET)
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

  if (hidden.length === 0 && exposed.length === 0) {
    console.log(`  ${DIM}(no MCP servers configured)${RESET}`)
    console.log()
  }

  if (subagents.length > 0) {
    console.log(`  ${DIM}── Subagent routing map ──────────────────────────────${RESET}`)
    for (const sa of subagents) {
      const mcps = sa.mcps.join(", ")
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

function cmdList(config, asJson) {
  const mcp = config.mcp || {}
  const agent = config.agent || {}
  const tools = config.tools || {}

  if (asJson) {
    const servers = Object.entries(mcp).map(([name, entry]) => ({
      name,
      type: entry.type || "unknown",
      enabled: entry.enabled !== false,
      location: entry.type === "remote" ? entry.url || "" : (entry.command || []).join(" "),
    }))
    const subagents = Object.entries(agent)
      .filter(([, e]) => e.mode !== "primary")
      .map(([name, entry]) => {
        const mcps = entry.tools
          ? Object.keys(entry.tools).filter((k) => k.endsWith("_*") && entry.tools[k] === true).map((k) => k.replace(/_?\*$/, ""))
          : []
        return { name, mcps, description: entry.description || "" }
      })
    const disabled = Object.entries(tools).filter(([, v]) => v === false).map(([p]) => p)
    console.log(JSON.stringify({ servers, subagents, disabled }, null, 2))
    return
  }

  console.log()
  console.log(BOLD + "MCP Servers" + RESET)
  console.log()

  const entries = Object.entries(mcp)
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

  const subagents = extractSubagents(config)
  if (subagents.length === 0) {
    console.log(DIM + "  No MCP subagents configured." + RESET)
  } else {
    for (const sa of subagents) {
      const mcps = sa.mcps.join(", ")
      console.log(`  ${CYAN}@${sa.name.padEnd(18)}${RESET} → ${mcps || DIM + "no MCP" + RESET}${sa.description ? DIM + ` (${sa.description})` + RESET : ""}`)
    }
  }

  console.log()
  console.log(BOLD + "Global tool disables" + RESET)
  const disabled = Object.entries(tools).filter(([, v]) => v === false)
  if (disabled.length === 0) {
    console.log(DIM + "  No MCP tools disabled (all loaded in main session)" + RESET)
  } else {
    for (const [pattern] of disabled) {
      console.log(`  ${GREEN}${pattern}${RESET}`)
    }
  }
  console.log()
}

function cmdHelp() {
  console.log()
  console.log(BOLD + "opencode-mcp-triage v0.6.1" + RESET + " — Subagent Router for MCP Tools")
  console.log()
  console.log("  Reduces MCP token usage by disabling all MCP tools globally")
  console.log("  and routing work to scoped subagents via @mentions.")
  console.log()
  console.log(BOLD + "COMMANDS" + RESET)
  console.log()
  console.log("  status        Show MCP server status, hidden/exposed tools, and subagent routing")
  console.log("  list          List all configured MCP servers and subagents")
  console.log("  measure       Connect to MCP servers and measure token savings per turn")
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
const { spawn } = require("node:child_process")

async function loadCachedTokens(verbose) {
  const results = []
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
            const tokens = JSON.parse(raw)
            if (tokens.access_token) {
              results.push({
                token: tokens.access_token,
                type: tokens.token_type || "Bearer",
              })
            }
          } catch (e) {
            if (verbose) process.stderr.write(` [mcp-auth: ${s.name}]`)
          }
        }
      }
    }
  } catch (e) {
    if (verbose) process.stderr.write(` [mcp-auth: ${e.message}]`)
  }
  return results
}

function parseSse(text) {
  let lastData = null
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) {
      try { lastData = JSON.parse(line.slice(6)) } catch {}
    }
  }
  return lastData
}

function calcStats(tools) {
  let total = 0
  for (const t of tools) total += JSON.stringify(t).length
  return { tools: tools.length, chars: total, tokensEst: Math.round(total / 4) }
}

async function measureViaCachedToken(name, url, cachedTokens, envHeaders, verbose) {
  if (!/^https:\/\//.test(url)) {
    if (verbose) process.stderr.write(` [${name}: not https]`)
    return null
  }
  for (const ct of cachedTokens) {
    const headers = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "Authorization": `${ct.type} ${ct.token}`,
      ...envHeaders,
    }
    try {
      const initResp = await fetch(url, {
        method: "POST", headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "initialize",
          params: { protocolVersion: "2024-11-05", capabilities: {},
            clientInfo: { name: "scanner", version: "1.0.0" } } }),
      })
      if (!initResp.ok) { if (verbose) process.stderr.write(` [${name}: HTTP ${initResp.status}]`); continue }
      const text = await initResp.text()
      const initResult = (initResp.headers.get("content-type") || "").includes("text/event-stream")
        ? parseSse(text) : JSON.parse(text)
      if (!initResult?.result) { if (verbose) process.stderr.write(` [${name}: no init result]`); continue }
      const sessionId = initResp.headers.get("Mcp-Session-Id")
      if (sessionId) headers["Mcp-Session-Id"] = sessionId
      const toolsResp = await fetch(url, {
        method: "POST", headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: "2", method: "tools/list" }),
      })
      if (!toolsResp.ok) { if (verbose) process.stderr.write(` [${name}: tools/list HTTP ${toolsResp.status}]`); continue }
      const toolsText = await toolsResp.text()
      const toolsData = (toolsResp.headers.get("content-type") || "").includes("text/event-stream")
        ? parseSse(toolsText) : JSON.parse(toolsText)
      if (toolsData.error) { if (verbose) process.stderr.write(` [${name}: ${toolsData.error.message}]`); continue }
      return calcStats(toolsData.result?.tools || [])
    } catch (e) {
      if (verbose) process.stderr.write(` [${name}: ${e.message}]`)
    }
  }
  return null
}

async function measureLocal(name, entry, verbose, timeoutMs) {
  let [cmd, ...args] = entry.command || []
  const SHORTHAND = { "netlify-mcp": ["npx", "-y", "@netlify/mcp"] }
  const resolved = SHORTHAND[cmd]
  if (resolved) { cmd = resolved[0]; args = [...resolved.slice(1), ...args] }

  const env = { ...process.env }
  if (entry.env) Object.assign(env, entry.env)
  if (entry.environment) Object.assign(env, entry.environment)

  return new Promise((resolve) => {
    let proc
    try {
      proc = spawn(cmd, args, { env, stdio: ["pipe", "pipe", "pipe"], shell: true })
    } catch (e) {
      if (verbose) process.stderr.write(` [${name}: spawn ${e.message}]`)
      return resolve(null)
    }
    let stdout = ""
    let done = false

    proc.stdout.setEncoding("utf-8")
    proc.stdout.on("data", (chunk) => {
      stdout += chunk
      if (done) return
      const lines = stdout.split("\n").filter(Boolean)
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line)
          if ((parsed.id === 2 || parsed.id === "2") && (parsed.result || parsed.error)) {
            done = true
            proc.stdin.end()
            proc.kill()
            if (parsed.error && verbose) process.stderr.write(` [${name}: rpc ${parsed.error.message}]`)
            resolve(parsed.error ? null : calcStats(parsed.result.tools || []))
            return
          }
        } catch {}
      }
    })
    proc.stdout.on("error", (e) => { if (!done) { done = true; proc.kill(); if (verbose) process.stderr.write(` [${name}: stdout ${e.message}]`); resolve(null) } })
    proc.on("error", (e) => { if (!done) { done = true; if (verbose) process.stderr.write(` [${name}: proc ${e.message}]`); resolve(null) } })
    proc.on("exit", (code) => { if (!done) { done = true; if (verbose && code !== 0) process.stderr.write(` [${name}: exited ${code}]`); resolve(null) } })

    function send(msg) { try { proc.stdin.write(JSON.stringify(msg) + "\n") } catch {} }

    setTimeout(() => { if (!done) { done = true; proc.kill(); if (verbose) process.stderr.write(` [${name}: timeout]`); resolve(null) } }, timeoutMs)
    send({ jsonrpc: "2.0", id: "1", method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {},
        clientInfo: { name: "scanner", version: "1.0.0" } } })
    setTimeout(() => {
      send({ jsonrpc: "2.0", method: "notifications/initialized" })
      send({ jsonrpc: "2.0", id: "2", method: "tools/list" })
    }, 2000)
  })
}

async function measureRemote(name, entry, verbose) {
  const url = entry.url
  if (!url || !/^https:\/\//.test(url)) {
    if (verbose) process.stderr.write(` [${name}: not https]`)
    return null
  }
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    ...(entry.headers || {}),
  }
  try {
    const initResp = await fetch(url, {
      method: "POST", headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {},
          clientInfo: { name: "scanner", version: "1.0.0" } } }),
    })
    if (!initResp.ok) { if (verbose) process.stderr.write(` [${name}: HTTP ${initResp.status}]`); return null }
    const text = await initResp.text()
    const initResult = (initResp.headers.get("content-type") || "").includes("text/event-stream")
      ? parseSse(text) : JSON.parse(text)
    if (!initResult?.result) { if (verbose) process.stderr.write(` [${name}: no init result]`); return null }
    const sessionId = initResp.headers.get("Mcp-Session-Id")
    if (sessionId) headers["Mcp-Session-Id"] = sessionId
    const toolsResp = await fetch(url, {
      method: "POST", headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: "2", method: "tools/list" }),
    })
    if (!toolsResp.ok) { if (verbose) process.stderr.write(` [${name}: tools HTTP ${toolsResp.status}]`); return null }
    const toolsText = await toolsResp.text()
    const toolsData = (toolsResp.headers.get("content-type") || "").includes("text/event-stream")
      ? parseSse(toolsText) : JSON.parse(toolsText)
    if (toolsData.error) { if (verbose) process.stderr.write(` [${name}: ${toolsData.error.message}]`); return null }
    return calcStats(toolsData.result?.tools || [])
  } catch (e) {
    if (verbose) process.stderr.write(` [${name}: ${e.message}]`)
    return null
  }
}

async function cmdMeasure(config, asJson, verbose, perServerTimeout) {
  const mcps = config.mcp || {}
  const names = Object.keys(mcps)
  const cachedTokens = await loadCachedTokens(verbose)
  const savings = {}

  if (!asJson) process.stderr.write("  Measuring")
  for (const name of names) {
    const entry = mcps[name]
    if (entry.enabled === false) continue

    let result = null
    const isMcpRemote = entry.type === "local" &&
      entry.command?.[0] === "mcp-remote" &&
      entry.command?.[1]

    try {
      if (!asJson) process.stderr.write(".")
      if (isMcpRemote) {
        result = await measureViaCachedToken(name, entry.command[1], cachedTokens, entry.headers || {}, verbose)
      } else if (entry.type === "local") {
        result = await measureLocal(name, entry, verbose, perServerTimeout)
      } else {
        result = await measureRemote(name, entry, verbose)
      }
    } catch (e) {
      if (verbose) process.stderr.write(` [${name}: ${e.message}]`)
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
const args = process.argv.slice(2)
const rawCmd = args[0] || "help"
const flags = args.slice(1)
const asJson = flags.includes("--json")
const verbose = flags.includes("--verbose")

// Parse --timeout=N (seconds) from flags
let perServerTimeout = 60000 // default 60s
const timeoutFlag = flags.find(f => /^--timeout(=.+)?$/.test(f))
if (timeoutFlag) {
  const val = timeoutFlag.includes("=") ? timeoutFlag.split("=")[1] : flags[flags.indexOf(timeoutFlag) + 1]
  const n = parseInt(val, 10)
  if (n > 0) perServerTimeout = n * 1000
}

const cwd = process.cwd()
const globalConfig = findConfig(homedir())
const projectConfig = findConfig(cwd)

const config = {
  mcp: { ...(globalConfig?.mcp || {}), ...(projectConfig?.mcp || {}) },
  agent: { ...(globalConfig?.agent || {}), ...(projectConfig?.agent || {}) },
  tools: { ...(globalConfig?.tools || {}), ...(projectConfig?.tools || {}) },
}

if (!globalConfig && !projectConfig) {
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
    cmdList(config, asJson)
    break
  case "status":
    cmdStatus(config, asJson)
    break
  case "measure":
    cmdMeasure(config, asJson, verbose, perServerTimeout).then(() => process.exit(0)).catch((e) => { process.stderr.write(`\n  Fatal: ${e.message}\n`); process.exit(1) })
    break
  case "help":
  default:
    cmdHelp()
}
