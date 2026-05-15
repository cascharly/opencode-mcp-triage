import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, existsSync } from "node:fs"
import { readFile, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { readLock, writeLock } from "../src/lock.js"

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "lock-test-"))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe("writeLock / readLock", () => {
  it("writes and reads back a lock file", async () => {
    const lock = { version: 1 as const, autoCreated: { github: "github", render: "render" } }
    await writeLock(tmpDir, lock)
    const result = await readLock(tmpDir)
    expect(result).toEqual(lock)
  })

  it("creates parent directories automatically", async () => {
    const lock = { version: 1 as const, autoCreated: { github: "github" } }
    await writeLock(tmpDir, lock)
    expect(existsSync(join(tmpDir, ".opencode", "mcp-triage.json"))).toBe(true)
  })

  it("returns null when no lock file exists", async () => {
    const result = await readLock(tmpDir)
    expect(result).toBeNull()
  })

  it("overwrites existing lock file on write", async () => {
    await writeLock(tmpDir, { version: 1 as const, autoCreated: { a: "a" } })
    await writeLock(tmpDir, { version: 1 as const, autoCreated: { b: "b" } })
    const result = await readLock(tmpDir)
    expect(result?.autoCreated).toEqual({ b: "b" })
  })

  it("handles empty autoCreated object", async () => {
    const lock = { version: 1 as const, autoCreated: {} }
    await writeLock(tmpDir, lock)
    const result = await readLock(tmpDir)
    expect(result).toEqual(lock)
  })

  it("returns null for oversized lock file", async () => {
    const dir = join(tmpDir, ".opencode")
    await mkdir(dir, { recursive: true })
    const path = join(dir, "mcp-triage.json")
    await writeFile(path, "x".repeat(64 * 1024 + 1), "utf-8")
    const result = await readLock(tmpDir)
    expect(result).toBeNull()
  })

  it("returns null for invalid JSON in lock file", async () => {
    const dir = join(tmpDir, ".opencode")
    await mkdir(dir, { recursive: true })
    const path = join(dir, "mcp-triage.json")
    await writeFile(path, "not-json", "utf-8")
    const result = await readLock(tmpDir)
    expect(result).toBeNull()
  })

  it("returns null for empty lock file", async () => {
    const dir = join(tmpDir, ".opencode")
    await mkdir(dir, { recursive: true })
    const path = join(dir, "mcp-triage.json")
    await writeFile(path, "", "utf-8")
    const result = await readLock(tmpDir)
    expect(result).toBeNull()
  })
})
