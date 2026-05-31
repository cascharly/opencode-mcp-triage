/**
 * Config file writer for disabling MCP tools in the main agent.
 *
 * Purpose: On plugin init, writes "servername_*": false entries into the
 * project-level opencode.jsonc tools block. This disables MCP tools in the
 * main session (saves tokens) while subagents re-enable them via tool scoping.
 *
 * Why string manipulation instead of JSON parse → modify → stringify?
 * - opencode.jsonc uses JSONC (comments, trailing commas)
 * - JSON.parse strips comments — we'd lose user comments on re-write
 * - String manipulation preserves comments and formatting
 *
 * Trade-off: more fragile than proper JSON manipulation. We compensate with:
 * - Stripping comments before regex matching
 * - Position mapping between stripped and original strings
 * - Validation before writing (parse check catches broken output)
 *
 * IMPORTANT: This only writes to the project-level config, never global.
 * Project config takes priority in OpenCode's config resolution.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises"
import { join, dirname } from "node:path"
import { homedir } from "node:os"
import { readLock, writeLock } from "./lock.js"
import type { McpServer, Subagent } from "./types.js"
import { MAX_CONFIG_SIZE, stripBOM, validatePath, escapeRegex, safeWriteFile } from "./utils.js"

/**
 * Ensures all MCP server tools are disabled in the main agent's tools config.
 *
 * Idempotent: checks if entries already exist before writing.
 * Only writes when missing entries are found.
 *
 * The disable pattern is "servername_*": false — OpenCode uses this glob
 * pattern to match all tools from a given MCP server.
 *
 * @returns true if file was modified, false if already disabled or error
 */
export async function ensureToolsDisabled(
  directory: string,
  mcpServers: string[]
): Promise<boolean> {
  if (mcpServers.length === 0) return false

  const resolved = await findProjectConfigPath(directory)
  if (!resolved) return false

  const { path: configPath, exists } = resolved

  let raw: string
  if (exists) {
    try {
      raw = await readFile(configPath, "utf-8")
      // Size limit: reject files > 1MB
      if (raw.length > MAX_CONFIG_SIZE) return false
    } catch {
      return false
    }
  } else {
    // No project config exists — start with empty object
    raw = "{}"
  }

  // Strip BOM (Windows editors may prepend it)
  raw = stripBOM(raw)

  // Strip comments before checking — comments like // "github_*": false
  // should not count as actual disable entries
  const stripped = stripJsonComments(raw)
  const missing = mcpServers.filter((name) => {
    const regex = new RegExp(
      `"${escapeRegex(name)}_\\*"\\s*:\\s*false`
    )
    return !regex.test(stripped)
  })

  // All servers already disabled — nothing to do
  if (missing.length === 0) return false

  // Build the new entries as JSON text (one per line for readability)
  const newEntries = missing.map((name) => `"${name}_*": false`).join(",\n    ")

  // Use stripped version to find "tools" — avoids matching comments
  const toolsMatch = stripped.match(/"tools"\s*:\s*\{/)
  let modified: string

  if (toolsMatch) {
    // "tools" block exists — insert entries after opening brace
    // Map position from stripped string back to original (comments shift positions)
    if (toolsMatch.index === undefined) return false
    const insertPos = mapStrippedPosition(raw, stripped, toolsMatch.index + toolsMatch[0].length)
    const prefix = raw.slice(0, insertPos)
    const suffix = raw.slice(insertPos)

    // Check if tools block is empty {} (skip comments to find real closing brace)
    const suffixStripped = stripJsonComments(suffix)
    const emptyBlockMatch = suffixStripped.match(/^\s*\}/)
    if (emptyBlockMatch) {
      // Empty block: replace {} with { newEntries }
      const emptyEndPos = mapStrippedPosition(raw, suffix, suffixStripped.indexOf("}") + 1)
      modified = prefix + "\n    " + newEntries + "\n  " + raw.slice(insertPos + emptyEndPos)
    } else {
      // Non-empty block: prepend entries after opening brace
      // We prepend (not append) so user's existing entries stay at the bottom
      modified = prefix + "\n    " + newEntries + ",\n    " + suffix.trimStart()
    }
  } else {
    // No "tools" block — create one before the closing root brace
    const toolsBlock = `"tools": {\n    ${newEntries}\n  }`

    // Use stripped version to find closing brace (comments can contain } chars)
    const strippedForBrace = stripJsonComments(raw)
    const closingBrace = findClosingRootBrace(strippedForBrace)

    if (closingBrace >= 0) {
      // Found closing brace — insert tools block before it
      // Use lastIndexOf on original since stripped positions don't map cleanly here
      const lastBrace = raw.lastIndexOf("}")
      const beforeRaw = raw.slice(0, lastBrace).trimEnd()
      const afterRaw = raw.slice(lastBrace)
      // Add comma only if root object has other keys
      const prefix = beforeRaw === "{" ? "" : ","
      modified = beforeRaw + prefix + "\n  " + toolsBlock + "\n" + afterRaw
    } else {
      // No closing brace found (malformed JSON) — append tools block
      modified = raw.trimEnd() + ",\n  " + toolsBlock + "\n}"
    }
  }

  // Safety check: validate the modified content parses as valid JSON
  // Catches bugs in string manipulation before corrupting the config file
  try {
    JSON.parse(stripJsonComments(modified))
  } catch {
    throw new Error("Generated invalid JSONC when disabling MCP tools")
  }

  await safeWriteFile(configPath, modified)
  return true
}

/**
 * Ensures auto-created subagents exist for all unassigned MCP servers.
 *
 * An MCP server is "unassigned" when no existing subagent covers it AND
 * it hasn't been previously auto-created and removed by the user (tracked
 * via the lock file).
 *
 * Creates one subagent per MCP server with:
 * - name = MCP server name
 * - description = server description, or "<name> operations" fallback
 * - mode = "subagent"
 * - tools = { "name_*": true }
 *
 * @returns number of subagents created
 */
export async function ensureSubagentsCreated(
  directory: string,
  mcpServers: McpServer[],
  existingSubagents: Subagent[]
): Promise<number> {
  if (mcpServers.length === 0) return 0

  // Find which MCPs are already covered by existing subagents
  const covered = new Set<string>()
  for (const sa of existingSubagents) {
    for (const m of sa.mcpServers) {
      covered.add(m)
    }
  }

  // Read lock file — MCPs in autoCreated were previously created
  // If user deleted them, they stay in the lock file and we respect that
  const lock = await readLock(directory)
  const previouslyCreated = new Set(
    lock ? Object.keys(lock.autoCreated) : []
  )

  // MCPs that need subagents: not covered AND not previously declined
  const toCreate = mcpServers.filter(
    (m) => !covered.has(m.name) && !previouslyCreated.has(m.name)
  )

  if (toCreate.length === 0) return 0

  const resolved = await findProjectConfigPath(directory)
  if (!resolved) return 0

  let raw: string
  try {
    raw = await readFile(resolved.path, "utf-8")
    // Size limit: reject files > 1MB
    if (raw.length > MAX_CONFIG_SIZE) return 0
  } catch {
    raw = "{}"
  }

  // Strip BOM (Windows editors may prepend it)
  raw = stripBOM(raw)

  // Build subagent entries as JSON text
  const entries = toCreate.map((mcp) => {
    const desc = mcp.description
      ? jsonEscape(mcp.description)
      : `${mcp.name} operations`
    return `"${mcp.name}": {\n      "description": "${desc}",\n      "mode": "subagent",\n      "tools": {\n        "${mcp.name}_*": true\n      }\n    }`
  })

  const entriesText = entries.join(",\n    ")

  const stripped = stripJsonComments(raw)
  const agentMatch = stripped.match(/"agent"\s*:\s*\{/)

  let modified: string

  if (agentMatch) {
    if (agentMatch.index === undefined) return 0
    const insertPos = mapStrippedPosition(
      raw, stripped,
      agentMatch.index + agentMatch[0].length
    )
    const prefix = raw.slice(0, insertPos)
    const suffix = raw.slice(insertPos)

    const suffixStripped = stripJsonComments(suffix)
    const emptyBlockMatch = suffixStripped.match(/^\s*\}/)
    if (emptyBlockMatch) {
      const emptyEndPos = mapStrippedPosition(
        raw, suffix,
        suffixStripped.indexOf("}") + 1
      )
      modified = prefix + "\n    " + entriesText + "\n  " +
        raw.slice(insertPos + emptyEndPos)
    } else {
      modified =
        prefix + "\n    " + entriesText + ",\n    " + suffix.trimStart()
    }
  } else {
    const agentBlock =
      `"agent": {\n    ${entriesText}\n  }`

    const strippedForBrace = stripJsonComments(raw)
    const closingBrace = findClosingRootBrace(strippedForBrace)

    if (closingBrace >= 0) {
      const lastBrace = raw.lastIndexOf("}")
      const beforeRaw = raw.slice(0, lastBrace).trimEnd()
      const afterRaw = raw.slice(lastBrace)
      const prefix = beforeRaw === "{" ? "" : ","
      modified = beforeRaw + prefix + "\n  " + agentBlock + "\n" + afterRaw
    } else {
      modified = raw.trimEnd() + ",\n  " + agentBlock + "\n}"
    }
  }

  // Safety check
  try {
    JSON.parse(stripJsonComments(modified))
  } catch {
    throw new Error("Generated invalid JSONC when creating subagent entries")
  }

  await safeWriteFile(resolved.path, modified)

  // Update lock file
  const newAutoCreated: Record<string, string> = {
    ...(lock?.autoCreated ?? {}),
  }
  for (const m of toCreate) {
    newAutoCreated[m.name] = m.name
  }
  await writeLock(directory, {
    version: 1,
    autoCreated: newAutoCreated,
    enabled: lock?.enabled,
  })

  return toCreate.length
}

/**
 * Removes all "servername_*": false disable entries from config.
 * Reverse of ensureToolsDisabled. Restores MCP tools to main session.
 *
 * Uses regex on raw string since entries follow predictable format
 * (written by ensureToolsDisabled). Cleans up trailing commas and
 * empty tools blocks after removal.
 *
 * @returns true if file was modified
 */
export async function removeToolsDisable(
  directory: string,
  mcpNames: string[]
): Promise<boolean> {
  if (mcpNames.length === 0) return false

  const resolved = await findProjectConfigPath(directory)
  if (!resolved || !resolved.exists) return false

  let raw: string
  try {
    raw = await readFile(resolved.path, "utf-8")
    if (raw.length > MAX_CONFIG_SIZE) return false
  } catch {
    return false
  }

  raw = stripBOM(raw)
  let modified = raw

  for (const name of mcpNames) {
    const escaped = escapeRegex(name)
    const re = new RegExp(
      `(,\\s*)?\\r?\\n\\s*\\"${escaped}_\\*\\"\\s*\\:\\s*false`,
      "g"
    )
    modified = modified.replace(re, "")
  }

  if (modified === raw) return false

  modified = modified.replace(/,\s*(\r?\n\s*")/g, "$1")
  modified = modified.replace(/,\s*(\n\s*[\}\]])/g, "$1")
  modified = modified.replace(/"tools"\s*:\s*\{\s*(\n\s*)?\}/g, "")
  modified = modified.replace(/,\s*([}\]])/g, "$1")

  try {
    JSON.parse(stripJsonComments(modified))
  } catch {
    return false
  }

  await safeWriteFile(resolved.path, modified)
  return true
}

/**
 * Finds the project-level opencode config file path.
 *
 * Search order (first match wins):
 * 1. .opencode/opencode.json
 * 2. .opencode/opencode.jsonc
 * 3. opencode.jsonc (project root)
 * 4. opencode.json (project root)
 *
 * If no project config exists, checks for a global config.
 * If global exists, returns a new project path (.opencode/opencode.jsonc)
 * with exists: false — caller should create it.
 *
 * Returns null if neither project nor global config exists.
 */
async function findProjectConfigPath(
  directory: string
): Promise<{ path: string; exists: boolean } | null> {
  const paths = [
    join(directory, ".opencode", "opencode.json"),
    join(directory, ".opencode", "opencode.jsonc"),
    join(directory, "opencode.jsonc"),
    join(directory, "opencode.json"),
  ]

  for (const path of paths) {
    if (!validatePath(path)) continue
    try {
      await readFile(path, "utf-8")
      return { path, exists: true }
    } catch {
      // File not found — try next path
    }
  }

  // No project config — check if global config exists
  // If so, we'll create a project-level override with just the tools section
  const globalPaths = [
    join(homedir(), ".config", "opencode", "opencode.jsonc"),
    join(homedir(), ".config", "opencode", "opencode.json"),
  ]

  for (const path of globalPaths) {
    if (!validatePath(path)) continue
    try {
      await readFile(path, "utf-8")
      // Global has config — create project-level tools-only override
      const newPath = join(directory, ".opencode", "opencode.jsonc")
      return { path: newPath, exists: false }
    } catch {
      // Global not found either — try next path
    }
  }

  return null
}

/**
 * Maps a character position from a stripped (comment-free) string back to
 * the original string with comments.
 *
 * Used when we find a match position in the stripped version (for regex
 * matching) but need to insert/modify text in the original.
 *
 * Works by walking both strings in parallel — when characters match,
 * advance the stripped index. Always advance the original index.
 * When stripped index reaches the target position, original index is
 * the corresponding position in the original string.
 *
 * O(n) where n is the original string length.
 */
/** @internal exported for testing */
export function mapStrippedPosition(original: string, stripped: string, strippedPos: number): number {
  let origIdx = 0
  let strippedIdx = 0
  while (strippedIdx < strippedPos && origIdx < original.length) {
    if (original[origIdx] === stripped[strippedIdx]) {
      strippedIdx++
    }
    origIdx++
  }
  return origIdx
}

/**
 * Strips JSONC comments from a raw JSON string.
 *
 * Handles:
 * - Block comments: /* ... * /
 * - Line comments: // ... (negative lookbehind (?<!:) avoids matching :// in URLs)
 * - String awareness: // inside quoted strings is NOT treated as comment
 *
 * Does NOT handle trailing commas — that's handled separately in stripJsonc().
 * This version is simpler because we only need it for regex matching, not parsing.
 */
/** @internal exported for testing */
export function stripJsonComments(raw: string): string {
  let result = raw.replace(/\/\*[\s\S]*?\*\//g, "")
  result = stripLineComments(result)
  return result
}

function stripLineComments(raw: string): string {
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

    if (ch === '"') {
      inString = true
      result += ch
      i++
      continue
    }

    if (ch === "/" && i + 1 < raw.length && raw[i + 1] === "/") {
      while (i < raw.length && raw[i] !== "\n") {
        i++
      }
      continue
    }

    result += ch
    i++
  }

  return result
}

/** @internal exported for testing */
export function jsonEscape(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
}

/**
 * Finds the position of the closing brace of the root JSON object.
 *
 * Scans backwards from the end of the string, tracking:
 * - Brace depth: } increments, { decrements
 * - String state: ignores braces inside quoted strings
 * - Escape sequences: counts consecutive backslashes before quotes
 *   to correctly handle \\" (escaped backslash + quote that opens string)
 *
 * Returns the index of the root closing brace, or -1 if not found.
 *
 * IMPORTANT: Input should be comment-stripped. Comments can contain
 * braces that would throw off the depth counter.
 */
/** @internal exported for testing */
export function findClosingRootBrace(raw: string): number {
  let depth = 0
  let inString = false

  for (let i = raw.length - 1; i >= 0; i--) {
    const ch = raw[i]

    if (inString) {
      if (ch === '"') {
        // Count consecutive backslashes before the quote
        // Odd count = quote is escaped (\"), even count = real string end
        let backslashCount = 0
        let j = i - 1
        while (j >= 0 && raw[j] === '\\') {
          backslashCount++
          j--
        }
        if (backslashCount % 2 === 0) inString = false
      }
      continue
    }

    if (ch === '"') {
      inString = true
      continue
    }

    if (ch === "}") depth++
    if (ch === "{") depth--

    // depth === 1 means we just closed the root object
    if (depth === 1 && ch === "}") return i
  }

  return -1
}
