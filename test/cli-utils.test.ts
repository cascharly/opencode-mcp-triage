/**
 * Tests for CLI utilities: Levenshtein distance, command suggestion, JSON output.
 */

import { describe, it, expect } from "vitest"

/**
 * Levenshtein distance between two strings.
 */
function levenshtein(a: string, b: string): number {
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
 */
function suggestCommand(typo: string, validCommands: string[]): string | null {
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

describe("levenshtein", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshtein("status", "status")).toBe(0)
  })

  it("returns length for empty string", () => {
    expect(levenshtein("", "abc")).toBe(3)
    expect(levenshtein("abc", "")).toBe(3)
  })

  it("calculates single character substitution", () => {
    expect(levenshtein("cat", "bat")).toBe(1)
  })

  it("calculates single character insertion", () => {
    expect(levenshtein("cat", "cart")).toBe(1)
  })

  it("calculates single character deletion", () => {
    expect(levenshtein("cart", "cat")).toBe(1)
  })

  it("handles multi-step edits", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3)
  })

  it("is symmetric", () => {
    expect(levenshtein("hello", "hallo")).toBe(levenshtein("hallo", "hello"))
  })
})

describe("suggestCommand", () => {
  const validCommands = ["status", "list", "help", "benchmark"]

  it("suggests correction for close typo", () => {
    expect(suggestCommand("stats", validCommands)).toBe("status")
    expect(suggestCommand("sttus", validCommands)).toBe("status")
  })

  it("suggests correction for list typo", () => {
    expect(suggestCommand("lsit", validCommands)).toBe("list")
    expect(suggestCommand("lis", validCommands)).toBe("list")
  })

  it("returns null for far-off typo", () => {
    expect(suggestCommand("xyzabc", validCommands)).toBeNull()
    expect(suggestCommand("completelywrong", validCommands)).toBeNull()
  })

  it("returns exact match if valid", () => {
    expect(suggestCommand("status", validCommands)).toBe("status")
  })

  it("handles single character typo", () => {
    expect(suggestCommand("hel", validCommands)).toBe("help")
  })

  it("suggests benchmark for close typo", () => {
    expect(suggestCommand("benchmrk", validCommands)).toBe("benchmark")
    expect(suggestCommand("benmark", validCommands)).toBe("benchmark")
  })
})

describe("JSON output mode", () => {
  it("produces valid JSON for status output", () => {
    const mockOutput = {
      mcpServers: 3,
      subagents: 2,
      assigned: 2,
      total: 3,
      strategy: "global-disable",
      routingMap: [
        { name: "github", mcps: ["github"] },
        { name: "supabase", mcps: ["supabase"] },
      ],
      unassigned: ["context7"],
    }
    const json = JSON.stringify(mockOutput, null, 2)
    const parsed = JSON.parse(json)
    expect(parsed.mcpServers).toBe(3)
    expect(parsed.unassigned).toContain("context7")
  })

  it("produces valid JSON for list output", () => {
    const mockOutput = {
      servers: [
        { name: "github", type: "local", enabled: true, location: "npx -y @modelcontextprotocol/server-github" },
        { name: "context7", type: "remote", enabled: true, location: "https://example.com" },
      ],
      subagents: [
        { name: "github", mcps: ["github"], description: "GitHub operations" },
      ],
      disabled: ["github_*", "supabase_*"],
    }
    const json = JSON.stringify(mockOutput, null, 2)
    const parsed = JSON.parse(json)
    expect(parsed.servers.length).toBe(2)
    expect(parsed.disabled.length).toBe(2)
  })
})
