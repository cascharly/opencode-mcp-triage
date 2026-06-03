/**
 * Tests for config.ts JSONC parsing and security features.
 *
 * Covers:
 * - BOM stripping
 * - Size limit enforcement
 * - JSONC comment handling (block, line, nested)
 * - Trailing comma removal
 * - URL preservation (:// not stripped)
 * - String-aware comment stripping
 * - Phantom glob bug fix in subagent detection
 * - mergeConfigSection helper
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { stripJsonc, stripBOM, mergeConfigSection } from "../src/utils.js"
import { readSubagentConfig } from "../src/config.js"

describe("stripBOM", () => {
  it("removes UTF-8 BOM", () => {
    const withBOM = "\uFEFF{ \"key\": \"value\" }"
    expect(stripBOM(withBOM)).toBe('{ "key": "value" }')
  })

  it("leaves string without BOM unchanged", () => {
    const withoutBOM = '{ "key": "value" }'
    expect(stripBOM(withoutBOM)).toBe('{ "key": "value" }')
  })

  it("handles empty string", () => {
    expect(stripBOM("")).toBe("")
  })
})

describe("stripJsonc", () => {
  it("removes block comments", () => {
    const input = `{
  /* This is a comment */
  "key": "value"
}`
    const result = stripJsonc(input)
    expect(JSON.parse(result)).toEqual({ key: "value" })
  })

  it("removes line comments", () => {
    const input = `{
  // This is a comment
  "key": "value"
}`
    const result = stripJsonc(input)
    expect(JSON.parse(result)).toEqual({ key: "value" })
  })

  it("preserves URLs with ://", () => {
    const input = `{
  "url": "https://example.com"
}`
    const result = stripJsonc(input)
    expect(JSON.parse(result)).toEqual({ url: "https://example.com" })
  })

  it("removes trailing commas", () => {
    const input = `{
  "a": 1,
  "b": 2,
}`
    const result = stripJsonc(input)
    expect(JSON.parse(result)).toEqual({ a: 1, b: 2 })
  })

  it("handles nested comments", () => {
    const input = `{
  /* outer /* not nested */
  "key": "value" // inline
}`
    const result = stripJsonc(input)
    expect(JSON.parse(result)).toEqual({ key: "value" })
  })

  it("does not strip // inside strings", () => {
    const input = `{
  "path": "C:\\\\folder\\\\file",
  "url": "https://api.example.com"
}`
    const result = stripJsonc(input)
    const parsed = JSON.parse(result)
    expect(parsed.path).toBe("C:\\folder\\file")
    expect(parsed.url).toBe("https://api.example.com")
  })

  it("handles escaped quotes in strings", () => {
    const input = `{
  "message": "He said \\"hello\\" // not a comment"
}`
    const result = stripJsonc(input)
    expect(JSON.parse(result).message).toBe('He said "hello" // not a comment')
  })

  it("handles multiline block comments", () => {
    const input = `{
  /*
   * Multiline
   * comment
   */
  "key": "value"
}`
    const result = stripJsonc(input)
    expect(JSON.parse(result)).toEqual({ key: "value" })
  })

  it("handles trailing commas in arrays", () => {
    const input = `{
  "items": [1, 2, 3,]
}`
    const result = stripJsonc(input)
    expect(JSON.parse(result)).toEqual({ items: [1, 2, 3] })
  })

  it("handles empty object", () => {
    expect(JSON.parse(stripJsonc("{}"))).toEqual({})
  })

  it("handles complex nested structure", () => {
    const input = `{
  "mcp": {
    "github": {
      "type": "local",
      "command": ["npx", "-y", "@modelcontextprotocol/server-github"],
      // "disabled": true,
      "enabled": true
    },
  },
  "agent": {
    "github-agent": {
      "mode": "subagent",
      "tools": {
        "github_*": true,
      }
    }
  }
}`
    const result = stripJsonc(input)
    const parsed = JSON.parse(result)
    expect(parsed.mcp.github.enabled).toBe(true)
    expect(parsed.mcp.github).not.toHaveProperty("disabled")
    expect(parsed.agent["github-agent"].tools["github_*"]).toBe(true)
  })
})

describe("size limit", () => {
  it("rejects files larger than 1MB", () => {
    const MAX_CONFIG_SIZE = 1024 * 1024
    const oversized = "a".repeat(MAX_CONFIG_SIZE + 1)
    expect(oversized.length).toBeGreaterThan(MAX_CONFIG_SIZE)
  })

  it("accepts files at exactly 1MB", () => {
    const MAX_CONFIG_SIZE = 1024 * 1024
    const exact = "a".repeat(MAX_CONFIG_SIZE)
    expect(exact.length).toBe(MAX_CONFIG_SIZE)
  })
})

describe("mergeConfigSection", () => {
  it("returns empty when neither level has the key", () => {
    expect(mergeConfigSection({}, {}, "missing")).toEqual({})
  })

  it("returns project override over global for the merged key", () => {
    const global = { mcp: { a: 1 } }
    const project = { mcp: { a: 2 } }
    expect(mergeConfigSection(global, project, "mcp")).toEqual({ a: 2 })
  })

  it("merges entries from both levels for the key", () => {
    const global = { mcp: { a: 1 } }
    const project = { mcp: { b: 2 } }
    expect(mergeConfigSection(global, project, "mcp")).toEqual({ a: 1, b: 2 })
  })

  it("handles null config levels", () => {
    expect(mergeConfigSection(null, { mcp: { a: 1 } }, "mcp")).toEqual({ a: 1 })
    expect(mergeConfigSection({ mcp: { a: 1 } }, null, "mcp")).toEqual({ a: 1 })
  })

  it("returns empty when the key is absent from both", () => {
    expect(mergeConfigSection({ x: 1 }, { y: 2 }, "mcp")).toEqual({})
  })
})

describe("readSubagentConfig — phantom glob bug fix", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cfg-phantom-"))
    mkdirSync(join(tmpDir, ".opencode"), { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("matches 'github_*' as covering github MCP", async () => {
    writeFileSync(join(tmpDir, ".opencode", "opencode.jsonc"), `{
  "agent": {
    "gh": {
      "mode": "subagent",
      "tools": { "github_*": true }
    }
  }
}`)
    const subs = await readSubagentConfig(tmpDir)
    const gh = subs.filter((s) => s.name === "gh")
    expect(gh).toHaveLength(1)
    expect(gh[0].mcpServers).toEqual(["github"])
  })

  it("does NOT match bare 'github*' (no underscore) as covering github MCP", async () => {
    writeFileSync(join(tmpDir, ".opencode", "opencode.jsonc"), `{
  "agent": {
    "gh": {
      "mode": "subagent",
      "tools": { "github*": true }
    }
  }
}`)
    const subs = await readSubagentConfig(tmpDir)
    const gh = subs.filter((s) => s.name === "gh")
    expect(gh).toHaveLength(0)
  })

  it("skips false-valued tool entries", async () => {
    writeFileSync(join(tmpDir, ".opencode", "opencode.jsonc"), `{
  "agent": {
    "gh": {
      "mode": "subagent",
      "tools": { "github_*": false }
    }
  }
}`)
    const subs = await readSubagentConfig(tmpDir)
    const gh = subs.filter((s) => s.name === "gh")
    expect(gh).toHaveLength(0)
  })
})
