#!/usr/bin/env node
/*
 * opencode-mcp-triage CLI — /mcp-triage slash command handler
 *
 * Reads MCP config and shows server status, subagent routing,
 * and token savings. Runs out-of-process so cannot access
 * runtime plugin state (use mcp_stats tool for that).
 */
const { readFileSync, existsSync } = require("node:fs")
const { join } = require("node:path")
const { homedir } = require("node:os")

const COMMANDS = {
  status: "Show MCP server status and estimated token savings",
  list: "List all configured MCP servers and subagents",
  help: "Show available commands",
}

function stripJsonc(raw) {
  let result = raw.replace(/\/\*[\s\S]*?\*\//g, "")
  result = result.replace(/(?<!:)\/\/.*$/gm, "")
  result = result.replace(/,(?=\s*[}\]])/g, "")
  return result
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
        return JSON.parse(stripJsonc(readFileSync(p, "utf-8")))
      } catch {
        // try next
      }
    }
  }
  return null
}

function cmdList(config) {
  const mcp = config.mcp || {}
  const agent = config.agent || {}
  const tools = config.tools || {}

  console.log("MCP Servers:")
  console.log("")

  const entries = Object.entries(mcp)
  if (entries.length === 0) {
    console.log("  No MCP servers configured.")
  } else {
    for (const [name, entry] of entries) {
      const enabled = entry.enabled !== false
      const type = entry.type || "unknown"
      const location =
        type === "remote"
          ? entry.url || ""
          : (entry.command || []).join(" ")

      console.log(
        `  ${name.padEnd(16)} [${type}]  ${enabled ? "enabled" : "disabled"}  ${location}`
      )
    }
  }

  console.log("")
  console.log("Subagents (MCP router):")
  console.log("")

  const subagents = Object.entries(agent).filter(([, e]) => e.mode !== "primary")

  if (subagents.length === 0) {
    console.log("  No MCP subagents configured.")
  } else {
    for (const [name, entry] of subagents) {
      const toolKeys = entry.tools ? Object.keys(entry.tools) : []
      const mcps = toolKeys
        .filter((k) => k.endsWith("_*") && entry.tools[k] === true)
        .map((k) => k.replace(/_?\*$/, ""))
      const desc = entry.description || ""
      console.log(
        `  @${name.padEnd(18)} → ${mcps.join(", ") || "no MCP"}${desc ? `  (${desc})` : ""}`
      )
    }
  }

  console.log("")
  console.log("Global tool disables:")
  const disabled = Object.entries(tools).filter(([, v]) => v === false)
  if (disabled.length === 0) {
    console.log("  No MCP tools disabled (all loaded in main session)")
  } else {
    for (const [pattern] of disabled) {
      console.log(`  ${pattern}`)
    }
  }
}

function cmdStatus(config) {
  const mcp = config.mcp || {}
  const agent = config.agent || {}
  const tools = config.tools || {}

  const servers = Object.entries(mcp).filter(([, e]) => e.enabled !== false)
  const subagents = Object.entries(agent).filter(([, e]) => e.mode !== "primary")
  const disabledPatterns = Object.entries(tools).filter(([, v]) => v === false)

  // Build coverage map
  const mcpNames = servers.map(([n]) => n)
  const assigned = new Set()
  for (const [, entry] of subagents) {
    if (entry.tools) {
      for (const [k, v] of Object.entries(entry.tools)) {
        if (v === true && k.endsWith("_*")) {
          assigned.add(k.replace(/_?\*$/, ""))
        }
      }
    }
  }

  console.log("MCP Server Status:")
  console.log("")

  // Check if strategy is active
  const allDisabled = mcpNames.every((n) =>
    disabledPatterns.some(([p]) => p === `${n}_*`)
  )

  console.log(`  MCP servers:     ${servers.length}`)
  console.log(`  Subagents:       ${subagents.length}`)
  console.log(`  Assigned MCPS:   ${assigned.size}/${mcpNames.length}`)

  if (allDisabled) {
    console.log("")
    console.log("  Strategy: Global disable + Subagent routing")
    console.log("  MCP tools in main session: 0 (all disabled)")
    console.log("  Estimated savings per turn: ~3,000+ tokens")
  } else {
    console.log("")
    console.log(
      "  Strategy: Legacy (all MCP tools loaded in main session)"
    )
    console.log(
      "  Tip: Add global tool disables for token savings."
    )
  }

  console.log("")
  console.log("  Subagent routing map:")
  if (subagents.length === 0) {
    console.log("    (none configured)")
  } else {
    for (const [name, entry] of subagents) {
      const mcps = entry.tools
        ? Object.keys(entry.tools)
            .filter((k) => k.endsWith("_*") && entry.tools[k] === true)
            .map((k) => k.replace(/_?\*$/, ""))
            .join(", ")
        : ""
      console.log(
        `    @${name.padEnd(18)} → ${mcps || "no MCP set"}`
      )
    }
  }

  console.log("")
  console.log(
    "  Tip: Use mcp_stats tool in-session for real-time status."
  )
}

function cmdHelp() {
  console.log("opencode-mcp-triage — Subagent Router for MCP Tools")
  console.log("")
  console.log("  Reduces MCP token usage by disabling all MCP tools globally")
  console.log("  and routing work to scoped subagents via @mentions.")
  console.log("")
  console.log("Usage: opencode-mcp-triage <command>")
  console.log("")
  console.log("Commands:")
  for (const [cmd, desc] of Object.entries(COMMANDS)) {
    console.log(`  ${cmd.padEnd(12)} ${desc}`)
  }
  console.log("")
  console.log("How it works:")
  console.log("  1. Global tool disables remove MCP tools from main session")
  console.log("  2. Subagents keep scoped MCP tools via agent.tools")
  console.log("  3. triage_mcp() routes queries to matching @subagent")
  console.log("  4. LLM invokes subagent via Task tool or @mention")
  console.log("")
  console.log("Configure in opencode.jsonc:")
  console.log('  "tools": { "mymcp_*": false }            # disable globally')
  console.log('  "agent": { "myagent": {                   # create subagent')
  console.log('    "mode": "subagent",')
  console.log('    "description": "...",')
  console.log('    "tools": { "mymcp_*": true }')
  console.log('  } }')
}

// ── Main ───────────────────────────────────────────────────
const arg = process.argv[2] || "help"
const cwd = process.cwd()

const config = findConfig(cwd) || findConfig(homedir())

if (!config) {
  console.log("No opencode.jsonc found in project or global config.")
  process.exit(1)
}

switch (arg) {
  case "list":
    cmdList(config)
    break
  case "status":
    cmdStatus(config)
    break
  case "help":
  default:
    cmdHelp()
}
