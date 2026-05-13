# opencode-mcp-triage

On-demand MCP tool activation for OpenCode. Saves ~80% of MCP-related tokens by keeping MCP tools disabled in the main session and routing them to scoped subagents only when needed.

## Why Use This Plugin

- **Save tokens** — MCP tools have large descriptions. Keeping them disabled in the main session saves ~80% of MCP-related token usage
- **No LLM overhead** — routing uses pure keyword matching, not embeddings or LLM calls
- **Zero config after install** — automatically disables MCP tools on first run, no manual setup
- **Smart routing** — weighted scoring across agent names, descriptions, and server names with confidence thresholds
- **Hot reload** — refresh MCP config without restarting OpenCode (`triage_mcp query: "reload"`)

## How It Works

1. **Plugin init** reads all MCP servers and subagents from `opencode.jsonc` config
2. **Disables** all MCP tools globally (`"servername_*": false`) so they don't consume tokens in the main agent
3. **Subagents** re-enable specific servers via tool scoping (`"servername_*": true`)
4. **`triage_mcp` tool** scores user queries against subagent names, descriptions, and MCP server names using pure keyword matching (no LLM overhead)
5. **Routes** to the best-matching subagent or shows options when unsure

The scoring engine uses word-boundary matching with weighted passes:
- Subagent name matches: weight ×3
- MCP server name matches: weight ×3
- Description matches: weight ×1

If the top score exceeds the runner-up by ≥30 points, it auto-routes. Otherwise it shows the top 5 options for you to choose.

## Installation

### Local development

```bash
git clone https://github.com/cascharly/opencode-mcp-triage.git
cd opencode-mcp-triage
npm install
```

Then add to your opencode config:

```jsonc
{
  "plugin": ["file:/path/to/opencode-mcp-triage"]
}
```

### Global (all projects)

Add to `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "plugin": ["file:/path/to/opencode-mcp-triage"]
}
```

### Per-project

Add to `.opencode/opencode.jsonc` or project-root `opencode.jsonc`:

```jsonc
{
  "plugin": ["file:/path/to/opencode-mcp-triage"]
}
```

## Commands

### `triage_mcp`

Routes a task description to the right subagent.

```
query: "manage github issues" → @github
query: "search library docs" → @context7
query: "" → list all subagents
query: "reload" → re-read config without restarting
```

### `mcp_stats`

Shows routing status, subagent-to-server mapping, unassigned servers, and token savings.

### `/mcp-triage`

Slash command registered on install. Run `/mcp-triage <query>` from the OpenCode CLI.

## Token Savings

| Component | Without plugin | With plugin |
|-----------|---------------|-------------|
| MCP tools in main session | ~full descriptions | 0 tokens (disabled) |
| Subagent sessions | N/A | only scoped server tools |
| Estimated savings | — | ~80% of MCP tokens |

## Configuration

### MCP servers

Define servers in `opencode.jsonc`:

```jsonc
{
  "mcp": {
    "github": {
      "type": "local",
      "command": ["npx", "-y", "@modelcontextprotocol/server-github"],
      "enabled": true,
      "environment": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..."
      }
    },
    "supabase": {
      "type": "remote",
      "url": "https://mcp.supabase.com/mcp",
      "enabled": true
    }
  }
}
```

### Subagents

Define subagents with tool scoping to route MCP servers:

```jsonc
{
  "agent": {
    "github": {
      "description": "GitHub issue/PR management",
      "mode": "subagent",
      "tools": {
        "github_*": true
      }
    },
    "supabase": {
      "description": "Supabase database management",
      "mode": "subagent",
      "tools": {
        "supabase_*": true
      }
    }
  }
}
```

### Tools block (auto-generated)

On first run, the plugin writes disable entries to your project config:

```jsonc
{
  "tools": {
    "github_*": false,
    "supabase_*": false
  }
}
```

This disables MCP tools in the main session. Subagents re-enable them.

## Uninstall

1. Remove `opencode-mcp-triage` from the `plugin` array in your `opencode.jsonc`
2. Remove the auto-generated `"servername_*": false` entries from the `"tools"` block to restore full MCP tool access
3. Remove the slash command:

```bash
rm ~/.config/opencode/commands/mcp-triage.md
```

## License

MIT

## Author

Carlos Spagnoletti
