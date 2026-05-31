/**
 * Shared utilities for opencode-mcp-triage.
 * Deduplicated helpers used across multiple modules.
 */

import { sep, dirname } from "node:path"
import { mkdir, writeFile } from "node:fs/promises"

/** Max config file size: 1MB — prevents memory exhaustion */
export const MAX_CONFIG_SIZE = 1024 * 1024

/**
 * Strips UTF-8 BOM (Byte Order Mark) from string.
 * Windows editors (Notepad, VSCode) may prepend BOM which breaks parsing.
 * BOM is the 3-byte sequence: EF BB BF (U+FEFF)
 */
export function stripBOM(s: string): string {
  if (s.length > 0 && s.charCodeAt(0) === 0xfeff) {
    return s.slice(1)
  }
  return s
}

/**
 * Validates a file path against path traversal attacks.
 * Rejects paths containing null bytes or .. path segments.
 * Handles both / and \ path separators on Windows.
 */
export function validatePath(path: string): boolean {
  if (path.includes("\0")) return false
  const segments = path.split(/[\\/]/)
  if (segments.includes("..")) return false
  return true
}

/**
 * Escapes regex special characters in a string.
 * Used when building dynamic regex patterns from user input or config values.
 */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")
}

/**
 * Writes a file, creating parent directories as needed.
 */
export async function safeWriteFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, "utf-8")
}

/**
 * Calculates which MCP server names are assigned to at least one subagent.
 * Returns a Set of assigned MCP names.
 */
export function calcAssignedMcps(subagents: { mcpServers: string[] }[]): Set<string> {
  const assigned = new Set<string>()
  for (const sa of subagents) {
    for (const m of sa.mcpServers) {
      assigned.add(m)
    }
  }
  return assigned
}

/**
 * Levenshtein distance between two strings.
 * Used for CLI typo correction.
 */
export function levenshtein(a: string, b: string): number {
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

/**
 * Suggests a correction for a misspelled command.
 * Uses Levenshtein distance with threshold of 3.
 */
export function suggestCommand(typo: string, validCommands: string[]): string | null {
  let best: string | null = null
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
