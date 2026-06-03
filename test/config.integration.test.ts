import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { ensureToolsDisabled, ensureSubagentsCreated, removeToolsDisable, removeAutoSubagents, removePluginEntry } from "../src/writer.js"
import { isTriageEnabled, toggleTriage, readLock } from "../src/lock.js"

function makeConfig(dir: string, content: string): void {
  const cfgDir = join(dir, ".opencode")
  mkdirSync(cfgDir, { recursive: true })
  writeFileSync(join(cfgDir, "opencode.jsonc"), content, "utf-8")
}

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "config-int-"))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe("ensureToolsDisabled", () => {
  it("creates tools block and disables MCP servers", async () => {
    makeConfig(tmpDir, "{}")
    const result = await ensureToolsDisabled(tmpDir, ["github", "supabase"])
    expect(result).toBe(true)

    const configPath = join(tmpDir, ".opencode", "opencode.jsonc")
    const raw = readFileSync(configPath, "utf-8")
    expect(raw).toContain('"github_*": false')
    expect(raw).toContain('"supabase_*": false')
  })

  it("is idempotent — returns false when already disabled", async () => {
    makeConfig(tmpDir, `{
  "tools": {
    "github_*": false
  }
}`)
    const result = await ensureToolsDisabled(tmpDir, ["github"])
    expect(result).toBe(false)
  })

  it("appends to existing tools block", async () => {
    makeConfig(tmpDir, `{
  "tools": {
    "existing_*": false
  }
}`)
    await ensureToolsDisabled(tmpDir, ["github"])
    const raw = readFileSync(join(tmpDir, ".opencode", "opencode.jsonc"), "utf-8")
    expect(raw).toContain('"existing_*": false')
    expect(raw).toContain('"github_*": false')
  })

  it("does nothing when mcpServers is empty", async () => {
    makeConfig(tmpDir, "{}")
    const result = await ensureToolsDisabled(tmpDir, [])
    expect(result).toBe(false)
  })
})

describe("ensureSubagentsCreated", () => {
  it("creates subagent entries for unassigned MCPs", async () => {
    makeConfig(tmpDir, "{}")
    const mcps = [{ name: "github", description: "GitHub API" }]
    const count = await ensureSubagentsCreated(tmpDir, mcps, [])
    expect(count).toBe(1)

    const raw = readFileSync(join(tmpDir, ".opencode", "opencode.jsonc"), "utf-8")
    expect(raw).toContain('"github"')
    expect(raw).toContain('"description": "GitHub API"')
    expect(raw).toContain('"mode": "subagent"')
    expect(raw).toContain('"github_*": true')
  })

  it("skips MCPs already covered by existing subagents", async () => {
    makeConfig(tmpDir, `{
  "agent": {
    "gh": { "mode": "subagent", "tools": { "github_*": true } }
  }
}`)
    const mcps = [{ name: "github", description: "GitHub API" }]
    const existing = [{ name: "gh", description: "", mcpServers: ["github"] }]
    const count = await ensureSubagentsCreated(tmpDir, mcps, existing)
    expect(count).toBe(0)
  })

  it("skips MCPs previously auto-created and removed", async () => {
    makeConfig(tmpDir, "{}")
    const mcps = [{ name: "github", description: "GitHub API" }]
    const count1 = await ensureSubagentsCreated(tmpDir, mcps, [])
    expect(count1).toBe(1)

    const count2 = await ensureSubagentsCreated(tmpDir, mcps, [])
    expect(count2).toBe(0)
  })

  it("returns 0 when no MCP servers provided", async () => {
    makeConfig(tmpDir, "{}")
    const count = await ensureSubagentsCreated(tmpDir, [], [])
    expect(count).toBe(0)
  })
})

describe("removeToolsDisable", () => {
  it("removes disable entries from tools block", async () => {
    makeConfig(tmpDir, `{
  "tools": {
    "github_*": false,
    "supabase_*": false
  }
}`)
    const result = await removeToolsDisable(tmpDir, ["github"])
    expect(result).toBe(true)
    const raw = readFileSync(join(tmpDir, ".opencode", "opencode.jsonc"), "utf-8")
    expect(raw).not.toContain('"github_*"')
    expect(raw).toContain('"supabase_*"')
  })

  it("removes entire tools block when last entry removed", async () => {
    makeConfig(tmpDir, `{
  "tools": {
    "github_*": false
  }
}`)
    const result = await removeToolsDisable(tmpDir, ["github"])
    expect(result).toBe(true)
    const raw = readFileSync(join(tmpDir, ".opencode", "opencode.jsonc"), "utf-8")
    expect(raw).not.toContain("tools")
  })

  it("returns false when no entries exist", async () => {
    makeConfig(tmpDir, "{}")
    const result = await removeToolsDisable(tmpDir, ["github"])
    expect(result).toBe(false)
  })

  it("returns false when mcpNames is empty", async () => {
    makeConfig(tmpDir, "{}")
    const result = await removeToolsDisable(tmpDir, [])
    expect(result).toBe(false)
  })

  it("preserves non-MCP tool entries (data-loss regression)", async () => {
    makeConfig(tmpDir, `{
  "tools": {
    "github_*": false,
    "bash": true,
    "read": true
  }
}`)
    const result = await removeToolsDisable(tmpDir, ["github"])
    expect(result).toBe(true)
    const raw = readFileSync(join(tmpDir, ".opencode", "opencode.jsonc"), "utf-8")
    expect(raw).not.toContain('"github_*"')
    expect(raw).toContain('"bash": true')
    expect(raw).toContain('"read": true')
    expect(raw).toContain("tools")
  })

  it("removes first entry in block (no leading comma)", async () => {
    makeConfig(tmpDir, `{
  "tools": {
    "github_*": false,
    "supabase_*": false
  }
}`)
    const result = await removeToolsDisable(tmpDir, ["github"])
    expect(result).toBe(true)
    const raw = readFileSync(join(tmpDir, ".opencode", "opencode.jsonc"), "utf-8")
    expect(raw).not.toContain('"github_*"')
    expect(raw).toContain('"supabase_*"')
    // Verify still valid JSON
    expect(() => JSON.parse(raw)).not.toThrow()
  })

  it("removes multiple entries in one pass", async () => {
    makeConfig(tmpDir, `{
  "tools": {
    "github_*": false,
    "supabase_*": false,
    "render_*": false
  }
}`)
    const result = await removeToolsDisable(tmpDir, ["github", "render"])
    expect(result).toBe(true)
    const raw = readFileSync(join(tmpDir, ".opencode", "opencode.jsonc"), "utf-8")
    expect(raw).not.toContain('"github_*"')
    expect(raw).not.toContain('"render_*"')
    expect(raw).toContain('"supabase_*"')
  })
})

describe("triage toggle (lock)", () => {
  it("defaults to enabled when no lock file exists", async () => {
    const enabled = await isTriageEnabled(tmpDir)
    expect(enabled).toBe(true)
  })

  it("toggleTriage writes enabled state to lock", async () => {
    await toggleTriage(tmpDir, false)
    const enabled = await isTriageEnabled(tmpDir)
    expect(enabled).toBe(false)
  })

  it("toggleTriage can re-enable", async () => {
    await toggleTriage(tmpDir, false)
    expect(await isTriageEnabled(tmpDir)).toBe(false)
    await toggleTriage(tmpDir, true)
    expect(await isTriageEnabled(tmpDir)).toBe(true)
  })

  it("lock file contains enabled field after toggle", async () => {
    await toggleTriage(tmpDir, false)
    const lock = await readLock(tmpDir)
    expect(lock?.enabled).toBe(false)
  })
})

describe("removeAutoSubagents", () => {
  it("removes specified subagent entries", async () => {
    makeConfig(tmpDir, `{
  "agent": {
    "github": { "mode": "subagent", "tools": { "github_*": true } },
    "supabase": { "mode": "subagent", "tools": { "supabase_*": true } },
    "user-agent": { "mode": "subagent", "tools": { "read": true } }
  }
}`)
    const removed = await removeAutoSubagents(tmpDir, ["github", "supabase"])
    expect(removed).toBe(2)
    const raw = readFileSync(join(tmpDir, ".opencode", "opencode.jsonc"), "utf-8")
    expect(raw).not.toContain('"github"')
    expect(raw).not.toContain('"supabase"')
    expect(raw).toContain('"user-agent"')
  })

  it("preserves user-written subagents", async () => {
    makeConfig(tmpDir, `{
  "agent": {
    "auto-github": { "mode": "subagent", "tools": { "github_*": true } },
    "my-custom-agent": { "mode": "subagent", "tools": { "read": true } }
  }
}`)
    const removed = await removeAutoSubagents(tmpDir, ["auto-github"])
    expect(removed).toBe(1)
    const raw = readFileSync(join(tmpDir, ".opencode", "opencode.jsonc"), "utf-8")
    expect(raw).toContain('"my-custom-agent"')
    expect(raw).not.toContain('"auto-github"')
  })

  it("returns 0 when no agent block exists", async () => {
    makeConfig(tmpDir, "{}")
    const removed = await removeAutoSubagents(tmpDir, ["github"])
    expect(removed).toBe(0)
  })

  it("returns 0 when names array is empty", async () => {
    makeConfig(tmpDir, `{
  "agent": {
    "github": { "mode": "subagent", "tools": { "github_*": true } }
  }
}`)
    const removed = await removeAutoSubagents(tmpDir, [])
    expect(removed).toBe(0)
  })

  it("deletes the agent block when it becomes empty", async () => {
    makeConfig(tmpDir, `{
  "agent": {
    "github": { "mode": "subagent", "tools": { "github_*": true } }
  }
}`)
    const removed = await removeAutoSubagents(tmpDir, ["github"])
    expect(removed).toBe(1)
    const raw = readFileSync(join(tmpDir, ".opencode", "opencode.jsonc"), "utf-8")
    expect(raw).not.toContain("agent")
  })

  it("handles nested braces inside subagent entries", async () => {
    makeConfig(tmpDir, `{
  "agent": {
    "complex": {
      "mode": "subagent",
      "description": "has { brace } and stuff",
      "tools": { "x_*": true }
    },
    "other": { "mode": "subagent", "tools": { "y_*": true } }
  }
}`)
    const removed = await removeAutoSubagents(tmpDir, ["complex"])
    expect(removed).toBe(1)
    const raw = readFileSync(join(tmpDir, ".opencode", "opencode.jsonc"), "utf-8")
    expect(raw).not.toContain('"complex"')
    expect(raw).toContain('"other"')
  })
})

describe("removePluginEntry", () => {
  it("removes plugin by package name", async () => {
    makeConfig(tmpDir, `{
  "plugin": ["opencode-mcp-triage", "other-plugin"]
}`)
    const removed = await removePluginEntry(tmpDir)
    expect(removed).toBe(true)
    const raw = readFileSync(join(tmpDir, ".opencode", "opencode.jsonc"), "utf-8")
    expect(raw).not.toContain("opencode-mcp-triage")
    expect(raw).toContain("other-plugin")
  })

  it("removes plugin by file: path", async () => {
    makeConfig(tmpDir, `{
  "plugin": ["file:/some/path/opencode-mcp-triage", "other"]
}`)
    const removed = await removePluginEntry(tmpDir)
    expect(removed).toBe(true)
    const raw = readFileSync(join(tmpDir, ".opencode", "opencode.jsonc"), "utf-8")
    expect(raw).not.toContain("opencode-mcp-triage")
    expect(raw).toContain("other")
  })

  it("returns false when plugin not in array", async () => {
    makeConfig(tmpDir, `{
  "plugin": ["other-plugin"]
}`)
    const removed = await removePluginEntry(tmpDir)
    expect(removed).toBe(false)
  })

  it("returns false when no plugin array exists", async () => {
    makeConfig(tmpDir, "{}")
    const removed = await removePluginEntry(tmpDir)
    expect(removed).toBe(false)
  })

  it("returns false when no config file exists", async () => {
    const removed = await removePluginEntry(tmpDir)
    expect(removed).toBe(false)
  })
})
