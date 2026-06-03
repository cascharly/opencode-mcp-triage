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

/**
 * Strips JSONC comments and trailing commas for JSON.parse compatibility.
 *
 * Single-pass char loop with string-awareness. Handles:
 * - Block comments (slash-star ... star-slash)
 * - Line comments // (excluded inside strings, so URLs like https:// safe)
 * - Trailing commas before } or ]
 *
 * Robust to block-comment markers inside quoted strings. Char loop tracks
 * inString state. Naive regex strippers (e.g. replacing block-comment markers
 * globally) fail on strings containing such markers like "use marker here".
 */
export function stripJsonc(raw: string): string {
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
  return result.replace(/,(?=\s*[}\]])/g, "")
}

/**
 * Merges global + project config sections with project-overrides-global.
 * Generic helper to dedup the { ...global.x, ...project.x } pattern.
 * Returns empty object when neither level has the key.
 */
export function mergeConfigSection<T extends Record<string, unknown>>(
  global: Record<string, unknown> | null,
  project: Record<string, unknown> | null,
  key: string
): T {
  const g = (global?.[key] as T | undefined) ?? ({} as T)
  const p = (project?.[key] as T | undefined) ?? ({} as T)
  return { ...g, ...p } as T
}
