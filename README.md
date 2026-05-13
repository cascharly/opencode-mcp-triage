# opencode-mcp-triage

On-demand MCP tool activation for OpenCode. Saves ~80% of MCP-related tokens by keeping MCP tools disabled in the main session and routing them to scoped subagents only when needed.

## How the Triage Engine Works

The scoring engine is pure text matching — no LLM calls, no vector embeddings:

1. Split user query into words (min 3 chars, stripped of punctuation)
2. For each subagent, score across three dimensions:
   - **Name match** (×3): subagent name matches query words at word boundaries
   - **Description match** (×1): description text matches query words
   - **MCP server match** (×3): assigned MCP server names match query words
3. If the top score exceeds the runner-up by ≥30 points, auto-route
4. Otherwise show top 5 options for the user to choose

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

Slash command registered on install. Run `mcp-triage <query>` from the OpenCode CLI.

## Installation

### Global (all projects)

Add to `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "plugin": ["opencode-mcp-triage"]
}
```

### Per-project

Add to `.opencode/opencode.jsonc` or project-root `opencode.jsonc`:

```jsonc
{
  "plugin": ["opencode-mcp-triage"]
}
```

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

### Remove the plugin

Delete `opencode-mcp-triage` from the `plugin` array in your `opencode.jsonc`.

### Clean up tool disables

Remove the auto-generated `"servername_*": false` entries from the `"tools"` block in your config to restore full MCP tool access in the main session.

### Remove slash command

```bash
rm ~/.config/opencode/commands/mcp-triage.md
```

## Token Savings

| Component | Without plugin | With plugin |
|-----------|---------------|-------------|
| MCP tools in main session | ~full descriptions | 0 tokens (disabled) |
| Subagent sessions | N/A | only scoped server tools |
| Estimated savings | — | ~80% of MCP tokens |

## License

MIT

## Author

Carlos Spagnoletti
