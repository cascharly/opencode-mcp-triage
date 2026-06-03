# Changelog

## 0.9.0 (unreleased)

### Code review fixes (branch `0.9.0-review-3`)

- **Fixed phantom glob in subagent detection** — `"github*": true` (bare `*`) is no longer treated as covering the `github` MCP. Requires exact `_*` suffix matching opencode's glob semantics. Subagents with wrong glob patterns were running with zero tools.
- **Fixed data loss in `removeToolsDisable`** — non-MCP tool entries (e.g. `"bash": true`) are preserved when MCP entries are removed. Only the `"tools"` block itself is deleted when it becomes truly empty. First-entry-in-block edge case handled.
- **Dropped `tool.execute.after` hint hook** — was injecting `[Hint] ...` strings into every tool result with high false-positive rate (matched on `rg`/`grep`/`ERR!`). Removed entirely.
- **Removed cached token auto-injection from `measure`** — was reading `~/.mcp-auth` access tokens and sending them as Bearer to any URL in config. mcp-remote commands now spawn like any other local server and handle their own auth.
- **Unified JSONC parser** — `writer.ts` and `config.ts` now share one string-aware `stripJsonc` in `utils.ts`. The old `stripJsonComments` regex broke on `/*` inside quoted strings.
- **`removeToolsDisable` rewritten to use `findMatchingBrace`** — scoped to the `"tools"` block boundaries instead of blind regex on the whole file. Handles first entry, dangling commas, non-MCP entries.
- **Toggle-off re-fetches `mcpServers`** — was using stale cache, leaving disable entries for MCPs added since last reload.
- **`isPluginActive` match anchored** — was substring-matching `opencode-mcp-triage`, causing false positives on unrelated file paths.
- **`sanitize` preserves unicode** — only strips `"\\\n\r\t\0`; keeps hyphens, dots, slashes, accented chars.
- **`mcp.name` escaped** in writer output — defends against MCP names with quotes/backslashes (rare but possible).
- **`protocolVersion` configurable** via `MCP_PROTOCOL_VERSION` env var (was hardcoded twice).
- **`autoCreated: Record<string, string>` → `string[]`** — value was always equal to the key (dead data).
- **Dropped hardcoded `netlify-mcp` shorthand** — was a dev-only convenience biasing the published binary.
- **Tool description tightened** — `triage_mcp` description shortened to save tokens every turn.
- **`mergeConfigSection` helper** in `utils.ts` — dedups the 3 inline `...global, ...project` merges in the CLI.
- **Sync fs imports removed** — `readFileSync`/`readdirSync` were only used by the deleted token cache code.

### New feature: `triage uninstall` (branch `0.9.0-review-3`)

- New CLI command `npx opencode-mcp-triage uninstall` (or `/mcp-triage uninstall`)
- Removes `"opencode-mcp-triage"` from the `"plugin"` array
- Removes all `"servername_*": false` entries from `"tools"` (non-MCP entries preserved)
- Removes subagents that triage auto-created (tracked in lock file). **User-written subagents are never touched.**
- Deletes the lock file at `.opencode/mcp-triage.json`
- Always shows a preview of what will change and asks for confirmation
- `--yes` / `-y` flag to skip the confirmation prompt for non-interactive use
- Aborts safely when stdin is not a TTY (no accidental confirm in pipes)
- Reports each step's outcome with meaningful ✓/!/○ markers
- Prints a final summary + next-step hints (restart OpenCode, etc.)
- "Your MCP servers in the `mcp` block are untouched" reminder

### Tests
- 89 → 120 tests
- New: `findMatchingBrace` (brackets + braces), `mergeConfigSection`, phantom glob regression, `removeAutoSubagents` (preservation, nested braces, empty-block), `removePluginEntry` (name + file: path + missing + not-present cases), `removeToolsDisable` data-loss regression, first-entry edge, multi-entry removal.

## 0.8.0 (2026-05-19)

- CLI rewrite with status, list, measure, enable, disable commands
- Soft `enable` / `disable` toggle (no full uninstall path)
- Priority hooks, security fixes

## 0.7.0 (2026-05-14)

- Auto-create subagents for unassigned MCP servers on init and reload
- Lock file tracking for auto-created subagents — user deletions are respected
- Config reload without restarting (`triage_mcp query: "reload"`)
- Lock file tests for read/write, oversized files, invalid JSON

## 0.6.0 (2026-05-13)

- Initial release
- Keyword-based triage engine for routing MCP queries to subagents
- Automatic MCP tool disable in main session (token savings)
- `triage_mcp` tool for query routing
- `mcp_stats` tool for status and coverage display
- `/mcp-triage` slash command
- Global + project config merging with project override
- JSONC-compatible config reader with comment stripping
- Idempotent config writer preserves comments and formatting
