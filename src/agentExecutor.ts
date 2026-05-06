// Agent loop. Sends conversation + tool specs to Azure, executes any
// requested tool calls (with optional diff-preview approval for file
// mutations), feeds results back, and repeats until the model returns a
// normal assistant message or we hit max iterations.

import * as vscode from 'vscode';
import { AzureOpenAIClient, ChatMessage, ToolSpec, Usage } from './azureClient';
import { AgentTool, ToolContext, isDestructive, isAutoApproved, ToolEventSink, SubAgentSpawner } from './tools';
import { previewDiffAndAsk } from './diffPreview';

export type ApprovalMode = 'auto' | 'destructive' | 'always';

export interface AgentEvent {
    kind:
        | 'assistant_text'
        | 'assistant_text_delta'
        | 'tool_call'
        | 'tool_result'
        | 'tool_stream'
        | 'iteration'
        | 'status'
        | 'usage'
        | 'cost'
        | 'todos'
        | 'error'
        | 'done';
    text?: string;
    tool?: string;
    args?: unknown;
    callId?: string;
    ok?: boolean;
    iteration?: number;
    usage?: Usage;
    /** USD cost increment for this turn. */
    costUsd?: number;
    /** Streamed stdout/stderr chunk source (for tool_stream events). */
    stream?: 'stdout' | 'stderr';
    /** Render payload for `todos` events. */
    todos?: { text: string; status: string }[];
}

export type AgentEventSink = (event: AgentEvent) => void;

export interface AgentRunOptions {
    /** Final user-side message (may be string or array of multimodal parts). */
    userMessage: ChatMessage;
    history: ChatMessage[];
    systemPrompt: string;
    onEvent: AgentEventSink;
    signal?: AbortSignal;
    /** Optional tool whitelist (used for sub-agent runs). */
    allowedTools?: string[];
    /** Override max iterations for this run only. */
    maxIterationsOverride?: number;
}

export interface CostConfig {
    /** USD per million input (prompt) tokens. */
    inputUsdPerMtok: number;
    /** USD per million output (completion) tokens. */
    outputUsdPerMtok: number;
}

export interface AgentExecutorConfig {
    maxIterations: number;
    approvalMode: ApprovalMode;
    diffPreview: boolean;
    streamResponses: boolean;
    toolContext: ToolContext;
    debugChannel?: vscode.OutputChannel;
    /** Soft cap on conversation length before older turns are summary-elided. */
    historyCompressionThreshold: number;
    cost: CostConfig;
    /** Hint after writes when sibling test files exist. */
    testAfterEdit: boolean;
}

export class AgentExecutor {
    private client: AzureOpenAIClient | undefined;
    private tools: Record<string, AgentTool>;
    private cfg: AgentExecutorConfig;

    constructor(client: AzureOpenAIClient | undefined, tools: Record<string, AgentTool>, cfg: AgentExecutorConfig) {
        this.client = client;
        this.tools = tools;
        this.cfg = cfg;
    }

    updateClient(client: AzureOpenAIClient | undefined): void {
        this.client = client;
    }

    updateConfig(cfg: Partial<AgentExecutorConfig>): void {
        this.cfg = { ...this.cfg, ...cfg };
    }

    updateTools(tools: Record<string, AgentTool>): void {
        this.tools = tools;
    }

    /**
     * Run the agent loop. Returns the final updated conversation (without
     * the initial system prompt) so the caller can persist it as history.
     */
    async run(opts: AgentRunOptions): Promise<ChatMessage[]> {
        if (!this.client || !this.client.isReady()) {
            opts.onEvent({ kind: 'error', text: 'Azure client is not configured. Set endpoint, deployment and API key (run "Azure AI: Set API Key").' });
            return opts.history;
        }

        const allowed = opts.allowedTools && opts.allowedTools.length > 0
            ? new Set(opts.allowedTools)
            : undefined;
        const visibleTools: Record<string, AgentTool> = allowed
            ? Object.fromEntries(Object.entries(this.tools).filter(([n]) => allowed.has(n)))
            : this.tools;

        const toolSpecs: ToolSpec[] = Object.values(visibleTools).map(t => t.spec);
        let conversation: ChatMessage[] = [...opts.history, opts.userMessage];
        const lastEditedFiles = new Set<string>();
        const maxIterations = opts.maxIterationsOverride ?? this.cfg.maxIterations;

        // Wire a per-run tool event sink: forward stdout/stderr as tool_stream
        // events and intercept the magic "__todos__:" status payload.
        const toolEventSink: ToolEventSink = (kind, text) => {
            if (kind === 'status' && text.startsWith('__todos__:')) {
                try {
                    const todos = JSON.parse(text.slice('__todos__:'.length));
                    opts.onEvent({ kind: 'todos', todos });
                    return;
                } catch { /* fall through */ }
            }
            if (kind === 'stdout' || kind === 'stderr') {
                opts.onEvent({ kind: 'tool_stream', stream: kind, text });
            } else {
                opts.onEvent({ kind: 'status', text });
            }
        };

        const ctxForRun: ToolContext = {
            ...this.cfg.toolContext,
            onEvent: toolEventSink,
            signal: opts.signal,
            spawnSubAgent: this.makeSubAgentSpawner(opts.onEvent)
        };

        for (let iter = 1; iter <= maxIterations; iter++) {
            if (opts.signal?.aborted) {
                opts.onEvent({ kind: 'status', text: 'Cancelled.' });
                return conversation;
            }

            opts.onEvent({ kind: 'iteration', iteration: iter });
            this.debug(`-- iteration ${iter} --`);

            // History compression — once the conversation grows past the
            // threshold, fold the middle into a single synthetic message so we
            // keep the recent turns intact without blowing context.
            if (conversation.length > this.cfg.historyCompressionThreshold) {
                conversation = compressConversation(conversation, this.cfg.historyCompressionThreshold);
                opts.onEvent({ kind: 'status', text: `History compressed to ${conversation.length} messages.` });
            }

            const messagesForApi: ChatMessage[] = [
                { role: 'system', content: opts.systemPrompt },
                ...conversation
            ];

            let result;
            try {
                if (this.cfg.streamResponses) {
                    result = await this.client.streamAssembled(
                        messagesForApi,
                        { tools: toolSpecs, toolChoice: 'auto', signal: opts.signal },
                        (chunk) => opts.onEvent({ kind: 'assistant_text_delta', text: chunk })
                    );
                } else {
                    result = await this.client.chat(messagesForApi, {
                        tools: toolSpecs, toolChoice: 'auto', signal: opts.signal
                    });
                }
            } catch (e: any) {
                if (opts.signal?.aborted) {
                    opts.onEvent({ kind: 'status', text: 'Cancelled.' });
                    return conversation;
                }
                opts.onEvent({ kind: 'error', text: e?.message ?? String(e) });
                return conversation;
            }

            if (result.usage) {
                opts.onEvent({ kind: 'usage', usage: result.usage });
                const cost = (result.usage.prompt_tokens * this.cfg.cost.inputUsdPerMtok
                            + result.usage.completion_tokens * this.cfg.cost.outputUsdPerMtok) / 1_000_000;
                if (cost > 0) opts.onEvent({ kind: 'cost', costUsd: cost });
            }

            const msg = result.choice.message;
            const toolCalls = msg.tool_calls ?? [];

            // Always append assistant message (with any tool_calls) to the conversation.
            conversation.push({
                role: 'assistant',
                content: msg.content ?? '',
                tool_calls: toolCalls.length > 0 ? toolCalls : undefined
            });

            if (msg.content && msg.content.trim().length > 0 && !this.cfg.streamResponses) {
                // In stream mode the deltas were already emitted; emit a final
                // text event in non-stream mode.
                opts.onEvent({ kind: 'assistant_text', text: msg.content });
            } else if (msg.content && msg.content.trim().length > 0 && this.cfg.streamResponses) {
                // Signal "end of streamed text" so UIs can finalize the bubble.
                opts.onEvent({ kind: 'assistant_text', text: msg.content });
            }

            if (toolCalls.length === 0) {
                opts.onEvent({ kind: 'done' });
                return conversation;
            }

            for (const call of toolCalls) {
                if (opts.signal?.aborted) {
                    opts.onEvent({ kind: 'status', text: 'Cancelled.' });
                    return conversation;
                }

                const name = call.function.name;
                let args: any = {};
                try {
                    args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
                } catch (e: any) {
                    // JSON repair: tell the model the parse failure so it can retry on the next turn,
                    // instead of just dropping the call.
                    const errMsg = `Invalid JSON arguments for ${name}: ${e?.message ?? e}\n\nReceived: ${truncateForLog(String(call.function.arguments ?? ''), 500)}\n\nRetry with valid JSON arguments.`;
                    opts.onEvent({ kind: 'tool_call', tool: name, args: call.function.arguments, callId: call.id });
                    opts.onEvent({ kind: 'tool_result', tool: name, callId: call.id, ok: false, text: errMsg });
                    conversation.push({ role: 'tool', tool_call_id: call.id, content: errMsg });
                    continue;
                }

                opts.onEvent({ kind: 'tool_call', tool: name, args, callId: call.id });

                const tool = visibleTools[name];
                if (!tool) {
                    const text = allowed
                        ? `Tool ${name} is not allowed in this sub-agent. Allowed: ${[...allowed].join(', ')}`
                        : `Unknown tool: ${name}`;
                    opts.onEvent({ kind: 'tool_result', tool: name, callId: call.id, ok: false, text });
                    conversation.push({ role: 'tool', tool_call_id: call.id, content: text });
                    continue;
                }

                const toolResult = await this.invokeWithApproval(name, tool, args, ctxForRun);
                this.debug(`tool ${name} -> ${toolResult.summary}`);

                let resultContent = toolResult.content;
                // Test-after-edit hint: when the agent edits foo.ts and a sibling
                // foo.test.ts / foo.spec.ts exists, append a one-line nudge.
                if (this.cfg.testAfterEdit && toolResult.ok && (name === 'edit_file' || name === 'write_file' || name === 'apply_patch')) {
                    const editedPaths = collectEditedPaths(name, args);
                    for (const p of editedPaths) lastEditedFiles.add(p);
                    const hint = await testHintFor(editedPaths);
                    if (hint) resultContent += `\n\n[hint] ${hint}`;
                }

                opts.onEvent({
                    kind: 'tool_result', tool: name, callId: call.id,
                    ok: toolResult.ok, text: resultContent
                });
                conversation.push({ role: 'tool', tool_call_id: call.id, content: resultContent });
            }
        }

        opts.onEvent({ kind: 'error', text: `Reached max iterations (${this.cfg.maxIterations}). Stopping.` });
        return conversation;
    }

    private async invokeWithApproval(name: string, tool: AgentTool, args: any, ctx: ToolContext) {
        const needsApproval = this.shouldAskApproval(name, tool.destructive, args, ctx);

        // Diff-preview path for file-mutating tools that have a planner.
        if (needsApproval && this.cfg.diffPreview && tool.plan) {
            try {
                const planRes = await tool.plan(args, ctx);
                if (planRes.plans.length === 0) {
                    return { ok: false, summary: 'No-op plan', content: 'Tool produced no changes.' };
                }
                for (const p of planRes.plans) {
                    if (p.before === p.after) continue;
                    const decision = await previewDiffAndAsk({
                        title: `${name}: ${p.relPath}${p.isNew ? ' (new file)' : ''}`,
                        relPath: p.relPath,
                        originalContent: p.before,
                        proposedContent: p.after,
                        languageId: p.languageId
                    });
                    if (decision === 'edit') {
                        return { ok: false, summary: 'User chose manual edit', content: `User chose to manually edit ${p.relPath} instead of auto-applying the diff.` };
                    }
                    if (decision !== 'approve') {
                        return { ok: false, summary: 'User denied diff', content: `User denied changes to ${p.relPath}.` };
                    }
                }
                return await planRes.commit();
            } catch (e: any) {
                return { ok: false, summary: 'Plan failed', content: `Plan/preview failed for ${name}: ${e?.message ?? e}` };
            }
        }

        // Modal-prompt path for non-file destructive tools (e.g. run_command, delete_file).
        if (needsApproval) {
            const ok = await this.askModalApproval(name, args);
            if (!ok) return { ok: false, summary: 'User denied tool', content: 'User denied tool call.' };
        }

        try {
            return await tool.handler(args, ctx);
        } catch (e: any) {
            return { ok: false, summary: 'Tool threw', content: `Tool ${name} threw: ${e?.message ?? e}` };
        }
    }

    private shouldAskApproval(toolName: string, destructive: boolean, args: any, ctx: ToolContext): boolean {
        const mode = this.cfg.approvalMode;
        const isMcp = toolName.startsWith('mcp__');
        const mcpMode = (ctx as any).mcpApprovalMode as ApprovalMode | undefined;
        if (isMcp && mcpMode) {
            if (mcpMode === 'auto') return false;
            if (mcpMode === 'always') return true;
        }
        if (mode === 'auto') return false;
        if (mode === 'always') return true;
        // 'destructive'
        if (!destructive && !isDestructive(toolName)) return false;
        // Auto-approve if a configured pattern matches.
        if (isAutoApproved(toolName, args, ctx.safety)) return false;
        return true;
    }

    private makeSubAgentSpawner(parentEvents: AgentEventSink): SubAgentSpawner {
        return async ({ task, allowedTools, maxIterations, signal }) => {
            // Default sub-agent toolset: read-only tools only, plus web tools.
            const safe = allowedTools && allowedTools.length > 0 ? allowedTools : [
                'read_file', 'list_directory', 'glob_files', 'search_text',
                'find_symbols', 'get_diagnostics', 'get_workspace_info',
                'get_definition', 'get_references', 'web_search', 'web_fetch',
                'read_memory'
            ];
            const childMessages: ChatMessage[] = [];
            const subSink: AgentEventSink = (ev) => {
                // Surface lifecycle events to the parent UI as inline status.
                if (ev.kind === 'iteration') parentEvents({ kind: 'status', text: `[sub-agent] iteration ${ev.iteration}` });
                if (ev.kind === 'tool_call') parentEvents({ kind: 'status', text: `[sub-agent] → ${ev.tool}` });
                if (ev.kind === 'usage' && ev.usage) parentEvents({ kind: 'usage', usage: ev.usage });
            };
            const finalConvo = await this.run({
                userMessage: { role: 'user', content: task },
                history: childMessages,
                systemPrompt: 'You are a sub-agent invoked by the main coding agent. Focus narrowly on the task. When done, reply with a concise summary of what you found — that summary is your only output.',
                onEvent: subSink,
                signal,
                allowedTools: safe,
                maxIterationsOverride: maxIterations
            });
            // Final assistant text is the last assistant message with non-empty content.
            for (let i = finalConvo.length - 1; i >= 0; i--) {
                const m = finalConvo[i];
                if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
                    return m.content.trim();
                }
            }
            return '(sub-agent produced no final answer)';
        };
    }

    private async askModalApproval(toolName: string, args: any): Promise<boolean> {
        const detail = previewArgs(toolName, args);
        const pick = await vscode.window.showWarningMessage(
            `Agent wants to call: ${toolName}`,
            { modal: true, detail },
            'Approve',
            'Deny'
        );
        return pick === 'Approve';
    }

    private debug(msg: string): void {
        if (this.cfg.debugChannel) this.cfg.debugChannel.appendLine(msg);
    }
}

function truncateForLog(s: string, max: number): string {
    return s.length <= max ? s : s.slice(0, max) + `… [+${s.length - max} chars]`;
}

/**
 * Keeps the first 4 + last (threshold - 5) messages and folds the middle
 * into a single synthetic "earlier conversation" placeholder. Crude but safe:
 * never modifies tool_calls/tool_results within kept windows so the schema
 * stays valid.
 */
function compressConversation(msgs: ChatMessage[], threshold: number): ChatMessage[] {
    if (msgs.length <= threshold) return msgs;
    const keepHead = 4;
    const keepTail = Math.max(threshold - keepHead - 1, 8);
    const head = msgs.slice(0, keepHead);
    const tail = msgs.slice(-keepTail);
    // Don't strand a tool message at the start of the tail: tool messages must
    // follow an assistant message that contains the tool_call. Walk forward
    // until we land on a user/assistant boundary.
    let tailStart = 0;
    while (tailStart < tail.length && tail[tailStart].role === 'tool') tailStart++;
    const trimmedTail = tail.slice(tailStart);
    const elided = msgs.length - head.length - trimmedTail.length;
    const summary: ChatMessage = {
        role: 'user',
        content: `[Earlier conversation: ${elided} message(s) elided to fit context. Recent turns are preserved verbatim below.]`
    };
    return [...head, summary, ...trimmedTail];
}

function collectEditedPaths(toolName: string, args: any): string[] {
    if (toolName === 'edit_file' || toolName === 'write_file') {
        return typeof args?.path === 'string' ? [args.path] : [];
    }
    if (toolName === 'apply_patch' && Array.isArray(args?.edits)) {
        return args.edits.map((e: any) => e?.path).filter((p: any) => typeof p === 'string');
    }
    return [];
}

async function testHintFor(paths: string[]): Promise<string | undefined> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return undefined;
    const root = folders[0].uri;
    for (const rel of paths) {
        const dot = rel.lastIndexOf('.');
        if (dot < 0) continue;
        const stem = rel.slice(0, dot);
        const ext = rel.slice(dot);
        const candidates = [`${stem}.test${ext}`, `${stem}.spec${ext}`];
        for (const c of candidates) {
            try {
                await vscode.workspace.fs.stat(vscode.Uri.joinPath(root, c));
                return `Sibling test file detected: ${c}. Consider running it via run_task or run_command before finishing.`;
            } catch { /* not present */ }
        }
    }
    return undefined;
}

function previewArgs(tool: string, args: any): string {
    try {
        if (tool === 'run_command') {
            return `cwd: ${args.cwd ?? '.'}\nshell: ${args.shell ?? '(default)'}\ncommand:\n${String(args.command ?? '')}`;
        }
        if (tool === 'delete_file') {
            return `path: ${args.path}`;
        }
        const json = JSON.stringify(args, null, 2);
        return json.length > 1500 ? json.slice(0, 1500) + '\n…' : json;
    } catch {
        return String(args);
    }
}

export const DEFAULT_SYSTEM_PROMPT = `You are an autonomous coding agent embedded in Visual Studio Code, powered by the user's Azure AI Foundry deployment.

You can call tools to inspect and modify the user's workspace:
- read_file, list_directory, glob_files, search_text, find_symbols, get_diagnostics, get_workspace_info — for understanding the project.
- write_file, edit_file, apply_patch, delete_file — for changing files.
- run_command — for executing shell commands (builds, tests, package installs, git, etc.).
- web_search, web_fetch — for looking things up on the open web (docs, error messages, library APIs, current versions).

Operating principles:
1. Before editing, gather enough context with read/search tools. Don't guess at file contents. Prefer find_symbols over search_text when looking for a definition.
2. Make focused, minimal changes. Don't rewrite unrelated code.
3. Prefer edit_file for small, single-file edits; apply_patch for multi-file coordinated changes; write_file for new files or full rewrites.
4. After meaningful edits, verify with build/test commands or get_diagnostics when sensible.
5. Pass workspace-relative paths to all tools.
6. Use web_search to discover URLs and web_fetch to read them when you need current docs, API references, or unfamiliar error messages. Cite the source URL in your reply when web info materially shaped the answer.
7. When you're done, reply with a short natural-language summary of what changed and any follow-ups. Don't just stop silently.
8. If the user asks a question that doesn't need tools, just answer directly.
9. If the user attaches images, use them as visual context (UI screenshots, diagrams, error screens).

Be concise in your text replies. Use markdown code blocks for code.`;
