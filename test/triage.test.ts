/**
 * Tests for triage.ts scoring engine.
 *
 * Covers:
 * - Word boundary vs substring matching
 * - Weighted scoring (name x3, desc x1, mcp x3)
 * - Threshold logic for auto-routing
 * - Edge cases: empty queries, short words, special chars
 * - Unicode support
 */

import { describe, it, expect } from "vitest"
import { scoreSubagents, THRESHOLD } from "../src/triage.js"
import type { Subagent } from "../src/types.js"

const mockSubagents: Subagent[] = [
  {
    name: "github",
    description: "Manage GitHub issues, PRs, and repositories",
    mcpServers: ["github"],
  },
  {
    name: "supabase",
    description: "Database operations, migrations, and queries",
    mcpServers: ["supabase"],
  },
  {
    name: "context7",
    description: "Library, SDK, and API documentation search",
    mcpServers: ["context7"],
  },
]

describe("scoreSubagents", () => {
  it("returns empty array for empty query", () => {
    const result = scoreSubagents("", mockSubagents)
    expect(result).toEqual([])
  })

  it("filters words shorter than MIN_WORD_LENGTH", () => {
    const result = scoreSubagents("a", mockSubagents)
    expect(result).toEqual([])
  })

  it("scores exact word boundary match higher than substring", () => {
    const result = scoreSubagents("github", mockSubagents)
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)

    expect(result[0].subagent.name).toBe("github")
    // Word boundary match: 15 * NAME_WEIGHT(3) = 45 for name
    // Plus MCP match: 15 * NAME_WEIGHT(3) = 45 for mcp
    expect(result[0].score).toBeGreaterThanOrEqual(45)
  })

  it("scores substring match lower than word boundary", () => {
    const result = scoreSubagents("git", mockSubagents)
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)

    expect(result[0].subagent.name).toBe("github")
    // Substring match: 10 * NAME_WEIGHT(3) = 30 for name
    // Plus MCP substring: 10 * NAME_WEIGHT(3) = 30 for mcp
    expect(result[0].score).toBeGreaterThanOrEqual(30)
  })

  it("scores description matches with lower weight", () => {
    const result = scoreSubagents("database", mockSubagents)
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)

    expect(result[0].subagent.name).toBe("supabase")
    // Description word boundary: 15 * DESC_WEIGHT(1) = 15
    expect(result[0].score).toBeGreaterThanOrEqual(15)
  })

  it("handles multiple query words", () => {
    const result = scoreSubagents("github issue", mockSubagents)
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)

    expect(result[0].subagent.name).toBe("github")
    // "github" matches name + mcp, "issue" matches description
    expect(result[0].score).toBeGreaterThan(45)
  })

  it("is case-insensitive", () => {
    const result1 = scoreSubagents("GitHub", mockSubagents)
    const result2 = scoreSubagents("github", mockSubagents)
    expect(result1).toEqual(result2)
  })

  it("strips punctuation from query words", () => {
    const result1 = scoreSubagents("github!", mockSubagents)
    const result2 = scoreSubagents("github", mockSubagents)
    expect(result1).toEqual(result2)
  })

  it("returns matchedBy explanation", () => {
    const result = scoreSubagents("github", mockSubagents)
      .filter((s) => s.score > 0)[0]

    expect(result.matchedBy).toContain("name:github")
    expect(result.matchedBy).toContain("mcp:github:github")
  })

  it("handles Unicode query words", () => {
    const unicodeSubagents: Subagent[] = [
      {
        name: "café",
        description: "Gestión de base de datos",
        mcpServers: ["café"],
      },
    ]
    const result = scoreSubagents("café", unicodeSubagents)
    expect(result.filter((s) => s.score > 0).length).toBeGreaterThan(0)
  })

  it("returns only subagents with positive score", () => {
    const result = scoreSubagents("github", mockSubagents)
    expect(result.length).toBe(1)
    expect(result[0].subagent.name).toBe("github")
  })

  it("handles special regex characters in query", () => {
    const specialSubagents: Subagent[] = [
      {
        name: "test-server",
        description: "A test server with (special) chars",
        mcpServers: ["test-server"],
      },
    ]
    // Should not throw regex error
    expect(() => scoreSubagents("test (server)", specialSubagents)).not.toThrow()
  })
})

describe("THRESHOLD", () => {
  it("is set to 30 for confident auto-routing", () => {
    expect(THRESHOLD).toBe(30)
  })

  it("allows auto-routing when gap exceeds threshold", () => {
    const result = scoreSubagents("github", mockSubagents)
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)

    const gap = result[0].score - (result[1]?.score ?? 0)
    expect(gap).toBeGreaterThanOrEqual(THRESHOLD)
  })
})
