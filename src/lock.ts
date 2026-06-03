import { readFile, stat, rename } from "node:fs/promises"
import { join } from "node:path"
import { safeWriteFile } from "./utils.js"

const LOCK_FILENAME = "mcp-triage.json"

/** Max lock file size: 64KB — prevents memory exhaustion */
const MAX_LOCK_SIZE = 64 * 1024

export interface LockFile {
  version: 1
  /** MCP server names that triage auto-created subagents for. User-deleted entries stay here so triage won't re-create. */
  autoCreated: string[]
  /** false = triage disabled (MCP tools visible in main session) */
  enabled?: boolean
}

export async function readLock(directory: string): Promise<LockFile | null> {
  const path = join(directory, ".opencode", LOCK_FILENAME)
  try {
    const stats = await stat(path)
    if (stats.size > MAX_LOCK_SIZE) return null
    const raw = await readFile(path, "utf-8")
    return JSON.parse(raw) as LockFile
  } catch {
    return null
  }
}

/** Returns true if triage is enabled. Defaults to true (backward compat). */
export async function isTriageEnabled(directory: string): Promise<boolean> {
  const lock = await readLock(directory)
  if (lock === null) return true
  return lock.enabled !== false
}

export async function toggleTriage(
  directory: string,
  enabled: boolean
): Promise<boolean> {
  const lock = (await readLock(directory)) ?? {
    version: 1 as const,
    autoCreated: [],
  }
  lock.enabled = enabled
  await writeLock(directory, lock)
  return enabled
}

export async function writeLock(
  directory: string,
  lock: LockFile
): Promise<void> {
  const path = join(directory, ".opencode", LOCK_FILENAME)

  // Atomic write: write to temp file then rename
  const tmpPath = path + ".tmp"
  await safeWriteFile(tmpPath, JSON.stringify(lock, null, 2) + "\n")
  try {
    await rename(tmpPath, path)
  } catch {
    // Rename failed (cross-device) — fallback to direct write
    await safeWriteFile(path, JSON.stringify(lock, null, 2) + "\n")
  }
}
