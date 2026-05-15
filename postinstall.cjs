#!/usr/bin/env node
/*
 * postinstall — registers the /mcp-triage slash command
 * into the user's OpenCode commands directory.
 *
 * Set POSTINSTALL_QUIET=1 to suppress output.
 */
const { existsSync, mkdirSync, copyFileSync } = require("node:fs")
const { join, dirname } = require("node:path")
const { homedir } = require("node:os")

const quiet = process.env.POSTINSTALL_QUIET === "1"

const commandDir = join(homedir(), ".config", "opencode", "commands")
const source = join(__dirname, ".opencode", "commands", "mcp-triage.md")
const target = join(commandDir, "mcp-triage.md")

if (!existsSync(commandDir)) {
  mkdirSync(commandDir, { recursive: true })
}

if (existsSync(source)) {
  copyFileSync(source, target)
  if (!quiet) console.log("[opencode-mcp-triage] /mcp-triage command registered")
} else {
  if (!quiet) console.log("[opencode-mcp-triage] Command file not found, skipping")
}
