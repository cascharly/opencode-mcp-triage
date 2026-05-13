# Changelog

## 0.5.0 (2026-05-13)

- Initial release
- Keyword-based triage engine for routing MCP queries to subagents
- Automatic MCP tool disable in main session (token savings)
- `triage_mcp` tool for query routing
- `mcp_stats` tool for status and coverage display
- `/mcp-triage` slash command
- Global + project config merging with project override
- JSONC-compatible config reader with comment stripping
- Idempotent config writer preserves comments and formatting
- Config reload without restarting (`triage_mcp query: "reload"`)
