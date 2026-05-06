// Extension entry point. Wires together:
// - Configuration (and SecretStorage) -> AzureOpenAIClient
// - Tool registry + AgentExecutor
// - Chat webview view
// - Commands, status bar, history persistence, instructions loader

import * as vscode from 'vscode';
import * as path from 'path';
import { AzureOpenAIClient, AzureClientConfig, ChatMessage, ContentPart, Usage } from './azureClient';
import { buildToolRegistry, ToolContext } from './tools';
import { AgentExecutor, AgentExecutorConfig, ApprovalMode, DEFAULT_SYSTEM_PROMPT } from './agentExecutor';
import { ChatViewProvider } from './chatView';
import { SettingsPanel } from './settingsView';
import { loadWorkspaceInstructions, composeSystemPrompt } from './instructions';
import { McpManager, McpServerConfig } from './mcp';

const EXT = 'azure-ai-agent';
const SECRET_KEY = 'azure-ai-agent.apiKey';
const SEARCH_SECRET_KEY = 'azure-ai-agent.webSearchApiKey';
const HISTORY_KEY_PREFIX = 'azure-ai-agent.history:';
const RUN_HISTORY_KEY_PREFIX = 'azure-ai-agent.runs:';
const RUN_HISTORY_MAX = 25;
const MCP_PLACEHOLDER_DOC = 'MCP phase 1 is implemented: configure stdio servers, start them, and discover/list tools. Tool invocation is not implemented yet.';

// Hosts the user has approved for the current session (cleared on activate).
const sessionAllowedHosts = new Set<string>();

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const output = vscode.window.createOutputChannel('Azure AI Agent');
    context.subscriptions.push(output);

    // ---------- Build initial config ----------
    const apiKey = await resolveApiKey(context);
    const searchKey = await resolveSearchApiKey(context);
    const cfg = readConfig();
    const client = new AzureOpenAIClient({ ...cfg.client, apiKey });

    const baseTools = buildToolRegistry();
    const mcp = new McpManager(output);
    await mcp.apply(readMcpServers());
    const tools = buildToolRegistryWithMcp(baseTools, mcp);
    const executor = new AgentExecutor(client, tools, {
        ...cfg.executor,
        toolContext: {
            ...cfg.toolContext,
            web: { ...cfg.toolContext.web, searchApiKey: searchKey, promptForHost },
            listMcpTools: () => mcp.listTools().map(t => ({ serverId: t.serverId, name: t.name, description: t.description })),
            mcpApprovalMode: vscode.workspace.getConfiguration(EXT).get<ApprovalMode>('mcp.approvalMode', 'destructive') as any
        },
        debugChannel: cfg.debug ? output : undefined
    });

    // ---------- Status bar ----------
    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBar.command = `${EXT}.startChat`;
    context.subscriptions.push(statusBar);
    let totalUsage: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let totalCostUsd = 0;
    function refreshStatusBar(busy = false): void {
        const ready = client.isReady();
        const icon = busy ? '$(sync~spin)' : ready ? '$(sparkle)' : '$(warning)';
        const tokens = totalUsage.total_tokens > 0 ? `  ${formatTokens(totalUsage.total_tokens)} tok` : '';
        const cost = totalCostUsd > 0 ? `  $${totalCostUsd.toFixed(totalCostUsd < 0.1 ? 4 : 2)}` : '';
        statusBar.text = `${icon} Azure AI${tokens}${cost}`;
        statusBar.tooltip = ready
            ? `Azure AI Agent — deployment: ${cfg.client.deployment}\nClick to open chat${cost ? `\nSession cost: $${totalCostUsd.toFixed(4)}` : ''}`
            : 'Azure AI Agent — not configured. Click to set up.';
        statusBar.show();
    }
    refreshStatusBar();

    // ---------- Chat view provider ----------
    const settingsPanel = new SettingsPanel(context, {
        getSnapshot: async () => {
            const c = readConfig();
            const endpoint = c.client.endpoint;
            const hasApiKey = !!(await resolveApiKey(context));
            const searchProvider = c.toolContext.web.searchProvider;
            const hasSearchKey = !!(await resolveSearchApiKey(context));
            const deploymentReachable = endpoint && hasApiKey ? (await testConnection({ endpoint, deployment: c.client.deployment, apiVersion: c.client.apiVersion })).ok : false;
            const deploymentSuggestions = await discoverDeployments(endpoint, await resolveApiKey(context), c.client.apiVersion);
            return {
                endpoint: c.client.endpoint,
                deployment: c.client.deployment,
                apiVersion: c.client.apiVersion,
                hasApiKey,
                webSearchProvider: searchProvider,
                hasWebSearchKey: hasSearchKey,
                approvalMode: c.executor.approvalMode,
                mcpApprovalMode: vscode.workspace.getConfiguration(EXT).get<ApprovalMode>('mcp.approvalMode', 'destructive'),
                webBrowsingEnabled: c.toolContext.web.enabled,
                scrubSecrets: c.toolContext.safety.scrubSecrets,
                compactMode: vscode.workspace.getConfiguration(EXT).get<boolean>('ui.compactMode', false),
                mcpServersJson: JSON.stringify(vscode.workspace.getConfiguration(EXT).get<any[]>('mcp.servers', []), null, 2),
                autoApproveCommandPatternsJson: JSON.stringify(c.toolContext.safety.autoApproveCommandPatterns ?? [], null, 2),
                diagnostics: buildConnectionDiagnostics(c, hasApiKey, hasSearchKey, deploymentSuggestions),
                health: {
                    endpointValid: /^https:\/\//i.test(endpoint),
                    keyPresent: hasApiKey,
                    deploymentReachable,
                    searchConfigured: searchProvider === 'duckduckgo' || hasSearchKey,
                    workspaceTrusted: vscode.workspace.isTrusted
                },
                deploymentSuggestions: deploymentSuggestions.length > 0 ? deploymentSuggestions : ['gpt-5.4', 'gpt-4.1', 'gpt-4o', 'o4-mini']
            };
        },
        save: async (payload) => {
            const cfgApi = vscode.workspace.getConfiguration(EXT);
            await cfgApi.update('endpoint', payload.endpoint.trim(), vscode.ConfigurationTarget.Workspace);
            await cfgApi.update('deployment', payload.deployment.trim(), vscode.ConfigurationTarget.Workspace);
            await cfgApi.update('apiVersion', payload.apiVersion.trim(), vscode.ConfigurationTarget.Workspace);
            await cfgApi.update('webSearch.provider', payload.webSearchProvider, vscode.ConfigurationTarget.Workspace);
            await cfgApi.update('approvalMode', payload.approvalMode, vscode.ConfigurationTarget.Workspace);
            await cfgApi.update('mcp.approvalMode', payload.mcpApprovalMode, vscode.ConfigurationTarget.Workspace);
            await cfgApi.update('webBrowsing.enabled', payload.webBrowsingEnabled, vscode.ConfigurationTarget.Workspace);
            await cfgApi.update('safety.scrubSecrets', payload.scrubSecrets, vscode.ConfigurationTarget.Workspace);
            await cfgApi.update('ui.compactMode', payload.compactMode, vscode.ConfigurationTarget.Workspace);
            if (payload.mcpServersJson) {
                await cfgApi.update('mcp.servers', JSON.parse(payload.mcpServersJson), vscode.ConfigurationTarget.Workspace);
            }
            if (payload.autoApproveCommandPatternsJson) {
                await cfgApi.update('safety.autoApproveCommandPatterns', JSON.parse(payload.autoApproveCommandPatternsJson), vscode.ConfigurationTarget.Workspace);
            }
            if (payload.apiKey?.trim()) await context.secrets.store(SECRET_KEY, payload.apiKey.trim());
            if (payload.webSearchKey?.trim()) await context.secrets.store(SEARCH_SECRET_KEY, payload.webSearchKey.trim());
            const k = await resolveApiKey(context);
            const sk = await resolveSearchApiKey(context);
            const c = readConfig();
            client.update({ ...c.client, apiKey: k });
            await mcp.apply(readMcpServers());
            executor.updateTools(buildToolRegistryWithMcp(baseTools, mcp));
            executor.updateConfig({
                ...c.executor,
                toolContext: { ...c.toolContext, web: { ...c.toolContext.web, searchApiKey: sk, promptForHost }, listMcpTools: () => mcp.listTools().map(t => ({ serverId: t.serverId, name: t.name, description: t.description })) },
                debugChannel: c.debug ? output : undefined
            });
            refreshStatusBar();
            return { ok: true, message: 'Settings saved.' };
        },
        testConnection: async (payload) => testConnection(payload),
        openMcpInfo: async () => { await vscode.commands.executeCommand(`${EXT}.openMcpSetup`); },
        copyCurl: async (payload) => copyCurl(payload),
        exportProfile: async () => exportProfile(),
        importProfile: async () => importProfile(),
        applyPreset: async (preset) => applyPreset(preset)
    });

    const provider = new ChatViewProvider(context, {
        onSendMessage: (text, images) => runAgent(text, images),
        onCancel: () => cancelCurrentRun(),
        onClear: () => clearHistory(),
        onOpenSettings: () => settingsPanel.show(),
        onAttachImage: () => attachImageFlow(),
        loadHistory: () => loadHistory(context),
        saveHistory: (msgs) => saveHistory(context, msgs),
        getWelcomeState: async () => ({ configured: client.isReady(), compactMode: vscode.workspace.getConfiguration(EXT).get<boolean>('ui.compactMode', false) }),
        setCompactMode: async (compact) => {
            await vscode.workspace.getConfiguration(EXT).update('ui.compactMode', compact, vscode.ConfigurationTarget.Workspace);
        }
    });

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('azure-ai-agent.chatView', provider, {
            webviewOptions: { retainContextWhenHidden: true }
        })
    );

    // ---------- Run state ----------
    let currentAbort: AbortController | undefined;
    let runBusy = false;

    async function runAgent(userText: string, images: string[] = []): Promise<void> {
        if (runBusy) {
            provider.postEvent({ kind: 'error', text: 'A request is already running. Cancel it first.' });
            return;
        }

        // Slash-command routing — these never go to the model.
        const trimmed = userText.trim();
        if (trimmed.startsWith('/')) {
            const handled = await handleSlash(trimmed);
            if (handled) return;
        }

        runBusy = true;
        currentAbort = new AbortController();
        refreshStatusBar(true);

        const prevHistory = await loadHistory(context);
        const userMessage = buildUserMessage(userText, images);
        provider.postEvent({ kind: 'iteration', iteration: 1 });

        const baseSystem = readConfig().systemPromptOverride || DEFAULT_SYSTEM_PROMPT;
        const instructions = await loadWorkspaceInstructions(readConfig().instructionsFiles);
        const systemPrompt = composeSystemPrompt(baseSystem, instructions);
        if (instructions) provider.postEvent({ kind: 'status', text: `Loaded workspace instructions from ${instructions.source}` });

        let runIters = 0;
        let runCost = 0;
        let runTokens = 0;
        try {
            const finalConvo = await executor.run({
                userMessage,
                history: prevHistory,
                systemPrompt,
                signal: currentAbort.signal,
                onEvent: (ev) => {
                    if (ev.kind === 'usage' && ev.usage) {
                        totalUsage = {
                            prompt_tokens: totalUsage.prompt_tokens + ev.usage.prompt_tokens,
                            completion_tokens: totalUsage.completion_tokens + ev.usage.completion_tokens,
                            total_tokens: totalUsage.total_tokens + ev.usage.total_tokens
                        };
                        runTokens += ev.usage.total_tokens;
                        refreshStatusBar(true);
                    }
                    if (ev.kind === 'cost' && typeof ev.costUsd === 'number') {
                        totalCostUsd += ev.costUsd;
                        runCost += ev.costUsd;
                        refreshStatusBar(true);
                    }
                    if (ev.kind === 'iteration') runIters = ev.iteration ?? runIters;
                    provider.postEvent(ev);
                }
            });
            await saveHistory(context, finalConvo);
            // Append a run record for the run-history viewer.
            try {
                const titleSrc = typeof userMessage.content === 'string'
                    ? userMessage.content
                    : (userMessage.content ?? []).filter((p: any) => p?.type === 'text').map((p: any) => p.text).join(' ');
                const lastAssistant = [...finalConvo].reverse().find(m => m.role === 'assistant' && typeof m.content === 'string' && (m.content as string).trim());
                const summary = lastAssistant && typeof lastAssistant.content === 'string' ? lastAssistant.content : '';
                const recs = await loadRunHistory(context);
                recs.push({
                    timestamp: Date.now(),
                    title: truncateForHist(titleSrc || '(no prompt)', 120),
                    summary: truncateForHist(summary || '(no answer)', 280),
                    iterations: runIters,
                    tokens: runTokens,
                    costUsd: runCost
                });
                await saveRunHistory(context, recs);
            } catch { /* run-history is best-effort */ }
        } catch (e: any) {
            provider.postEvent({ kind: 'error', text: e?.message ?? String(e) });
        } finally {
            runBusy = false;
            currentAbort = undefined;
            refreshStatusBar(false);
            provider.postEvent({ kind: 'done' });
        }
    }

    function truncateForHist(s: string, max: number): string {
        s = s.replace(/\s+/g, ' ').trim();
        return s.length <= max ? s : s.slice(0, max) + '…';
    }

    function cancelCurrentRun(): void {
        if (currentAbort) {
            currentAbort.abort();
            provider.postEvent({ kind: 'status', text: 'Cancelling…' });
        }
    }

    async function clearHistory(): Promise<void> {
        await saveHistory(context, []);
        provider.postEvent({ kind: 'status', text: 'History cleared.' });
        provider.notifyHistoryCleared();
    }

    async function handleSlash(input: string): Promise<boolean> {
        const [cmd, ...rest] = input.slice(1).split(/\s+/);
        const arg = rest.join(' ');
        switch (cmd.toLowerCase()) {
            case 'clear':
                await clearHistory();
                return true;
            case 'help':
                provider.postEvent({
                    kind: 'assistant_text',
                    text: [
                        'Slash commands:',
                        '- `/help` — this list',
                        '- `/clear` — clear chat history',
                        '- `/cancel` — cancel current request',
                        '- `/usage` — show cumulative token usage',
                        '- `/settings` — open extension settings',
                        '- `/key` — set or rotate Azure API key',
                        '- `/setup` — guided setup for endpoint, deployment, API version, and keys',
                        '- `/searchkey` — set or rotate web-search API key (Tavily / Brave)',
                        '- `/mcp` — MCP status / setup placeholder',
                        '',
                        'Inline:',
                        '- `@path/to/file` — attach a workspace file as context',
                        '- Drop or paste an image to send a screenshot to the model'
                    ].join('\n')
                });
                provider.postEvent({ kind: 'done' });
                return true;
            case 'cancel':
                cancelCurrentRun();
                return true;
            case 'usage':
                provider.postEvent({ kind: 'assistant_text', text: usageText() });
                provider.postEvent({ kind: 'done' });
                return true;
            case 'settings':
                vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${EXT}`);
                return true;
            case 'key':
                await setApiKeyFlow();
                return true;
            case 'setup':
                await vscode.commands.executeCommand(`${EXT}.setup`);
                return true;
            case 'searchkey':
                await vscode.commands.executeCommand(`${EXT}.setWebSearchApiKey`);
                return true;
            case 'mcp':
                await vscode.commands.executeCommand(`${EXT}.openMcpSetup`);
                return true;
            default:
                return false;
        }
    }

    function usageText(): string {
        const u = totalUsage;
        return `**Token usage (this session)**\n\n- Prompt: ${u.prompt_tokens.toLocaleString()}\n- Completion: ${u.completion_tokens.toLocaleString()}\n- Total: ${u.total_tokens.toLocaleString()}`;
    }

    async function attachImageFlow(): Promise<void> {
        const picks = await vscode.window.showOpenDialog({
            canSelectMany: true, openLabel: 'Attach to Agent',
            filters: { Images: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }
        });
        if (!picks || picks.length === 0) return;
        const items: { dataUrl: string; name: string }[] = [];
        for (const uri of picks) {
            try {
                const data = await vscode.workspace.fs.readFile(uri);
                const ext = path.extname(uri.fsPath).slice(1).toLowerCase() || 'png';
                const mime = ext === 'jpg' ? 'jpeg' : ext;
                const b64 = Buffer.from(data).toString('base64');
                items.push({ dataUrl: `data:image/${mime};base64,${b64}`, name: path.basename(uri.fsPath) });
            } catch (e: any) {
                vscode.window.showWarningMessage(`Failed to read ${uri.fsPath}: ${e?.message ?? e}`);
            }
        }
        if (items.length > 0) provider.postAttachImages(items);
    }

    async function setApiKeyFlow(): Promise<void> {
        const value = await vscode.window.showInputBox({
            prompt: 'Azure OpenAI API key', password: true, ignoreFocusOut: true,
            placeHolder: 'Stored securely in VS Code SecretStorage'
        });
        if (value && value.trim().length > 0) {
            await context.secrets.store(SECRET_KEY, value.trim());
            client.update({ apiKey: value.trim() });
            refreshStatusBar();
            vscode.window.showInformationMessage('Azure AI Agent: API key saved.');
        }
    }

    async function testConnection(payload: { endpoint: string; deployment: string; apiVersion: string; apiKey?: string }): Promise<{ ok: boolean; message: string }> {
        try {
            const endpoint = payload.endpoint.trim().replace(/\/+$/, '');
            const deployment = payload.deployment.trim();
            const apiVersion = payload.apiVersion.trim();
            const apiKey = (payload.apiKey?.trim() || await resolveApiKey(context)).trim();
            if (!endpoint || !deployment || !apiVersion || !apiKey) {
                return { ok: false, message: 'Endpoint, deployment, API version, and API key are required.' };
            }
            const url = `${endpoint}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
                body: JSON.stringify({ messages: [{ role: 'user', content: 'ping' }], max_completion_tokens: 8 })
            });
            if (!res.ok) {
                const body = await res.text();
                return { ok: false, message: `Connection failed: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}` };
            }
            return { ok: true, message: 'Connection successful.' };
        } catch (e: any) {
            return { ok: false, message: e?.message ?? String(e) };
        }
    }

    async function copyCurl(payload: { endpoint: string; deployment: string; apiVersion: string }): Promise<{ ok: boolean; message: string }> {
        try {
            const endpoint = payload.endpoint.trim().replace(/\/+$/, '');
            const deployment = payload.deployment.trim();
            const apiVersion = payload.apiVersion.trim();
            if (!endpoint || !deployment || !apiVersion) return { ok: false, message: 'Endpoint, deployment, and API version are required.' };
            const curl = `curl -X POST "${endpoint}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}" -H "Content-Type: application/json" -H "api-key: <YOUR_API_KEY>" -d "{\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}],\"max_completion_tokens\":8}"`;
            await vscode.env.clipboard.writeText(curl);
            return { ok: true, message: 'curl test command copied to clipboard.' };
        } catch (e: any) {
            return { ok: false, message: e?.message ?? String(e) };
        }
    }

    async function exportProfile(): Promise<{ ok: boolean; message: string }> {
        try {
            const c = readConfig();
            const uri = await vscode.window.showSaveDialog({ filters: { JSON: ['json'] }, saveLabel: 'Export Azure AI Agent Profile', defaultUri: vscode.Uri.file('azure-ai-agent.profile.json') });
            if (!uri) return { ok: false, message: 'Export cancelled.' };
            const profile = {
                endpoint: c.client.endpoint,
                deployment: c.client.deployment,
                apiVersion: c.client.apiVersion,
                approvalMode: c.executor.approvalMode,
                webBrowsingEnabled: c.toolContext.web.enabled,
                webSearchProvider: c.toolContext.web.searchProvider,
                scrubSecrets: c.toolContext.safety.scrubSecrets,
                compactMode: vscode.workspace.getConfiguration(EXT).get<boolean>('ui.compactMode', false)
            };
            await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(profile, null, 2), 'utf8'));
            return { ok: true, message: 'Settings profile exported.' };
        } catch (e: any) {
            return { ok: false, message: e?.message ?? String(e) };
        }
    }

    async function importProfile(): Promise<{ ok: boolean; message: string }> {
        try {
            const picks = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { JSON: ['json'] }, openLabel: 'Import Azure AI Agent Profile' });
            if (!picks || picks.length === 0) return { ok: false, message: 'Import cancelled.' };
            const data = await vscode.workspace.fs.readFile(picks[0]);
            const json = JSON.parse(Buffer.from(data).toString('utf8'));
            const cfgApi = vscode.workspace.getConfiguration(EXT);
            if (typeof json.endpoint === 'string') await cfgApi.update('endpoint', json.endpoint, vscode.ConfigurationTarget.Workspace);
            if (typeof json.deployment === 'string') await cfgApi.update('deployment', json.deployment, vscode.ConfigurationTarget.Workspace);
            if (typeof json.apiVersion === 'string') await cfgApi.update('apiVersion', json.apiVersion, vscode.ConfigurationTarget.Workspace);
            if (typeof json.approvalMode === 'string') await cfgApi.update('approvalMode', json.approvalMode, vscode.ConfigurationTarget.Workspace);
            if (typeof json.webBrowsingEnabled === 'boolean') await cfgApi.update('webBrowsing.enabled', json.webBrowsingEnabled, vscode.ConfigurationTarget.Workspace);
            if (typeof json.webSearchProvider === 'string') await cfgApi.update('webSearch.provider', json.webSearchProvider, vscode.ConfigurationTarget.Workspace);
            if (typeof json.scrubSecrets === 'boolean') await cfgApi.update('safety.scrubSecrets', json.scrubSecrets, vscode.ConfigurationTarget.Workspace);
            if (typeof json.compactMode === 'boolean') await cfgApi.update('ui.compactMode', json.compactMode, vscode.ConfigurationTarget.Workspace);
            return { ok: true, message: 'Settings profile imported.' };
        } catch (e: any) {
            return { ok: false, message: e?.message ?? String(e) };
        }
    }

    async function applyPreset(preset: 'safe' | 'balanced' | 'power'): Promise<{ ok: boolean; message: string }> {
        try {
            const cfgApi = vscode.workspace.getConfiguration(EXT);
            if (preset === 'safe') {
                await cfgApi.update('approvalMode', 'always', vscode.ConfigurationTarget.Workspace);
                await cfgApi.update('webBrowsing.enabled', false, vscode.ConfigurationTarget.Workspace);
                await cfgApi.update('safety.scrubSecrets', true, vscode.ConfigurationTarget.Workspace);
            } else if (preset === 'balanced') {
                await cfgApi.update('approvalMode', 'destructive', vscode.ConfigurationTarget.Workspace);
                await cfgApi.update('webBrowsing.enabled', true, vscode.ConfigurationTarget.Workspace);
                await cfgApi.update('safety.scrubSecrets', true, vscode.ConfigurationTarget.Workspace);
            } else {
                await cfgApi.update('approvalMode', 'auto', vscode.ConfigurationTarget.Workspace);
                await cfgApi.update('webBrowsing.enabled', true, vscode.ConfigurationTarget.Workspace);
                await cfgApi.update('safety.scrubSecrets', false, vscode.ConfigurationTarget.Workspace);
            }
            return { ok: true, message: `${preset} preset applied.` };
        } catch (e: any) {
            return { ok: false, message: e?.message ?? String(e) };
        }
    }

    async function setupWizard(): Promise<void> {
        const cfgApi = vscode.workspace.getConfiguration(EXT);
        const current = readConfig();
        const endpoint = await vscode.window.showInputBox({
            prompt: 'Azure endpoint URL',
            value: current.client.endpoint,
            ignoreFocusOut: true,
            placeHolder: 'https://your-resource.openai.azure.com/'
        });
        if (endpoint === undefined) return;

        const deployment = await vscode.window.showInputBox({
            prompt: 'Deployment name',
            value: current.client.deployment,
            ignoreFocusOut: true,
            placeHolder: 'gpt-5.4'
        });
        if (deployment === undefined) return;

        const apiVersion = await vscode.window.showInputBox({
            prompt: 'API version',
            value: current.client.apiVersion,
            ignoreFocusOut: true,
            placeHolder: '2024-12-01-preview'
        });
        if (apiVersion === undefined) return;

        const apiKey = await vscode.window.showInputBox({
            prompt: 'Azure API key',
            password: true,
            ignoreFocusOut: true,
            placeHolder: 'Stored securely in SecretStorage'
        });
        if (apiKey === undefined) return;

        await cfgApi.update('endpoint', endpoint.trim(), vscode.ConfigurationTarget.Workspace);
        await cfgApi.update('deployment', deployment.trim(), vscode.ConfigurationTarget.Workspace);
        await cfgApi.update('apiVersion', apiVersion.trim(), vscode.ConfigurationTarget.Workspace);
        if (apiKey.trim()) await context.secrets.store(SECRET_KEY, apiKey.trim());

        const searchProvider = await vscode.window.showQuickPick([
            { label: 'duckduckgo', detail: 'No API key required' },
            { label: 'tavily', detail: 'Requires API key' },
            { label: 'brave', detail: 'Requires API key' }
        ], { placeHolder: 'Choose web search provider' });
        if (searchProvider) {
            await cfgApi.update('webSearch.provider', searchProvider.label, vscode.ConfigurationTarget.Workspace);
            if (searchProvider.label !== 'duckduckgo') {
                const searchKey = await vscode.window.showInputBox({
                    prompt: `${searchProvider.label} API key`,
                    password: true,
                    ignoreFocusOut: true,
                    placeHolder: 'Optional now, can be set later'
                });
                if (searchKey && searchKey.trim()) await context.secrets.store(SEARCH_SECRET_KEY, searchKey.trim());
            }
        }

        const k = await resolveApiKey(context);
        const sk = await resolveSearchApiKey(context);
        const c = readConfig();
        client.update({ ...c.client, apiKey: k });
        executor.updateConfig({
            ...c.executor,
            toolContext: { ...c.toolContext, web: { ...c.toolContext.web, searchApiKey: sk, promptForHost } },
            debugChannel: c.debug ? output : undefined
        });
        refreshStatusBar();
        vscode.window.showInformationMessage('Azure AI Agent setup complete. You can now open chat and start using the agent.');
    }

    // ---------- Commands ----------
    context.subscriptions.push(
        vscode.commands.registerCommand(`${EXT}.startChat`, async () => {
            await vscode.commands.executeCommand('workbench.view.extension.azure-ai-agent-view');
            await vscode.commands.executeCommand('azure-ai-agent.chatView.focus');
        }),
        vscode.commands.registerCommand(`${EXT}.runAgent`, async () => {
            const editor = vscode.window.activeTextEditor;
            const sel = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : '';
            const prompt = await vscode.window.showInputBox({
                prompt: 'What should the agent do?', placeHolder: 'e.g. add tests for the selected function'
            });
            if (!prompt) return;
            await vscode.commands.executeCommand(`${EXT}.startChat`);
            const text = sel ? `${prompt}\n\nSelection:\n\`\`\`\n${sel}\n\`\`\`` : prompt;
            provider.injectUserMessage(text);
            runAgent(text);
        }),
        vscode.commands.registerCommand(`${EXT}.explainCode`, async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.selection.isEmpty) { vscode.window.showInformationMessage('Select code first.'); return; }
            const sel = editor.document.getText(editor.selection);
            const text = `Explain this code:\n\`\`\`${editor.document.languageId}\n${sel}\n\`\`\``;
            await vscode.commands.executeCommand(`${EXT}.startChat`);
            provider.injectUserMessage(text);
            runAgent(text);
        }),
        vscode.commands.registerCommand(`${EXT}.fixCode`, async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.selection.isEmpty) { vscode.window.showInformationMessage('Select code first.'); return; }
            const sel = editor.document.getText(editor.selection);
            const text = `Fix any bugs / improve this code, then update the file. Selected code:\n\`\`\`${editor.document.languageId}\n${sel}\n\`\`\``;
            await vscode.commands.executeCommand(`${EXT}.startChat`);
            provider.injectUserMessage(text);
            runAgent(text);
        }),
        vscode.commands.registerCommand(`${EXT}.generateCode`, async () => {
            const desc = await vscode.window.showInputBox({ prompt: 'Describe the code to generate' });
            if (!desc) return;
            await vscode.commands.executeCommand(`${EXT}.startChat`);
            provider.injectUserMessage(desc);
            runAgent(desc);
        }),
        vscode.commands.registerCommand(`${EXT}.clearChat`, () => clearHistory()),
        vscode.commands.registerCommand(`${EXT}.cancel`, () => cancelCurrentRun()),
        vscode.commands.registerCommand(`${EXT}.openSettings`, () =>
            vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${EXT}`)),
        vscode.commands.registerCommand(`${EXT}.setup`, () => setupWizard()),
        vscode.commands.registerCommand(`${EXT}.openSettingsUi`, () => settingsPanel.show()),
        vscode.commands.registerCommand(`${EXT}.setApiKey`, setApiKeyFlow),
        vscode.commands.registerCommand(`${EXT}.clearApiKey`, async () => {
            await context.secrets.delete(SECRET_KEY);
            client.update({ apiKey: '' });
            refreshStatusBar();
            vscode.window.showInformationMessage('Azure AI Agent: API key removed.');
        }),
        vscode.commands.registerCommand(`${EXT}.attachImage`, () => attachImageFlow()),
        vscode.commands.registerCommand(`${EXT}.showUsage`, () => {
            vscode.window.showInformationMessage(usageText().replace(/\*\*/g, ''));
        }),
        vscode.commands.registerCommand(`${EXT}.setWebSearchApiKey`, async () => {
            const provider = vscode.workspace.getConfiguration(EXT).get<string>('webSearch.provider', 'duckduckgo');
            const value = await vscode.window.showInputBox({
                prompt: `Web search API key (provider: ${provider})`,
                password: true, ignoreFocusOut: true,
                placeHolder: 'Stored securely in VS Code SecretStorage'
            });
            if (value && value.trim().length > 0) {
                await context.secrets.store(SEARCH_SECRET_KEY, value.trim());
                vscode.window.showInformationMessage('Azure AI Agent: web search API key saved.');
            }
        }),
        vscode.commands.registerCommand(`${EXT}.clearWebSearchApiKey`, async () => {
            await context.secrets.delete(SEARCH_SECRET_KEY);
            vscode.window.showInformationMessage('Azure AI Agent: web search API key removed.');
        }),
        vscode.commands.registerCommand(`${EXT}.openRunHistory`, async () => {
            const recs = await loadRunHistory(context);
            const panel = vscode.window.createWebviewPanel('azureAiRunHistory', 'Azure AI Run History', vscode.ViewColumn.One, { enableScripts: true });
            const rows = recs.slice().reverse().map((r, i) => `
              <div class="row" data-text="${escapeHtml((r.title + ' ' + r.summary).toLowerCase())}">
                <button data-i="${i}">${escapeHtml(r.title)}</button>
                <div class="meta">${new Date(r.timestamp).toLocaleString()} · ${r.iterations} iterations · ${formatTokens(r.tokens)} tokens${r.costUsd > 0 ? ` · ${r.costUsd.toFixed(4)}` : ''}</div>
                <div class="sum">${escapeHtml(r.summary)}</div>
              </div>`).join('') || '<div>No previous runs in this workspace yet.</div>';
            panel.webview.html = `<!doctype html><html><body style="font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:16px;max-width:900px;margin:0 auto;"><h2>Run history</h2><input id="q" placeholder="Filter runs..." style="width:100%;padding:10px;border-radius:8px;border:1px solid var(--vscode-panel-border);background:var(--vscode-input-background);color:var(--vscode-input-foreground);margin-bottom:12px;"/>${rows}<script>
              const vscode = acquireVsCodeApi();
              document.querySelectorAll('[data-i]').forEach(el => el.addEventListener('click', () => vscode.postMessage({ type: 'replay', index: Number(el.getAttribute('data-i')) })));
              document.getElementById('q')?.addEventListener('input', (e) => {
                const q = String(e.target.value || '').toLowerCase();
                document.querySelectorAll('.row').forEach(row => {
                  row.style.display = !q || String(row.getAttribute('data-text') || '').includes(q) ? '' : 'none';
                });
              });
            </script></body></html>`;
            panel.webview.onDidReceiveMessage(async (msg) => {
                if (msg?.type !== 'replay') return;
                const rec = recs.slice().reverse()[msg.index];
                if (!rec) return;
                await vscode.commands.executeCommand(`${EXT}.startChat`);
                provider.injectUserMessage(rec.title);
                runAgent(rec.title);
            });
        }),
        vscode.commands.registerCommand(`${EXT}.clearRunHistory`, async () => {
            await saveRunHistory(context, []);
            vscode.window.showInformationMessage('Azure AI Agent: run history cleared.');
        }),
        vscode.commands.registerCommand(`${EXT}.openMcpSetup`, async () => {
            vscode.window.showInformationMessage(`${MCP_PLACEHOLDER_DOC}\n\n${mcp.statusText()}`, { modal: true });
        }),
        vscode.commands.registerCommand(`${EXT}.refreshMcp`, async () => {
            await mcp.apply(readMcpServers());
            await mcp.refreshAll();
            vscode.window.showInformationMessage(`MCP refreshed.\n\n${mcp.statusText()}`);
        }),
        vscode.commands.registerCommand(`${EXT}.showMcpTools`, async () => {
            await mcp.refreshAll();
            const items = mcp.listTools();
            if (items.length === 0) {
                vscode.window.showInformationMessage('No MCP tools discovered.');
                return;
            }
            const pick = await vscode.window.showQuickPick(items.map(t => ({
                label: t.name,
                description: t.serverId,
                detail: t.description ?? ''
            })), { placeHolder: 'Discovered MCP tools (phase 1: discovery only)' });
            if (pick) vscode.window.showInformationMessage(`${pick.label} (${pick.description})`);
        }),
        vscode.workspace.onDidGrantWorkspaceTrust(() => {
            const c = readConfig();
            executor.updateConfig({ toolContext: { ...c.toolContext, web: { ...c.toolContext.web, promptForHost } } });
        })
    );

    // ---------- React to settings & secret changes ----------
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async (e) => {
            if (!e.affectsConfiguration(EXT)) return;
            const k = await resolveApiKey(context);
            const sk = await resolveSearchApiKey(context);
            const c = readConfig();
            client.update({ ...c.client, apiKey: k });
            await mcp.apply(readMcpServers());
            executor.updateTools(buildToolRegistryWithMcp(baseTools, mcp));
            executor.updateConfig({
                ...c.executor,
                toolContext: { ...c.toolContext, web: { ...c.toolContext.web, searchApiKey: sk, promptForHost }, listMcpTools: () => mcp.listTools().map(t => ({ serverId: t.serverId, name: t.name, description: t.description })) },
                debugChannel: c.debug ? output : undefined
            });
            refreshStatusBar();
        }),
        context.secrets.onDidChange(async (e) => {
            if (e.key === SECRET_KEY) {
                const k = await resolveApiKey(context);
                client.update({ apiKey: k });
                refreshStatusBar();
            } else if (e.key === SEARCH_SECRET_KEY) {
                const sk = await resolveSearchApiKey(context);
                const c = readConfig();
                executor.updateConfig({
                    toolContext: { ...c.toolContext, web: { ...c.toolContext.web, searchApiKey: sk, promptForHost }, listMcpTools: () => mcp.listTools().map(t => ({ serverId: t.serverId, name: t.name, description: t.description })) }
                });
            }
        })
    );
}

export function deactivate(): void { /* nothing */ }

function buildToolRegistryWithMcp(baseTools: ReturnType<typeof buildToolRegistry>, mcp: McpManager) {
    const merged: Record<string, any> = { ...baseTools };
    for (const t of mcp.listTools()) {
        if (!t.qualifiedName) continue;
        merged[t.qualifiedName] = {
            destructive: false,
            handler: async (args: any) => mcp.callQualifiedTool(t.qualifiedName!, args),
            spec: {
                type: 'function',
                function: {
                    name: t.qualifiedName,
                    description: t.description || `MCP tool ${t.name} from server ${t.serverId}`,
                    parameters: (t.inputSchema && typeof t.inputSchema === 'object') ? t.inputSchema as Record<string, unknown> : { type: 'object', properties: {}, additionalProperties: true }
                }
            }
        };
    }
    return merged;
}

function readMcpServers(): McpServerConfig[] {
    const raw = vscode.workspace.getConfiguration(EXT).get<any[]>('mcp.servers', []);
    if (!Array.isArray(raw)) return [];
    return raw.map((r, i) => ({
        id: typeof r?.id === 'string' && r.id.trim() ? r.id.trim() : `server-${i + 1}`,
        command: String(r?.command ?? ''),
        args: Array.isArray(r?.args) ? r.args.map((x: any) => String(x)) : [],
        cwd: typeof r?.cwd === 'string' ? r.cwd : undefined,
        env: r?.env && typeof r.env === 'object' ? Object.fromEntries(Object.entries(r.env).map(([k, v]) => [k, String(v)])) : undefined,
        enabled: r?.enabled !== false
    })).filter(s => s.command);
}

// ---------- Helpers ----------

interface FullConfig {
    client: AzureClientConfig;
    executor: Pick<AgentExecutorConfig, 'maxIterations' | 'approvalMode' | 'diffPreview' | 'streamResponses' | 'historyCompressionThreshold' | 'cost' | 'testAfterEdit'>;
    toolContext: ToolContext;
    systemPromptOverride: string;
    instructionsFiles: string[];
    persistHistory: boolean;
    imageDetail: 'auto' | 'low' | 'high';
    debug: boolean;
}

function readConfig(): FullConfig {
    const c = vscode.workspace.getConfiguration(EXT);
    return {
        client: {
            endpoint: c.get<string>('endpoint', '').trim(),
            apiKey: c.get<string>('apiKey', '').trim(),  // overridden by secrets if present
            deployment: c.get<string>('deployment', 'gpt-5.4').trim(),
            apiVersion: c.get<string>('apiVersion', '2024-12-01-preview').trim(),
            maxCompletionTokens: c.get<number>('maxCompletionTokens', 16384),
            temperature: c.get<number>('temperature', 0.2),
            topP: c.get<number>('topP', 0.95)
        },
        executor: {
            maxIterations: c.get<number>('maxIterations', 25),
            approvalMode: c.get<ApprovalMode>('approvalMode', 'destructive'),
            diffPreview: c.get<boolean>('diffPreview', true),
            streamResponses: c.get<boolean>('streamResponses', true),
            historyCompressionThreshold: c.get<number>('historyCompressionThreshold', 60),
            testAfterEdit: c.get<boolean>('testAfterEdit', true),
            cost: {
                inputUsdPerMtok: c.get<number>('cost.inputUsdPerMtok', 0),
                outputUsdPerMtok: c.get<number>('cost.outputUsdPerMtok', 0)
            }
        },
        toolContext: {
            allowedShells: c.get<string[]>('allowedShells', ['powershell', 'pwsh', 'cmd', 'bash', 'sh']),
            commandTimeoutMs: c.get<number>('commandTimeoutMs', 120000),
            maxFileBytes: c.get<number>('maxFileBytes', 200000),
            workspaceTrusted: vscode.workspace.isTrusted,
            safety: {
                scrubSecrets: c.get<boolean>('safety.scrubSecrets', true),
                autoApproveCommandPatterns: c.get<string[]>('safety.autoApproveCommandPatterns', []),
                testAfterEdit: c.get<boolean>('testAfterEdit', true)
            },
            web: {
                enabled: c.get<boolean>('webBrowsing.enabled', true),
                maxBytes: c.get<number>('webBrowsing.maxBytes', 200000),
                timeoutMs: c.get<number>('webBrowsing.timeoutMs', 15000),
                allowedDomains: c.get<string[]>('webBrowsing.allowedDomains', []),
                blockedDomains: c.get<string[]>('webBrowsing.blockedDomains', []),
                searchProvider: c.get<'duckduckgo' | 'tavily' | 'brave'>('webSearch.provider', 'duckduckgo'),
                searchApiKey: c.get<string>('webSearch.apiKey', '').trim(),  // overridden by secrets if present
                sessionAllowedHosts,
                proxyUrl: resolveProxyUrl()
            }
        },
        systemPromptOverride: c.get<string>('systemPrompt', '').trim(),
        instructionsFiles: c.get<string[]>('instructionsFiles', ['.azure-ai-agent/instructions.md', 'AGENTS.md', 'CLAUDE.md']),
        persistHistory: c.get<boolean>('persistHistory', true),
        imageDetail: c.get<'auto' | 'low' | 'high'>('imageDetail', 'auto'),
        debug: c.get<boolean>('debug', false)
    };
}

async function resolveApiKey(context: vscode.ExtensionContext): Promise<string> {
    const fromSecret = await context.secrets.get(SECRET_KEY);
    if (fromSecret && fromSecret.length > 0) return fromSecret;
    const fromConfig = vscode.workspace.getConfiguration(EXT).get<string>('apiKey', '').trim();
    return fromConfig;
}

async function resolveSearchApiKey(context: vscode.ExtensionContext): Promise<string> {
    const fromSecret = await context.secrets.get(SEARCH_SECRET_KEY);
    if (fromSecret && fromSecret.length > 0) return fromSecret;
    const fromConfig = vscode.workspace.getConfiguration(EXT).get<string>('webSearch.apiKey', '').trim();
    return fromConfig;
}

function resolveProxyUrl(): string | undefined {
    const fromExt = vscode.workspace.getConfiguration(EXT).get<string>('proxy', '').trim();
    if (fromExt) return fromExt;
    const fromCode = vscode.workspace.getConfiguration('http').get<string>('proxy', '').trim();
    if (fromCode) return fromCode;
    const env = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
    return env || undefined;
}

async function discoverDeployments(endpoint: string, apiKey: string, apiVersion: string): Promise<string[]> {
    try {
        const clean = endpoint.trim().replace(/\/+$/, '');
        if (!clean || !apiKey) return [];
        const url = `${clean}/openai/deployments?api-version=${encodeURIComponent(apiVersion)}`;
        const res = await fetch(url, { headers: { 'api-key': apiKey } });
        if (!res.ok) return [];
        const json: any = await res.json();
        const items = Array.isArray(json?.data) ? json.data : [];
        return items.map((d: any) => String(d?.id ?? d?.name ?? '')).filter(Boolean);
    } catch {
        return [];
    }
}

async function promptForHost(host: string): Promise<boolean> {
    const pick = await vscode.window.showWarningMessage(
        `The agent wants to fetch from ${host}.`,
        { modal: false, detail: 'Approve once for this session, or always (adds to allowedDomains).' },
        'Allow this session', 'Always allow', 'Deny'
    );
    if (pick === 'Always allow') {
        const cfg = vscode.workspace.getConfiguration(EXT);
        const list = cfg.get<string[]>('webBrowsing.allowedDomains', []);
        if (!list.includes(host)) await cfg.update('webBrowsing.allowedDomains', [...list, host], vscode.ConfigurationTarget.Workspace);
        return true;
    }
    return pick === 'Allow this session';
}

interface RunRecord {
    timestamp: number;
    title: string;        // first user message, truncated
    summary: string;      // last assistant text, truncated
    iterations: number;
    tokens: number;
    costUsd: number;
}

async function loadRunHistory(context: vscode.ExtensionContext): Promise<RunRecord[]> {
    const folders = vscode.workspace.workspaceFolders;
    const k = (folders && folders.length > 0 ? folders[0].uri.toString() : 'global');
    const raw = context.workspaceState.get<RunRecord[]>(RUN_HISTORY_KEY_PREFIX + k, []);
    return Array.isArray(raw) ? raw : [];
}

async function saveRunHistory(context: vscode.ExtensionContext, records: RunRecord[]): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    const k = (folders && folders.length > 0 ? folders[0].uri.toString() : 'global');
    await context.workspaceState.update(RUN_HISTORY_KEY_PREFIX + k, records.slice(-RUN_HISTORY_MAX));
}

function buildUserMessage(text: string, dataUrls: string[]): ChatMessage {
    if (!dataUrls || dataUrls.length === 0) {
        return { role: 'user', content: text };
    }
    const detail = vscode.workspace.getConfiguration(EXT).get<'auto' | 'low' | 'high'>('imageDetail', 'auto');
    const parts: ContentPart[] = [];
    if (text && text.length > 0) parts.push({ type: 'text', text });
    for (const url of dataUrls) parts.push({ type: 'image_url', image_url: { url, detail } });
    return { role: 'user', content: parts };
}

// History persistence — keyed per workspace folder so different projects keep
// separate threads.
function historyKey(): string {
    const folders = vscode.workspace.workspaceFolders;
    const key = folders && folders.length > 0 ? folders[0].uri.toString() : 'global';
    return HISTORY_KEY_PREFIX + key;
}

async function loadHistory(context: vscode.ExtensionContext): Promise<ChatMessage[]> {
    const persist = vscode.workspace.getConfiguration(EXT).get<boolean>('persistHistory', true);
    if (!persist) return [];
    const raw = context.workspaceState.get<ChatMessage[]>(historyKey(), []);
    return Array.isArray(raw) ? raw : [];
}

async function saveHistory(context: vscode.ExtensionContext, msgs: ChatMessage[]): Promise<void> {
    const persist = vscode.workspace.getConfiguration(EXT).get<boolean>('persistHistory', true);
    if (!persist) {
        await context.workspaceState.update(historyKey(), undefined);
        return;
    }
    // Trim to keep state reasonable.
    const trimmed = msgs.slice(-200);
    await context.workspaceState.update(historyKey(), trimmed);
}

function buildConnectionDiagnostics(c: FullConfig, hasApiKey: boolean, hasSearchKey: boolean, deploymentSuggestions: string[]): string[] {
    const out: string[] = [];
    out.push(c.client.endpoint ? `Endpoint set: ${c.client.endpoint}` : 'Endpoint missing.');
    out.push(c.client.deployment ? `Deployment set: ${c.client.deployment}` : 'Deployment missing.');
    out.push(c.client.apiVersion ? `API version set: ${c.client.apiVersion}` : 'API version missing.');
    out.push(hasApiKey ? 'Azure API key is available in SecretStorage/config.' : 'Azure API key is missing.');
    out.push(c.toolContext.web.searchProvider === 'duckduckgo' || hasSearchKey ? `Search provider ready: ${c.toolContext.web.searchProvider}` : `Search provider ${c.toolContext.web.searchProvider} needs an API key.`);
    out.push(deploymentSuggestions.length > 0 ? `Discovered ${deploymentSuggestions.length} deployment suggestion(s).` : 'No live deployment suggestions discovered; using fallback suggestions.');
    out.push(vscode.workspace.isTrusted ? 'Workspace is trusted.' : 'Workspace is not trusted; some tools are restricted.');
    return out;
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatTokens(n: number): string {
    if (n < 1000) return String(n);
    if (n < 1_000_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return (n / 1_000_000).toFixed(2).replace(/\.0+$/, '') + 'M';
}
