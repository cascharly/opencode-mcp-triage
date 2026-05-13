import { readFile, writeFile, mkdir } from "node:fs/promises"
import { join, dirname } from "node:path"

const LOCK_FILENAME = "mcp-triage.json"

export interface LockFile {
  version: 1
  autoCreated: Record<string, string>
}

export async function readLock(directory: string): Promise<LockFile | null> {
  const path = join(directory, ".opencode", LOCK_FILENAME)
  try {
    const raw = await readFile(path, "utf-8")
    return JSON.parse(raw) as LockFile
  } catch {
    return null
  }
}

export async function writeLock(
  directory: string,
  lock: LockFile
): Promise<void> {
  const path = join(directory, ".opencode", LOCK_FILENAME)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(lock, null, 2) + "\n", "utf-8")
}
