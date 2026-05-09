# Azure AI Agent for VS Code

Azure AI Agent is a coding assistant for Visual Studio Code powered by your **Azure AI Foundry / Azure OpenAI deployment**.

It can inspect and edit files, run commands, browse the web, use MCP tools, accept image input, and stream responses live inside VS Code.

## Features

- Agentic coding with workspace-aware tool calling
- File editing with optional diff-preview approval
- Command execution for builds, tests, and tasks
- Streaming responses in chat
- Image input via paste, drag-and-drop, or file picker
- Workspace instructions from `.azure-ai-agent/instructions.md`, `AGENTS.md`, or `CLAUDE.md`
- Run history with replay support
- Token usage and cost tracking
- `@mention` file references in chat
- Web search and fetch tools
- MCP server support with dynamic tool discovery
- Secure key storage with VS Code SecretStorage
- Guided Settings UI with setup, diagnostics, and MCP configuration

## Quick Start

1. Install **Azure AI Agent**.
2. Open **Azure AI: Open Settings UI**.
3. Configure your:
   - Azure endpoint
   - deployment name
   - API version
   - API key
4. Open chat with **Ctrl+Shift+A**.

## Common Commands

- **Azure AI: Open Agent Chat** — open the chat view
- **Azure AI: Guided Setup** — run the setup flow
- **Azure AI: Open Settings UI** — open the guided settings experience
- **Azure AI: Ask Agent About Selection** — prompt about the current selection
- **Azure AI: Explain Selected Code** — explain selected code
- **Azure AI: Fix Selected Code** — improve or fix selected code
- **Azure AI: Generate Code From Description** — one-shot code generation
- **Azure AI: Show Token Usage** — show cumulative session token usage
- **Azure AI: Open Run History (Replay)** — replay a previous run
- **Azure AI: MCP Setup / Status** — inspect MCP status
- **Azure AI: Refresh MCP Servers** — refresh MCP servers and rediscover tools
- **Azure AI: Show Discovered MCP Tools** — list discovered MCP tools

## Settings Highlights

- `azure-ai-agent.endpoint`
- `azure-ai-agent.deployment`
- `azure-ai-agent.apiVersion`
- `azure-ai-agent.approvalMode`
- `azure-ai-agent.mcp.approvalMode`
- `azure-ai-agent.diffPreview`
- `azure-ai-agent.streamResponses`
- `azure-ai-agent.maxIterations`
- `azure-ai-agent.instructionsFiles`
- `azure-ai-agent.webBrowsing.*`
- `azure-ai-agent.webSearch.*`
- `azure-ai-agent.safety.*`
- `azure-ai-agent.ui.compactMode`
- `azure-ai-agent.mcp.servers`

## Repository

GitHub: https://github.com/crjtech3-spec/Azure-Agent

## Issues and Feedback

https://github.com/crjtech3-spec/Azure-Agent/issues
