# Azure AI Agent for VS Code

An agentic coding assistant that runs against your **Azure AI Foundry / Azure OpenAI** deployment (for example `gpt-5.4`). It can inspect and modify your workspace, run commands, browse the web, use MCP tools, accept image input, and stream results live inside VS Code.

The extension builds with a single `tsc` run and ships as a small `.vsix` with no runtime dependencies.

## Features

- **Agent loop with tool calling**
  - Workspace tools: `read_file`, `write_file`, `edit_file`, `apply_patch`, `delete_file`, `list_directory`, `glob_files`, `search_text`, `find_symbols`, `get_diagnostics`, `get_workspace_info`, `get_definition`, `get_references`
  - Execution tools: `run_command`, `run_task`, `spawn_agent`
  - Web tools: `web_search`, `web_fetch`
  - Memory tools: `read_memory`, `write_memory`
  - MCP tools: discovered dynamically from configured MCP servers
- **Streaming responses** — assistant text streams token-by-token.
- **Diff-preview approval** — `write_file`, `edit_file`, and `apply_patch` can open VS Code's diff editor before changes are applied.
- **Multimodal input** — paste, drag-drop, or pick image files and send them with prompts.
- **Workspace instructions** — automatically loads `.azure-ai-agent/instructions.md`, `AGENTS.md`, or `CLAUDE.md` into the system prompt.
- **Run history** — stores previous runs per workspace and lets you replay them.
- **Token usage and cost tracking** — shown in the status bar and available via `/usage`.
- **`@mention` files** — fuzzy-search workspace files from the chat input.
- **Slash commands** — `/help`, `/clear`, `/cancel`, `/usage`, `/settings`, `/key`, `/setup`, `/searchkey`, `/mcp`.
- **SecretStorage for keys** — Azure API key and web-search API key can be stored securely in VS Code SecretStorage.
- **Approval controls** — global approval mode plus MCP-specific approval mode.
- **Compact mode** — denser chat layout that persists in workspace settings.
- **Modern settings UI** — guided setup, health checks, diagnostics, presets, profile import/export, MCP config editing.
- **MCP support**
  - Launch stdio MCP servers from settings
  - Discover MCP tools dynamically
  - Invoke MCP tools from the agent
  - Inspect MCP status and discovered tools from commands/UI

## Quick start

1. `npm install`
2. Press `F5` to launch an Extension Development Host, or run `npm run package` to build a `.vsix`.
3. In VS Code, open **Azure AI: Open Settings UI**.
4. Set:
   - Azure endpoint
   - deployment name
   - API version
   - Azure API key
5. Open chat with **Ctrl+Shift+A**.

## Commands

| Command | Description |
| ------- | ----------- |
| `Azure AI: Open Agent Chat` | Show the chat view |
| `Azure AI: Guided Setup` | Run setup flow |
| `Azure AI: Open Settings UI` | Open the guided settings webview |
| `Azure AI: Ask Agent About Selection` | Prompt about the current selection |
| `Azure AI: Explain Selected Code` | Explain selected code |
| `Azure AI: Fix Selected Code` | Ask the agent to improve/fix selected code |
| `Azure AI: Generate Code From Description` | One-shot generation prompt |
| `Azure AI: Set API Key (SecretStorage)` | Save or rotate the Azure API key |
| `Azure AI: Clear Stored API Key` | Remove the stored Azure API key |
| `Azure AI: Set Web Search API Key (SecretStorage)` | Save or rotate the web-search API key |
| `Azure AI: Clear Stored Web Search API Key` | Remove the stored web-search API key |
| `Azure AI: Attach Image to Next Message` | Pick image files to send |
| `Azure AI: Cancel Current Request` | Abort the running agent loop |
| `Azure AI: Show Token Usage` | Show cumulative session token usage |
| `Azure AI: Open Run History (Replay)` | Open run history and replay a prior run |
| `Azure AI: Clear Run History` | Clear stored run history |
| `Azure AI: MCP Setup / Status` | Show MCP status |
| `Azure AI: Refresh MCP Servers` | Restart/refresh MCP servers and tool discovery |
| `Azure AI: Show Discovered MCP Tools` | List discovered MCP tools |

## Settings highlights

- `azure-ai-agent.endpoint` — Azure OpenAI / AI Foundry endpoint URL
- `azure-ai-agent.deployment` — deployment name
- `azure-ai-agent.apiVersion` — REST API version
- `azure-ai-agent.approvalMode` — `auto` / `destructive` / `always`
- `azure-ai-agent.mcp.approvalMode` — MCP-specific approval mode
- `azure-ai-agent.diffPreview` — show diff editor before writes
- `azure-ai-agent.streamResponses` — token streaming
- `azure-ai-agent.maxIterations` — max tool-loop steps
- `azure-ai-agent.instructionsFiles` — files searched for workspace instructions
- `azure-ai-agent.webBrowsing.*` — browsing controls
- `azure-ai-agent.webSearch.*` — search provider and key
- `azure-ai-agent.safety.*` — secret scrubbing and command auto-approval patterns
- `azure-ai-agent.ui.compactMode` — compact chat layout
- `azure-ai-agent.mcp.servers` — configured MCP stdio servers

## MCP server configuration

Example:

```json
[
  {
    "id": "my-server",
    "command": "node",
    "args": ["./path/to/server.js"],
    "cwd": ".",
    "env": {
      "EXAMPLE_TOKEN": "value"
    },
    "enabled": true
  }
]
```

Configured MCP tools are exposed to the agent dynamically.

## Build & package

```sh
npm install
npm run compile
npm run package
npm test
```

This produces a `.vsix` such as:

```sh
azure-ai-agent-1.1.0.vsix
```

## Publishing to the VS Code Marketplace

Publisher: **CRJTECH**

One-time setup:

```sh
npm install -g @vscode/vsce
vsce login CRJTECH
```

Then publish:

```sh
npm run compile
vsce package
vsce publish
```

Or publish the built package directly:

```sh
vsce publish --packagePath azure-ai-agent-1.1.0.vsix
```

## Repository

Current remote:

- `https://github.com/crjtech3-spec/agent-vs.git`

If you want to publish this as a brand-new GitHub repository instead, create the new empty repo first, then update the remote and push.
