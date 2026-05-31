import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { ensureToolsDisabled, ensureSubagentsCreated, removeToolsDisable } from "../src/writer.js"
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
