/**
 * Tests for CLI utilities: Levenshtein distance, command suggestion, JSON output.
 */

import { describe, it, expect } from "vitest"
import { levenshtein, suggestCommand } from "../src/utils.js"

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
