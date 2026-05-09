# Changelog

All notable changes to the Azure AI Agent extension are documented here.

## 1.1.4 — 2026-05-09

### Changed
- Release metadata bump for the refreshed premium chat and settings experience.
- Kept Marketplace-facing documentation aligned with the latest guided onboarding and setup flow.
- Verified release packaging for a clean publish-ready build.

## 1.1.3 — 2026-05-09

### Changed
- Shortened the Marketplace description for readability and end-user focus.
- Updated repository, homepage, and issue tracker links to the current GitHub repository.
- Refreshed the settings and chat UI with a more modern, premium, beginner-friendly experience.
- Simplified onboarding with guided setup, quick actions, clearer labels, and advanced options hidden by default.

## 1.1.2 — 2026-05-09

### Changed
- Production release hardening and metadata cleanup.
- Removed workspace-local settings from the release workflow.
- Cleaned configuration text to avoid personal path examples.
- Added a Windows path-with-spaces guard for local extension-host test runs.

## 1.1.1 — 2026-05-06

### Changed
- Marketplace republish with refreshed README and changelog metadata.
- Documentation updated to reflect current MCP support, settings UI, diagnostics, and run-history features.
- Repository moved to the new GitHub home for this extension.

## 1.1.0 — 2026-05-05

Major feature release.

### Added
- Streaming responses (token-by-token) via SSE.
- Multimodal input: paste / drag-drop / pick image files; sent as `image_url` parts.
- `apply_patch` tool — atomic multi-file edits via either a structured `edits[]` array or a unified diff string.
- Diff-preview approval: `write_file`, `edit_file`, and `apply_patch` open VS Code's built-in diff editor before writing.
- Workspace instructions auto-loader — loads `AGENTS.md`, `CLAUDE.md`, or `.azure-ai-agent/instructions.md` into the system prompt.
- Token-usage tracking with status-bar display and `/usage` slash command.
- Per-workspace chat history persistence.
- Run history viewer with replay support.
- `@mention` file completion in the chat input.
- Slash commands: `/help`, `/clear`, `/cancel`, `/usage`, `/settings`, `/key`, `/setup`, `/searchkey`, `/mcp`.
- VS Code SecretStorage for Azure and web-search API keys.
- Three approval modes: `auto`, `destructive` (default), `always`.
- MCP support:
  - stdio server configuration
  - server launch and refresh
  - tool discovery
  - MCP tool invocation
  - MCP-specific approval mode
  - MCP status and discovered-tool commands
- Guided settings UI with:
  - onboarding health checks
  - connection diagnostics
  - deployment discovery suggestions
  - presets
  - profile import/export
  - MCP configuration editing
  - compact mode persistence
- Web browsing and search tools.
- Memory tools and sub-agent support.
- Smoke tests via `@vscode/test-electron`.

### Changed
- Built-in custom Markdown renderer in the webview (no `marked` runtime dependency).
- Single-`tsc` build; zero runtime dependencies.
- Improved chat UX with grouped live tool logs and categorized tool display.
- Improved run history UX with a dedicated panel.

## 1.0.0
- Initial release: agent loop with `read_file`, `write_file`, `edit_file`, `delete_file`, `list_directory`, `glob_files`, `search_text`, `run_command`, `get_diagnostics`, `get_workspace_info`.
