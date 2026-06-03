# opencode-mcp-triage

> opencode-mcp-triage strips MCP tool definitions from the main prompt and routes them to dedicated subagents. Instead of loading every server's tools into every message, it uses keyword matching to activate only what you need. Cuts prompt token costs by eliminating MCP tool bloat — no LLM overhead, no extra API calls, zero setup.

## What It Does

Normally all MCP servers load their tools into the system prompt and burn tokens on every message — even when irrelevant. Triage disables all MCP tools globally and routes work to scoped subagents that carry only the tools they need.

```
Without triage:   [supabase tools] [github tools] [render tools] ...  ← always burning tokens
With triage:      triage_mcp({ query }) → @github → github tools only
```

By default, each subagent carries one MCP server's tools. The main session carries zero. Token savings are **static per MCP server** — the same for every user with the same servers installed.

This plugin is OpenCode-only — it has no effect on Claude Desktop, Cursor, Windsurf, or any other tool using the same MCP config. Your MCP servers remain fully functional everywhere else.

## Token Savings

Real data from this project's 6 MCP servers (measured with `opencode-mcp-triage measure`):

```
  TOKENS SAVED PER TURN (by routing MCPs to subagents)

  supabase      29 tools    19255 chars  ~ 4814 tokens
  netlify        9 tools    12322 chars  ~ 3081 tokens
  render        24 tools    28244 chars  ~ 7061 tokens
  clickup       51 tools   121319 chars  ~30330 tokens
  context7       2 tools     4605 chars  ~ 1151 tokens
  github        26 tools    15827 chars  ~ 3957 tokens
  ----------------------------------------------------
  TOTAL        141 tools   201572 chars  ~ 50394 tokens

  Each user turn saves ~50.394 tokens
  that would otherwise be sent with every prompt.
```

Tool definitions are static per MCP server — same savings for every user with the same servers installed. Run `opencode-mcp-triage measure` for live numbers based on your MCP inventory.

## How It Works

The LLM calls `triage_mcp()` when it encounters a task that needs MCP tools. The plugin scores all subagents against the query using keyword matching and returns the best match.

```
User: "manage GitHub issues"
  │
  ▼
LLM: triage_mcp({ query: "manage GitHub issues" })
  │
  ▼
Plugin: scores subagents → returns best match
  @github         score=75  (matched: github ×3, issues in description ×1)
  @clickup        score=0
  gap=75 ≥ threshold(30) → HIGH CONFIDENCE
  │
  ▼
LLM: invokes @github subagent → carries only github tools
```

No LLM reasoning overhead. No extra API calls. Just fast deterministic matching.

### Scoring Engine

- **Subagent name** matches: weight ×3
- **MCP server name** matches: weight ×3
- **Description** matches: weight ×1

Clear winner (gap ≥ 30): auto-routes. Too close: shows top 5 options. No matches: lists all available subagents.

## Quick Start

```bash
npm install -g opencode-mcp-triage
```

Restart OpenCode. The plugin auto-disables all MCP tools and auto-creates one subagent per MCP server. No manual config needed. Type `/mcp-triage status` to verify.

## Install

### Global (recommended)

```bash
npm install -g opencode-mcp-triage
```

Restart OpenCode. `/mcp-triage` is available in **every** project.

### Per-project

```bash
npm install opencode-mcp-triage
```

Restart OpenCode. `/mcp-triage` is available only in this project.

### Dev / local

```bash
git clone https://github.com/cascharly/opencode-mcp-triage.git
cd opencode-mcp-triage
npm install
```

Add to your opencode config:

```jsonc
{ "plugin": ["file:/path/to/opencode-mcp-triage"] }
```

## LLM Quick-Install

Copy-paste this into any LLM:

```text
Install opencode-mcp-triage (https://github.com/cascharly/opencode-mcp-triage) — a deterministic MCP subagent router for OpenCode.

1. Run: npm install -g opencode-mcp-triage
2. If any errors occur, visit the repo link above and resolve them.
3. Tell me to restart OpenCode.
```

## Configuration

The plugin handles everything automatically — no manual editing required. This section shows what gets generated and how to customize it if needed.

### Auto-generated config

On first run, the plugin writes tool disable entries and auto-creates one subagent per MCP server:

```jsonc
{
  "tools": {
    "github_*": false,
    "render_*": false
  },
  "agent": {
    "github": {
      "description": "GitHub issue/PR management",
      "mode": "subagent",
      "tools": { "github_*": true }
    }
  }
}
```

## Commands

### Plugin Tools

| Tool | What it does |
|---|---|
| `triage_mcp` | Route a task to the right MCP subagent using keyword matching |
| `mcp_stats` | Show routing status, subagent-to-server map, and coverage |

### CLI Commands (available in terminal AND as `/mcp-triage <command>`)

| Command | What it does |
|---|---|
| `status` | Show MCP server status, hidden/exposed tools, subagent routing |
| `list` | List all configured MCP servers and subagents |
| `measure` | Connect to each MCP server and measure token savings per turn |
| `uninstall` | Remove plugin: disable entries, auto-created subagents, lock file (asks for confirm) |
| `help` | Show available commands |

### Flags

| Flag | Where | What it does |
|---|---|---|
| `--json` | All commands | Machine-readable JSON output |
| `--verbose` | `measure` | Show error diagnostics (HTTP codes, spawn errors, timeouts) |
| `--timeout=N` | `measure` | Per-server timeout in seconds (default: 60) |
| `--yes`, `-y` | `uninstall` | Skip the confirmation prompt |

All CLI commands can be run directly in your terminal via `npx opencode-mcp-triage <command>` (e.g., `npx opencode-mcp-triage measure --verbose`). No OpenCode session needed.

## Under the Hood

### Plugin Activation

`opencode-mcp-triage` is a standard opencode plugin registered in the `"plugin"` array of `opencode.jsonc` (both `~/.config/opencode/opencode.jsonc` globally and `.opencode/opencode.jsonc` per-project). On startup, opencode loads all listed plugins, making their tools and commands available. The plugin registers `triage_mcp` and `mcp_stats` in the system prompt alongside `read`, `write`, `bash`, etc.

### How Tool Disabling Works

The plugin writes `"servername_*": false` entries to the `"tools"` block of your project config. OpenCode uses glob patterns to match tools — `"github_*": false` disables all tools from the github MCP server in the main session.

```
Main session tools:
  github_*: false          ← disabled, 0 tokens
  supabase_*: false        ← disabled, 0 tokens
  render_*: false          ← disabled, 0 tokens

@github subagent tools:
  github_*: true           ← enabled, ~4K tokens in subagent sessions only
```

MCP tool definitions are never loaded in the main session — they stay isolated in subagent contexts.

### Auto-Created Subagents

On first run, the plugin creates one subagent per MCP server that doesn't already have one. The subagent name matches the server name, and its description comes from the server's `description` field.

**Behavior:**
- Already-covered MCP servers are skipped — existing user-defined subagents are never touched
- Deleting an auto-created subagent is respected — tracked via `.opencode/mcp-triage.json`
- Adding a new MCP server later auto-creates its subagent on reload (`triage_mcp query: "reload"`)
- Power users can delete auto-created entries and define grouped subagents if desired, though separate subagents save more tokens per query

### Config Caching

MCP server and subagent config reads are cached with a 5-second TTL. CLI toggles (add/remove MCP servers, change subagents) are picked up within 5 seconds without restarting OpenCode. Reload manually with `triage_mcp query: "reload"`.

## Uninstall

Run the CLI — it handles every cleanup step in one pass:

```bash
npx opencode-mcp-triage uninstall
```

It shows a preview (counts of plugin entries, MCP disable entries, auto-created subagents, lock file) and asks for confirmation before changing anything. Pass `--yes` to skip the prompt.

It will:

1. Remove `"opencode-mcp-triage"` from the `"plugin"` array
2. Remove all `"servername_*": false` entries from `"tools"` (non-MCP entries preserved)
3. Remove subagents that triage auto-created (tracked in the lock file). **User-written subagents are never touched.**
4. Delete the lock file at `.opencode/mcp-triage.json`

Your MCP server config (`"mcp"` block) is **never modified** — only the triage-specific entries.

To complete the uninstall, restart OpenCode and optionally delete the slash command file:

```bash
# macOS / Linux
rm ~/.config/opencode/commands/mcp-triage.md
```

```cmd
:: Windows (cmd)
del %USERPROFILE%\.config\opencode\commands\mcp-triage.md
```

To re-enable triage later without reinstalling: re-add the plugin to `"plugin"` and run `triage enable`.

## Compatibility

- OpenCode 1.14+
- Node.js 18+ (for CLI)
- TypeScript 6+ (for development)

## License

MIT

## Author

Carlos Spagnoletti
