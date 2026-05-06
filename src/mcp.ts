import * as vscode from 'vscode';
import { ChildProcess, spawn } from 'child_process';

export interface McpServerConfig {
    id: string;
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    enabled?: boolean;
}

export interface McpToolInfo {
    serverId: string;
    name: string;
    description?: string;
    inputSchema?: unknown;
    qualifiedName?: string;
}

interface PendingRequest {
    resolve: (value: any) => void;
    reject: (reason?: any) => void;
    timer: NodeJS.Timeout;
}

class McpServerRuntime {
    readonly tools: McpToolInfo[] = [];
    private child: ChildProcess | undefined;
    private buffer = '';
    private nextId = 1;
    private pending = new Map<number, PendingRequest>();
    private lastError: string | undefined;

    constructor(readonly cfg: McpServerConfig, private readonly output: vscode.OutputChannel) {}

    async start(): Promise<void> {
        if (this.child) return;
        this.child = spawn(this.cfg.command, this.cfg.args ?? [], {
            cwd: this.cfg.cwd,
            env: { ...process.env, ...(this.cfg.env ?? {}) },
            stdio: 'pipe',
            windowsHide: true
        });
        this.child.stdout?.on('data', (chunk: Buffer) => this.onStdout(chunk.toString('utf8')));
        this.child.stderr?.on('data', (chunk: Buffer) => this.output.appendLine(`[MCP:${this.cfg.id}:stderr] ${chunk.toString('utf8').trimEnd()}`));
        this.child.on('exit', (code, signal) => {
            this.lastError = code === 0 ? undefined : `exited code=${code} signal=${signal}`;
            this.output.appendLine(`[MCP:${this.cfg.id}] exited code=${code} signal=${signal}`);
            this.child = undefined;
        });
        this.child.on('error', (e) => {
            this.lastError = e.message;
            this.output.appendLine(`[MCP:${this.cfg.id}] spawn error: ${e.message}`);
        });
        await this.initialize();
        await this.refreshTools();
    }

    async stop(): Promise<void> {
        if (!this.child) return;
        try { this.child.kill(); } catch { /* ignore */ }
        this.child = undefined;
    }

    async refreshTools(): Promise<void> {
        const res = await this.request('tools/list', {});
        const items = Array.isArray(res?.tools) ? res.tools : [];
        this.tools.length = 0;
        for (const t of items) {
            const name = String(t?.name ?? '');
            this.tools.push({
                serverId: this.cfg.id,
                name,
                qualifiedName: `mcp__${this.cfg.id}__${name}`,
                description: typeof t?.description === 'string' ? t.description : undefined,
                inputSchema: t?.inputSchema
            });
        }
    }

    async callTool(name: string, args: unknown): Promise<{ content: string; isError?: boolean }> {
        const res = await this.request('tools/call', { name, arguments: args ?? {} });
        const content = Array.isArray(res?.content)
            ? res.content.map((c: any) => typeof c?.text === 'string' ? c.text : JSON.stringify(c)).join('\n')
            : JSON.stringify(res ?? {}, null, 2);
        return { content, isError: !!res?.isError };
    }

    private async initialize(): Promise<void> {
        await this.request('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'azure-ai-agent', version: '1.1.0' }
        });
        this.notify('notifications/initialized', {});
    }

    private onStdout(text: string): void {
        this.buffer += text;
        while (true) {
            const headerEnd = this.buffer.indexOf('\r\n\r\n');
            if (headerEnd < 0) return;
            const header = this.buffer.slice(0, headerEnd);
            const m = header.match(/Content-Length:\s*(\d+)/i);
            if (!m) {
                this.buffer = this.buffer.slice(headerEnd + 4);
                continue;
            }
            const len = parseInt(m[1], 10);
            const total = headerEnd + 4 + len;
            if (this.buffer.length < total) return;
            const body = this.buffer.slice(headerEnd + 4, total);
            this.buffer = this.buffer.slice(total);
            try {
                const msg = JSON.parse(body);
                if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
                    const p = this.pending.get(msg.id)!;
                    clearTimeout(p.timer);
                    this.pending.delete(msg.id);
                    if (msg.error) p.reject(new Error(msg.error.message ?? 'MCP error'));
                    else p.resolve(msg.result);
                }
            } catch (e: any) {
                this.output.appendLine(`[MCP:${this.cfg.id}] parse error: ${e?.message ?? e}`);
            }
        }
    }

    private writeMessage(msg: unknown): void {
        if (!this.child?.stdin) throw new Error(`MCP server ${this.cfg.id} is not running.`);
        const body = JSON.stringify(msg);
        const wire = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
        this.child.stdin.write(wire, 'utf8');
    }

    private request(method: string, params: unknown): Promise<any> {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`MCP request timed out: ${method}`));
            }, 15000);
            this.pending.set(id, { resolve, reject, timer });
            this.writeMessage({ jsonrpc: '2.0', id, method, params });
        });
    }

    private notify(method: string, params: unknown): void {
        this.writeMessage({ jsonrpc: '2.0', method, params });
    }
}

export class McpManager {
    private runtimes = new Map<string, McpServerRuntime>();

    constructor(private readonly output: vscode.OutputChannel) {}

    async apply(configs: McpServerConfig[]): Promise<void> {
        const wanted = new Map(configs.filter(c => c.enabled !== false).map(c => [c.id, c]));
        for (const [id, rt] of this.runtimes) {
            if (!wanted.has(id)) {
                await rt.stop();
                this.runtimes.delete(id);
            }
        }
        for (const cfg of wanted.values()) {
            let rt = this.runtimes.get(cfg.id);
            if (!rt) {
                rt = new McpServerRuntime(cfg, this.output);
                this.runtimes.set(cfg.id, rt);
            }
            try {
                await rt.start();
            } catch (e: any) {
                this.output.appendLine(`[MCP:${cfg.id}] failed to start: ${e?.message ?? e}`);
            }
        }
    }

    async refreshAll(): Promise<void> {
        for (const rt of this.runtimes.values()) {
            try { await rt.refreshTools(); } catch (e: any) { this.output.appendLine(`[MCP:${rt.cfg.id}] refresh failed: ${e?.message ?? e}`); }
        }
    }

    listTools(): McpToolInfo[] {
        return [...this.runtimes.values()].flatMap(r => r.tools);
    }

    async callQualifiedTool(qualifiedName: string, args: unknown): Promise<{ ok: boolean; content: string; summary: string }> {
        const m = /^mcp__([^_]+(?:-[^_]+)*)__([^]+)$/.exec(qualifiedName);
        if (!m) return { ok: false, content: `Invalid MCP tool name: ${qualifiedName}`, summary: 'Invalid MCP tool name' };
        const serverId = m[1];
        const toolName = m[2];
        const rt = this.runtimes.get(serverId);
        if (!rt) return { ok: false, content: `MCP server not running: ${serverId}`, summary: 'MCP server not running' };
        try {
            const res = await rt.callTool(toolName, args);
            return { ok: !res.isError, content: res.content, summary: `${qualifiedName} -> ${res.isError ? 'error' : 'ok'}` };
        } catch (e: any) {
            return { ok: false, content: e?.message ?? String(e), summary: `${qualifiedName} failed` };
        }
    }

    statusText(): string {
        if (this.runtimes.size === 0) return 'No MCP servers configured/running.';
        return [...this.runtimes.values()].map(r => `- ${r.cfg.id}: ${r.tools.length} tool(s)${(r as any).lastError ? ` — ${(r as any).lastError}` : ''}`).join('\n');
    }

    async ensureServerForTool(qualifiedName: string): Promise<void> {
        const m = /^mcp__([^_]+(?:-[^_]+)*)__/.exec(qualifiedName);
        if (!m) return;
        const serverId = m[1];
        const rt = this.runtimes.get(serverId);
        if (!rt) return;
        if (!(rt as any).child) {
            await rt.start();
            await rt.refreshTools();
        }
    }

    async dispose(): Promise<void> {
        for (const rt of this.runtimes.values()) await rt.stop();
        this.runtimes.clear();
    }
}
