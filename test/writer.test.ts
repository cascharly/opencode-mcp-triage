/**
 * Tests for writer.ts config file manipulation.
 *
 * Covers:
 * - Position mapping between stripped and original strings
 * - Closing root brace finder
 * - JSON escaping
 * - Comment-aware string manipulation
 */

import { describe, it, expect } from "vitest"
import { mapStrippedPosition, findClosingRootBrace, jsonEscape, findMatchingBrace } from "../src/writer.js"
import { stripJsonc } from "../src/utils.js"

describe("mapStrippedPosition", () => {
  it("maps position when no comments exist", () => {
    const original = '{"key": "value"}'
    const stripped = original
    expect(mapStrippedPosition(original, stripped, 0)).toBe(0)
    expect(mapStrippedPosition(original, stripped, 7)).toBe(7)
  })

  it("maps position past line comment", () => {
    const original = '{\n  // comment\n  "key": "value"\n}'
    const stripped = '{\n  \n  "key": "value"\n}'
    // "key" starts at index 13 in stripped
    const strippedPos = stripped.indexOf('"key"')
    const origPos = mapStrippedPosition(original, stripped, strippedPos)
    expect(original.slice(origPos, origPos + 5)).toBe('"key"')
  })

  it("maps position past block comment", () => {
    const original = '{\n  /* block */\n  "key": "value"\n}'
    const stripped = '{\n  \n  "key": "value"\n}'
    const strippedPos = stripped.indexOf('"key"')
    const origPos = mapStrippedPosition(original, stripped, strippedPos)
    expect(original.slice(origPos, origPos + 5)).toBe('"key"')
  })

  it("handles multiple comments", () => {
    const original = '{\n  // a\n  /* b */\n  "key": 1\n}'
    const stripped = stripJsonc(original)
    const strippedPos = stripped.indexOf('"key"')
    const origPos = mapStrippedPosition(original, stripped, strippedPos)
    expect(original.slice(origPos, origPos + 5)).toBe('"key"')
  })
})

describe("findClosingRootBrace", () => {
  it("finds closing brace of simple object", () => {
    const input = '{"key": "value"}'
    expect(findClosingRootBrace(input)).toBe(input.length - 1)
  })

  it("finds closing brace with nested objects", () => {
    const input = '{"outer": {"inner": 1}}'
    expect(findClosingRootBrace(input)).toBe(input.length - 1)
  })

  it("ignores braces inside strings", () => {
    const input = '{"key": "value with } brace"}'
    expect(findClosingRootBrace(input)).toBe(input.length - 1)
  })

  it("handles escaped quotes before braces", () => {
    const input = '{"key": "value \\" with } brace"}'
    expect(findClosingRootBrace(input)).toBe(input.length - 1)
  })

  it("handles escaped backslash before quote", () => {
    // \\" = escaped backslash + quote that opens string
    const input = '{"path": "C:\\\\folder"}'
    expect(findClosingRootBrace(input)).toBe(input.length - 1)
  })

  it("returns -1 for malformed input", () => {
    expect(findClosingRootBrace('{"key": "value"')).toBe(-1)
  })

  it("handles deeply nested structure", () => {
    const input = '{"a": {"b": {"c": 1}}}'
    expect(findClosingRootBrace(input)).toBe(input.length - 1)
  })
})

describe("jsonEscape", () => {
  it("escapes backslashes", () => {
    expect(jsonEscape("C:\\path")).toBe("C:\\\\path")
  })

  it("escapes double quotes", () => {
    expect(jsonEscape('say "hello"')).toBe('say \\"hello\\"')
  })

  it("escapes newlines", () => {
    expect(jsonEscape("line1\nline2")).toBe("line1\\nline2")
  })

  it("escapes tabs", () => {
    expect(jsonEscape("col1\tcol2")).toBe("col1\\tcol2")
  })

  it("escapes carriage returns", () => {
    expect(jsonEscape("line1\r\nline2")).toBe("line1\\r\\nline2")
  })

  it("handles multiple escape sequences", () => {
    const input = 'path: "C:\\test"\nnew line'
    const escaped = jsonEscape(input)
    expect(escaped).toBe('path: \\"C:\\\\test\\"\\nnew line')
  })
})

describe("stripJsonComments (writer delegate to utils.stripJsonc)", () => {
  it("removes line comments", () => {
    const input = '{\n  "key": "value" // comment\n}'
    const result = stripJsonc(input)
    expect(result).toContain('"key": "value"')
    expect(result).not.toContain("// comment")
  })

  it("removes block comments", () => {
    const input = '{\n  /* comment */\n  "key": "value"\n}'
    const result = stripJsonc(input)
    expect(result).toContain('"key": "value"')
    expect(result).not.toContain("/* comment */")
  })

  it("preserves URLs", () => {
    const input = '{"url": "https://example.com"}'
    const result = stripJsonc(input)
    expect(result).toContain("https://example.com")
  })
})

describe("findMatchingBrace", () => {
  it("finds matching close for simple object", () => {
    expect(findMatchingBrace('{"a": 1}', 0)).toBe(7)
  })

  it("finds matching close with nested objects", () => {
    expect(findMatchingBrace('{"a": {"b": 2}}', 0)).toBe(14)
  })

  it("ignores braces inside strings", () => {
    expect(findMatchingBrace('{"k": "v } here"}', 0)).toBe(16)
  })

  it("treats escaped quotes as inside-string", () => {
    // The } at index 12 sits between an escaped quote and a real closing quote.
    // findMatchingBrace should ignore it and return the outer close at 14.
    const input = '{"k": "v \\" }"}'
    expect(findMatchingBrace(input, 0)).toBe(14)
  })

  it("returns -1 when string never closes (unterminated escape)", () => {
    // \"  is an escaped quote, then no more quotes. The "{" at 0 is still
    // considered open and the function returns -1.
    expect(findMatchingBrace('{"k": "v \\"', 0)).toBe(-1)
  })

  it("returns -1 when not found", () => {
    expect(findMatchingBrace('{"a": 1', 0)).toBe(-1)
  })

  it("returns -1 for non-brace index", () => {
    expect(findMatchingBrace('"a": 1', 0)).toBe(-1)
  })

  it("matches square brackets for arrays", () => {
    expect(findMatchingBrace('["a", "b", "c"]', 0)).toBe(14)
  })

  it("ignores brackets inside strings", () => {
    expect(findMatchingBrace('["a]", "b"]', 0)).toBe(10)
  })
})
