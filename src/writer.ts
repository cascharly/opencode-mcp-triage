/**
 * Config file writer for disabling MCP tools in the main agent.
 *
 * Purpose: On plugin init, writes "servername_*": false entries into the
 * project-level opencode.jsonc tools block. This disables MCP tools in the
 * main session (saves tokens) while subagents re-enable them via tool scoping.
 *
 * Why string manipulation instead of JSON parse â†’ modify â†’ stringify?
 * - opencode.jsonc uses JSONC (comments, trailing commas)
 * - JSON.parse strips comments â€” we'd lose user comments on re-write
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
import { MAX_CONFIG_SIZE, stripBOM, validatePath, escapeRegex, safeWriteFile, stripJsonc } from "./utils.js"

/**
 * Ensures all MCP server tools are disabled in the main agent's tools config.
 *
 * Idempotent: checks if entries already exist before writing.
 * Only writes when missing entries are found.
 *
 * The disable pattern is "servername_*": false â€” OpenCode uses this glob
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
    // No project config exists â€” start with empty object
    raw = "{}"
  }


  // Strip BOM (Windows editors may prepend it)
  raw = stripBOM(raw)

  // Strip comments before checking â€” comments like // "github_*": false
  // should not count as actual disable entries
  const stripped = stripJsonc(raw)
  const missing = mcpServers.filter((name) => {
    const regex = new RegExp(
      `"${escapeRegex(name)}_\\*"\\s*:\\s*false`
    )
    return !regex.test(stripped)
  })

  // All servers already disabled â€” nothing to do
  if (missing.length === 0) return false

  // Build the new entries as JSON text (one per line for readability)
  const newEntries = missing.map((name) => `"${name}_*": false`).join(",\n    ")

  // Use stripped version to find "tools" â€” avoids matching comments
  const toolsMatch = stripped.match(/"tools"\s*:\s*\{/)
  let modified: string

  if (toolsMatch) {
    // "tools" block exists â€” insert entries after opening brace
    // Map position from stripped string back to original (comments shift positions)
    if (toolsMatch.index === undefined) return false
    const insertPos = mapStrippedPosition(raw, stripped, toolsMatch.index + toolsMatch[0].length)
    const prefix = raw.slice(0, insertPos)
    const suffix = raw.slice(insertPos)

    // Check if tools block is empty {} (skip comments to find real closing brace)
    const suffixStripped = stripJsonc(suffix)
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
    // No "tools" block â€” create one before the closing root brace
    const toolsBlock = `"tools": {\n    ${newEntries}\n  }`

    // Use stripped version to find closing brace (comments can contain } chars)
    const strippedForBrace = stripJsonc(raw)
    const closingBrace = findClosingRootBrace(strippedForBrace)

    if (closingBrace >= 0) {
      // Found closing brace â€” insert tools block before it
      // Use lastIndexOf on original since stripped positions don't map cleanly here
      const lastBrace = raw.lastIndexOf("}")
      const beforeRaw = raw.slice(0, lastBrace).trimEnd()
      const afterRaw = raw.slice(lastBrace)
      // Add comma only if root object has other keys
      const prefix = beforeRaw === "{" ? "" : ","
      modified = beforeRaw + prefix + "\n  " + toolsBlock + "\n" + afterRaw
    } else {
      // No closing brace found (malformed JSON) â€” append tools block
      modified = raw.trimEnd() + ",\n  " + toolsBlock + "\n}"
    }
  }

  // Safety check: validate the modified content parses as valid JSON
  // Catches bugs in string manipulation before corrupting the config file
  try {
    JSON.parse(stripJsonc(modified))
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

  // Read lock file â€” MCPs in autoCreated were previously created
  // If user deleted them, they stay in the lock file and we respect that
  const lock = await readLock(directory)
  const previouslyCreated = new Set(lock?.autoCreated ?? [])

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
    const safeName = jsonEscape(mcp.name)
    const desc = mcp.description
      ? jsonEscape(mcp.description)
      : `${mcp.name} operations`
    return `"${safeName}": {\n      "description": "${desc}",\n      "mode": "subagent",\n      "tools": {\n        "${safeName}_*": true\n      }\n    }`
  })

  const entriesText = entries.join(",\n    ")

  const stripped = stripJsonc(raw)
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

    const suffixStripped = stripJsonc(suffix)
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

    const strippedForBrace = stripJsonc(raw)
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
    JSON.parse(stripJsonc(modified))
  } catch {
    throw new Error("Generated invalid JSONC when creating subagent entries")
  }

  await safeWriteFile(resolved.path, modified)

  // Update lock file
  const existing = new Set(lock?.autoCreated ?? [])
  for (const m of toCreate) existing.add(m.name)
  await writeLock(directory, {
    version: 1,
    autoCreated: Array.from(existing),
    enabled: lock?.enabled,
  })

  return toCreate.length
}

/**
 * Removes all "servername_*": false disable entries from config.
 * Reverse of ensureToolsDisabled. Restores MCP tools to main session.
 *
 * Scoped to the "tools" block: other tool entries (e.g. "bash": true) are
 * preserved. Only deletes the whole tools block when it becomes truly empty.
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
  const stripped = stripJsonc(raw)
  const toolsMatch = stripped.match(/"tools"\s*:\s*\{/)
  if (!toolsMatch || toolsMatch.index === undefined) return false

  const keyEndInStripped = toolsMatch.index + toolsMatch[0].length
  const blockEndInStripped = findMatchingBrace(stripped, keyEndInStripped - 1)
  if (blockEndInStripped < 0) return false

  // Map positions back to original (comments shift them)
  const origKeyStart = mapStrippedPosition(raw, stripped, toolsMatch.index)
  const origKeyEnd = mapStrippedPosition(raw, stripped, keyEndInStripped)
  const origBlockEnd = mapStrippedPosition(raw, stripped, blockEndInStripped) + 1

  const blockRaw = raw.slice(origKeyEnd, origBlockEnd)
  let modifiedBlock = blockRaw

  for (const name of mcpNames) {
    const escaped = escapeRegex(name)
    // Match entry on its own line: optional leading separator, the entry, optional trailing comma.
    // Leading context can be: opening brace (first entry), comma+newline, or just whitespace+newline.
    const re = new RegExp(
      `[,\\s\\r\\n]*\\"${escaped}_\\*\\"\\s*:\\s*false\\s*,?\\s*\\r?\\n?`,
      "g"
    )
    modifiedBlock = modifiedBlock.replace(re, "")
  }

  if (modifiedBlock === blockRaw) return false

  // Strip any dangling trailing comma left in the block
  modifiedBlock = modifiedBlock.replace(/,(\s*})/, "$1")

  // Detect empty block (only whitespace + braces)
  const blockContent = stripJsonc(modifiedBlock).replace(/^[\s{}]+|[\s{}]+$/g, "")
  const isEmpty = blockContent === ""

  let modified: string
  if (isEmpty) {
    // Remove the whole "tools": { ... } key+block from raw
    const before = raw.slice(0, origKeyStart).replace(/,(\s*})$/, "$1")
    const after = raw.slice(origBlockEnd)
    modified = before + after
  } else {
    modified = raw.slice(0, origKeyEnd) + modifiedBlock + raw.slice(origBlockEnd)
  }

  try {
    JSON.parse(stripJsonc(modified))
  } catch {
    return false
  }

  await safeWriteFile(resolved.path, modified)
  return true
}

/**
 * Removes specific subagent entries from the "agent" block.
 * Used by uninstall to clean up auto-created subagents tracked in the lock.
 * User-written subagents (not in `names`) are never touched.
 *
 * Scoped to the agent block: same safety pattern as removeToolsDisable.
 * Only deletes the whole agent block when it becomes truly empty.
 *
 * @returns number of subagent entries removed
 */
export async function removeAutoSubagents(
  directory: string,
  names: string[]
): Promise<number> {
  if (names.length === 0) return 0

  const resolved = await findProjectConfigPath(directory)
  if (!resolved || !resolved.exists) return 0

  let raw: string
  try {
    raw = await readFile(resolved.path, "utf-8")
    if (raw.length > MAX_CONFIG_SIZE) return 0
  } catch {
    return 0
  }

  raw = stripBOM(raw)
  const stripped = stripJsonc(raw)
  const agentMatch = stripped.match(/"agent"\s*:\s*\{/)
  if (!agentMatch || agentMatch.index === undefined) return 0

  const keyEndInStripped = agentMatch.index + agentMatch[0].length
  const blockEndInStripped = findMatchingBrace(stripped, keyEndInStripped - 1)
  if (blockEndInStripped < 0) return 0

  const origKeyStart = mapStrippedPosition(raw, stripped, agentMatch.index)
  const origKeyEnd = mapStrippedPosition(raw, stripped, keyEndInStripped)
  const origBlockEnd = mapStrippedPosition(raw, stripped, blockEndInStripped) + 1

  const blockRaw = raw.slice(origKeyEnd, origBlockEnd)
  let modifiedBlock = blockRaw
  let removed = 0

  for (const name of names) {
    const safeName = escapeRegex(name)
    // Match a subagent entry: "name": { ... } at any depth within the agent block.
    // We bound the match by tracking brace depth from the opening { of the entry.
    // Simpler: match the opening line, then walk forward to its matching close.
    const entryStartRe = new RegExp(
      `[,\\s\\r\\n]*\\"${safeName}\\"\\s*:\\s*\\{`,
      "g"
    )
    let m: RegExpExecArray | null
    let lastIndex = 0
    const newBlock: string[] = []
    let cursor = 0
    while ((m = entryStartRe.exec(modifiedBlock)) !== null) {
      // Skip if this match is inside a string or block comment â€” since we already
      // run on the stripped version, that's a non-issue here.
      const openBraceIdx = m.index + m[0].lastIndexOf("{")
      const closeBraceIdx = findMatchingBrace(modifiedBlock, openBraceIdx)
      if (closeBraceIdx < 0) break
      newBlock.push(modifiedBlock.slice(cursor, m.index))
      cursor = closeBraceIdx + 1
      removed++
      lastIndex = entryStartRe.lastIndex
    }
    if (newBlock.length > 0) {
      newBlock.push(modifiedBlock.slice(cursor))
      modifiedBlock = newBlock.join("")
    } else {
      // No matches â€” keep block as-is
    }
    // Suppress unused-var warning when no matches
    void lastIndex
  }

  if (removed === 0) return 0

  // Strip any dangling commas left in the block.
  // Trailing: before the block's closing } (existing pattern).
  // Leading: when the first entry is removed, its leading whitespace is
  // consumed by the regex but the separator comma that separated it from
  // the previous (non-existent) entry remains, leaving a dangling "," at
  // the start of the block. Splice that out so the result is valid JSON.
  modifiedBlock = modifiedBlock.replace(/,(\s*})/, "$1")
  modifiedBlock = modifiedBlock.replace(/^\s*,/, "")

  // Detect empty block (only whitespace + braces)
  const blockContent = stripJsonc(modifiedBlock).replace(/^[\s{}]+|[\s{}]+$/g, "")
  const isEmpty = blockContent === ""

  let modified: string
  if (isEmpty) {
    const before = raw.slice(0, origKeyStart).replace(/,(\s*})$/, "$1")
    const after = raw.slice(origBlockEnd)
    modified = before + after
  } else {
    modified = raw.slice(0, origKeyEnd) + modifiedBlock + raw.slice(origBlockEnd)
  }

  try {
    JSON.parse(stripJsonc(modified))
  } catch (e) {
    return 0
  }

  await safeWriteFile(resolved.path, modified)
  return removed
}

/**
 * Removes this plugin's entry from the "plugin" array in the project config.
 * Matches by package name, file: path pointing at this plugin, or local path
 * whose last segment contains the package name.
 *
 * Never touches the "plugin" key itself â€” only filters the array.
 *
 * @returns true if an entry was removed
 */
export async function removePluginEntry(directory: string): Promise<boolean> {
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
  const stripped = stripJsonc(raw)
  const pluginMatch = stripped.match(/"plugin"\s*:\s*\[/)
  if (!pluginMatch || pluginMatch.index === undefined) return false

  const arrStartInStripped = pluginMatch.index + pluginMatch[0].length - 1
  const arrEndInStripped = findMatchingBrace(stripped, arrStartInStripped)
  if (arrEndInStripped < 0) return false

  const origKeyStart = mapStrippedPosition(raw, stripped, pluginMatch.index)
  const origKeyEnd = mapStrippedPosition(raw, stripped, pluginMatch.index + pluginMatch[0].length)
  const origArrEnd = mapStrippedPosition(raw, stripped, arrEndInStripped) + 1

  const arrRaw = raw.slice(origKeyEnd, origArrEnd)

  // Match each array entry: optional whitespace+comma, then a quoted string value
  // up to the matching closing quote (handling escapes).
  const entryRe = /(\s*,\s*)?\s*"((?:[^"\\]|\\.)*)"\s*/g
  const entries: { value: string; raw: string; trailing: string }[] = []
  let m: RegExpExecArray | null
  while ((m = entryRe.exec(arrRaw)) !== null) {
    const value = m[2]
    const trailingStart = m.index + m[0].length
    entries.push({
      value,
      raw: arrRaw.slice(m.index, trailingStart),
      trailing: arrRaw.slice(trailingStart, trailingStart + 1),
    })
  }

  // Filter: drop entries matching this plugin
  const kept = entries.filter((e) => !matchesPluginEntry(e.value))
  if (kept.length === entries.length) return false

  // Rebuild array content. If empty, keep the brackets but drop the entries
  // (so the array key still exists if user wants to re-add later).
  const isEmpty = kept.length === 0
  const newArr = isEmpty ? "" : kept.map((e) => e.raw).join("")

  // Clean up dangling commas (leading or trailing) left after filtering.
  // Leading: when the first entry is removed, the comma that separated it
  // from the now-missing previous entry dangles at the start of the array.
  // Trailing: when the last entry is removed, the comma before the closing
  // bracket dangles at the end.
  let newBlock = newArr
  newBlock = newBlock.replace(/^\s*,/, "")
  if (newBlock.endsWith(",")) {
    newBlock = newBlock.slice(0, -1).trimEnd()
  }

  const modified =
    raw.slice(0, origKeyEnd) + newBlock + raw.slice(origArrEnd - 1)

  try {
    JSON.parse(stripJsonc(modified))
  } catch (e) {
    return false
  }

  await safeWriteFile(resolved.path, modified)
  return true
}

function matchesPluginEntry(value: string): boolean {
  if (value === "opencode-mcp-triage") return true
  if (value.startsWith("file:")) {
    return /[\\/]opencode-mcp-triage([\\/]|$)/.test(value)
  }
  return false
}

/**
 * Finds the index of the closing brace or bracket matching the opener at `openIdx`.
 * Scans forward with depth tracking and string awareness.
 * Supports `{` / `}` and `[` / `]`. Returns -1 if not found or opener is neither.
 *
 * @internal exported for testing
 */
export function findMatchingBrace(s: string, openIdx: number): number {
  const opener = s[openIdx]
  let closer: string
  if (opener === "{") closer = "}"
  else if (opener === "[") closer = "]"
  else return -1
  let depth = 0
  let inString = false
  let escape = false
  for (let i = openIdx; i < s.length; i++) {
    const ch = s[i]
    if (inString) {
      if (escape) {
        escape = false
      } else if (ch === "\\") {
        escape = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === opener) depth++
    if (ch === closer) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
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
 * with exists: false â€” caller should create it.
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
      // File not found â€” try next path
    }
  }

  // No project config â€” check if global config exists
  // If so, we'll create a project-level override with just the tools section
  const globalPaths = [
    join(homedir(), ".config", "opencode", "opencode.jsonc"),
    join(homedir(), ".config", "opencode", "opencode.json"),
  ]

  for (const path of globalPaths) {
    if (!validatePath(path)) continue
    try {
      await readFile(path, "utf-8")
      // Global has config â€” create project-level tools-only override
      const newPath = join(directory, ".opencode", "opencode.jsonc")
      return { path: newPath, exists: false }
    } catch {
      // Global not found either â€” try next path
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
 * Works by walking both strings in parallel â€” when characters match,
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
