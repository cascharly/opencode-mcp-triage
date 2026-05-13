#!/usr/bin/env node
/*
 * postinstall — registers the /mcp-triage slash command
 * into the user's OpenCode commands directory.
 */
const { existsSync, mkdirSync, copyFileSync } = require("node:fs")
const { join, dirname } = require("node:path")
const { homedir } = require("node:os")

const commandDir = join(homedir(), ".config", "opencode", "commands")
const source = join(__dirname, ".opencode", "commands", "mcp-triage.md")
const target = join(commandDir, "mcp-triage.md")

if (!existsSync(commandDir)) {
  mkdirSync(commandDir, { recursive: true })
}

if (existsSync(source)) {
  copyFileSync(source, target)
  console.log("[opencode-mcp-triage] /mcp-triage command registered")
} else {
  console.log("[opencode-mcp-triage] Command file not found, skipping")
}
