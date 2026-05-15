/**
 * Config reader for opencode.jsonc files.
 *
 * Reads from two levels and merges (project overrides global):
 * 1. Global: ~/.config/opencode/opencode.jsonc
 * 2. Project: .opencode/opencode.jsonc, opencode.jsonc (project root)
 *
 * JSONC stripping handles:
 * - Block comments: /* ... * /
 * - Line comments: // ... (but not URLs with ://)
 * - Trailing commas before } or ]
 *
 * IMPORTANT: findAndParseConfig requires json.mcp or json.agent to exist.
 * Without this guard, any random opencode.json in the project could be
 * misinterpreted as opencode config.
 *
 * Security: BOM stripping, 1MB size limit, path traversal defense.
 */

import type { McpServer, McpConfigEntry, Subagent } from "./types.js"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"

/** Max config file size: 1MB — prevents memory exhaustion */
const MAX_CONFIG_SIZE = 1024 * 1024

/**
 * Strips UTF-8 BOM (Byte Order Mark) from string.
 * Windows editors (Notepad, VSCode) may prepend BOM which breaks parsing.
 * BOM is the 3-byte sequence: EF BB BF (U+FEFF)
 */
function stripBOM(s: string): string {
  if (s.length > 0 && s.charCodeAt(0) === 0xfeff) {
    return s.slice(1)
  }
  return s
}

interface SubagentConfig {
  mode?: string
  description?: string
  tools?: Record<string, boolean>
  [key: string]: unknown
}

/**
 * Reads all MCP servers from global + project config, merged.
 *
 * Project entries override global entries with the same name.
 * Servers with explicit enabled: false are filtered out.
 * Servers without "enabled" field are treated as enabled (OpenCode default).
 *
 * Returns simplified McpServer[] — connection details (command, url, etc.)
 * are not needed by the triage logic.
 */
export async function readMcpConfig(
  directory: string
): Promise<McpServer[]> {
  const globalConfig = await findAndParseConfig(homedir())
  const projectConfig = await findAndParseConfig(directory)

  const globalMcp = (globalConfig?.mcp as Record<string, McpConfigEntry> | undefined) ?? {}
  const projectMcp = (projectConfig?.mcp as Record<string, McpConfigEntry> | undefined) ?? {}

  // Project overrides global for same-named servers
  const merged: Record<string, McpConfigEntry> = { ...globalMcp, ...projectMcp }

  return Object.entries(merged)
    .filter(([, entry]) => entry.enabled !== false)
    .map(([name, entry]) => ({
      name,
      description: entry.description ?? "",
    }))
}

/**
 * Reads subagent definitions from global + project agent config.
 *
 * A subagent must have:
 * - mode !== "primary" (primary agents run in main session)
 * - tools object with at least one "servername_*": true entry
 *
 * The tool scoping pattern "servername_*" maps to MCP server names.
 * We extract the server name by stripping the _* or * suffix.
 *
 * Subagents without any MCP tool scoping are skipped — they're
 * regular agents, not MCP routers.
 */
export async function readSubagentConfig(
  directory: string
): Promise<Subagent[]> {
  const globalConfig = await findAndParseConfig(homedir())
  const projectConfig = await findAndParseConfig(directory)

  const globalAgent = (globalConfig?.agent as Record<string, SubagentConfig> | undefined) ?? {}
  const projectAgent = (projectConfig?.agent as Record<string, SubagentConfig> | undefined) ?? {}

  // Project overrides global for same-named agents
  const merged: Record<string, SubagentConfig> = { ...globalAgent, ...projectAgent }

  const result: Subagent[] = []

  for (const [name, entry] of Object.entries(merged)) {
    // Skip primary agents — they run in main session, not as subagents
    if (entry.mode === "primary") continue
    if (!entry.tools || typeof entry.tools !== "object") continue

    // Extract MCP server names from tool scoping patterns like "github_*": true
    const tools = entry.tools as Record<string, boolean>
    const mcpServers = Object.keys(tools)
      .filter((k) => k.endsWith("_*") && tools[k] === true)
      .map((k) => k.replace(/_?\*$/, ""))

    // Skip agents without MCP tool scoping
    if (mcpServers.length === 0) continue

    result.push({
      name,
      description: entry.description ?? "",
      mcpServers,
    })
  }

  return result
}

/**
 * Strips JSONC comments and trailing commas for JSON.parse compatibility.
 *
 * Handles:
 * - Block comments /* ... * /
 * - Line comments // ... (negative lookbehind avoids matching :// in URLs)
 * - Trailing commas before } or ]
 *
 * Note: This is a simple stripper, not a full JSONC parser.
 * It works for typical opencode.jsonc files but could fail on edge cases
 * like // inside strings. For production use, consider a proper JSONC library.
 */
function stripJsonc(raw: string): string {
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

/**
 * Finds and parses an opencode config file from a base directory.
 *
 * Search order (global vs project differs):
 * - Global: ~/.config/opencode/opencode.jsonc → opencode.json
 * - Project: .opencode/opencode.json → opencode.jsonc → opencode.jsonc → opencode.json
 *
 * Returns the first valid JSONC file that contains "mcp" or "agent" keys.
 * The key guard prevents returning unrelated JSON files (e.g., some other
 * tool's opencode.json).
 *
 * Returns null if no valid config is found.
 */
async function findAndParseConfig(
  baseDir: string
): Promise<Record<string, unknown> | null> {
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

  for (const path of paths) {
    try {
      const raw = await readFile(path, "utf-8")

      // Size limit: reject files > 1MB to prevent memory exhaustion
      if (raw.length > MAX_CONFIG_SIZE) continue

      // Strip BOM (Windows editors may prepend it)
      const cleaned = stripBOM(raw)

      const json = JSON.parse(stripJsonc(cleaned))
      // Guard: must have mcp or agent keys to be valid opencode config
      if (json && (json.mcp || json.agent)) return json
    } catch {
      // File not found or invalid JSON — try next path
    }
  }

  return null
}
