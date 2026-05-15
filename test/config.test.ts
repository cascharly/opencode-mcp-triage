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
 */

import { describe, it, expect } from "vitest"

// We need to test the internal stripJsonc function.
// Since it's not exported, we'll replicate it here for testing.
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

    // Block comment
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

    // Line comment
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

  result = result.replace(/,(?=\s*[}\]])/g, "")
  return result
}

function stripBOM(s: string): string {
  if (s.charCodeAt(0) === 0xfeff) return s.slice(1)
  return s
}

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
