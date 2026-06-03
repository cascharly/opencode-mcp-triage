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
import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"
import { MAX_CONFIG_SIZE, stripBOM, validatePath, stripJsonc, mergeConfigSection } from "./utils.js"

interface SubagentConfig {
  mode?: string
  description?: string
  tools?: Record<string, boolean>
  [key: string]: unknown
}

/**
 * Returns the list of config paths to check for a given base directory.
 * Global and project paths differ in search order and location.
 */
function getConfigPaths(baseDir: string): string[] {
  const isGlobal = baseDir === homedir()
  return isGlobal
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
  const globalConfig = await findAndParseConfig(homedir(), "mcp")
  const projectConfig = await findAndParseConfig(directory, "mcp")

  // Project overrides global for same-named servers
  const merged = mergeConfigSection<Record<string, McpConfigEntry>>(
    globalConfig,
    projectConfig,
    "mcp"
  )

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
  const globalConfig = await findAndParseConfig(homedir(), "agent")
  const projectConfig = await findAndParseConfig(directory, "agent")

  // Project overrides global for same-named agents
  const merged = mergeConfigSection<Record<string, SubagentConfig>>(
    globalConfig,
    projectConfig,
    "agent"
  )

  const result: Subagent[] = []

  for (const [name, entry] of Object.entries(merged)) {
    // Skip primary agents — they run in main session, not as subagents
    if (entry.mode === "primary") continue
    if (!entry.tools || typeof entry.tools !== "object") continue

    // Extract MCP server names from tool scoping patterns like "github_*": true.
    // Require exact "_*" suffix — bare "*" would not match opencode's glob
    // for tools like github_create_issue, so we'd record a phantom coverage
    // and the subagent would end up with zero tools.
    const tools = entry.tools as Record<string, boolean>
    const mcpServers = Object.keys(tools)
      .filter((k) => k.endsWith("_*") && tools[k] === true)
      .map((k) => k.slice(0, -2))

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
 * Finds and parses an opencode config file from a base directory.
 *
 * Search order (global vs project differs):
 * - Global: ~/.config/opencode/opencode.jsonc → opencode.json
 * - Project: .opencode/opencode.json → opencode.jsonc → opencode.jsonc → opencode.json
 *
 * When `requireKey` is set, returns only configs that contain that key
 * (used to distinguish opencode config from unrelated opencode.json files).
 * When omitted, returns the first valid JSONC parse.
 *
 * Returns null if no valid config is found.
 */
async function findAndParseConfig(
  baseDir: string,
  requireKey?: "mcp" | "agent"
): Promise<Record<string, unknown> | null> {
  const paths = getConfigPaths(baseDir)

  for (const path of paths) {
    if (!validatePath(path)) continue
    try {
      const raw = await readFile(path, "utf-8")
      if (raw.length > MAX_CONFIG_SIZE) continue
      const cleaned = stripBOM(raw)
      const json = JSON.parse(stripJsonc(cleaned))
      if (!requireKey || (json && json[requireKey])) return json
    } catch {
      // File not found or invalid JSON — try next path
    }
  }

  return null
}

/**
 * Reads a raw opencode config file (any JSONC format) from a directory.
 * Does NOT require "mcp" or "agent" keys — used by CLI to read full
 * config including "tools" and "plugin" sections.
 *
 * Returns null if no valid config file is found.
 */
export async function readRawConfig(
  baseDir: string
): Promise<Record<string, unknown> | null> {
  return findAndParseConfig(baseDir)
}

/**
 * Finds the path of the first existing opencode config file.
 * Returns the file path string or null if none exist.
 */
export async function findConfigPath(
  baseDir: string
): Promise<string | null> {
  const paths = getConfigPaths(baseDir)

  for (const path of paths) {
    if (!validatePath(path)) continue
    try {
      const s = await stat(path)
      if (s.isFile() && s.size <= MAX_CONFIG_SIZE) return path
    } catch {
      // File not found — try next
    }
  }

  return null
}
