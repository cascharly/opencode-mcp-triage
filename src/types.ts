/**
 * Shared type definitions for opencode-mcp-triage.
 *
 * Key distinction:
 * - McpConfigEntry: raw config from opencode.jsonc (has type, command, url, etc.)
 * - McpServer: simplified name + description for display
 * - Subagent: agent with MCP tool scoping, extracted from agent config
 * - ScoredSubagent: subagent + relevance score from keyword matching
 */

/**
 * MCP server config entry from opencode.jsonc.
 *
 * OpenCode supports both "env" and "environment" keys for env vars.
 * "enabled" defaults to true when omitted — we only filter out explicit false.
 */
export interface McpConfigEntry {
  type: "local" | "remote"
  command?: string[]
  args?: string[]
  url?: string
  env?: Record<string, string>
  environment?: Record<string, string>
  headers?: Record<string, string>
  enabled?: boolean
  description?: string
}

/**
 * Simplified MCP server representation.
 * Used for routing state and display — stripped of connection details.
 */
export interface McpServer {
  name: string
  description: string
}

/**
 * Subagent extracted from opencode.jsonc agent config.
 *
 * A subagent is any agent entry with:
 * - mode !== "primary"
 * - tools object containing at least one "servername_*": true entry
 *
 * The mcpServers array holds the server name prefixes (without _* suffix).
 */
export interface Subagent {
  name: string
  description: string
  mcpServers: string[]
}

/**
 * Subagent enriched with a relevance score from triage matching.
 *
 * score: cumulative points from keyword matches across name, description, and MCP names
 * matchedBy: structured array of match explanations (e.g., "name:github", "mcp:supabase:database")
 */
export interface ScoredSubagent {
  subagent: Subagent
  score: number
  matchedBy: string[]
}
