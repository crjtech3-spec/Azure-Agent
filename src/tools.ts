// Tool definitions + implementations.
// Every tool is workspace-scoped: paths resolve against the first workspace
// folder and are rejected if they escape it.
//
// File-mutating tools (write_file, edit_file, apply_patch) implement a
// `plan()` step that returns the would-be new content for each affected
// file, plus a `commit()` closure. The executor uses plan() to drive a
// diff-preview approval flow, then calls commit() if the user approves.

import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import * as https from 'https';
import { spawn } from 'child_process';
import { ToolSpec } from './azureClient';

export interface WebContext {
    enabled: boolean;
    maxBytes: number;
    timeoutMs: number;
    allowedDomains: string[];
    blockedDomains: string[];
    searchProvider: 'duckduckgo' | 'tavily' | 'brave';
    searchApiKey: string;
    /** Hosts the user has approved for this VS Code session. Mutated in-place. */
    sessionAllowedHosts: Set<string>;
    /** Optional async prompt (host -> approved?) for first-use domain confirmation. */
    promptForHost?: (host: string) => Promise<boolean>;
    /** Proxy URL (http(s)://host:port) or undefined for direct. */
    proxyUrl?: string;
}

export interface SafetyContext {
    /** Redact obvious secrets from file/command output before returning to model. */
    scrubSecrets: boolean;
    /** Patterns that, if matched, auto-approve a run_command without prompting. */
    autoApproveCommandPatterns: string[];
    /** Hint after writes when sibling test files exist. */
    testAfterEdit: boolean;
}

/** Optional event sink for tools that want to stream progress (e.g. run_command). */
export type ToolEventSink = (kind: 'stdout' | 'stderr' | 'status', text: string) => void;

/** Spawns a sub-agent run. Returns the final assistant text (or error). */
export type SubAgentSpawner = (opts: {
    task: string;
    allowedTools?: string[];
    maxIterations?: number;
    signal?: AbortSignal;
}) => Promise<string>;

export interface ToolContext {
    maxFileBytes: number;
    commandTimeoutMs: number;
    allowedShells: string[];
    web: WebContext;
    safety: SafetyContext;
    /** Set when a tool is run in streaming mode. */
    onEvent?: ToolEventSink;
    /** Optional. If set, enables the spawn_agent tool. */
    spawnSubAgent?: SubAgentSpawner;
    /** AbortSignal for the current agent run. */
    signal?: AbortSignal;
    /** Workspace trust state captured at run start. */
    workspaceTrusted: boolean;
    /** Optional MCP tool lister for phase 1 discovery/status. */
    listMcpTools?: () => { serverId: string; name: string; description?: string }[];
    /** Optional MCP-specific approval mode override. */
    mcpApprovalMode?: 'auto' | 'destructive' | 'always';
}

export interface ToolResult {
    ok: boolean;
    content: string;
    summary: string;
}

export interface DiffPlan {
    relPath: string;
    before: string;          // empty for new files
    after: string;
    isNew: boolean;
    isDelete?: boolean;
    languageId?: string;
}

export interface PlanResult {
    plans: DiffPlan[];
    commit: () => Promise<ToolResult>;
}

export type ToolHandler = (args: any, ctx: ToolContext) => Promise<ToolResult>;
export type ToolPlanner = (args: any, ctx: ToolContext) => Promise<PlanResult>;

export interface AgentTool {
    spec: ToolSpec;
    handler: ToolHandler;
    destructive: boolean;
    /** If set, the executor uses this instead of `handler` to enable diff preview. */
    plan?: ToolPlanner;
}

const DESTRUCTIVE = new Set(['write_file', 'edit_file', 'apply_patch', 'run_command', 'delete_file', 'run_task', 'write_memory']);
export function isDestructive(toolName: string): boolean { return DESTRUCTIVE.has(toolName); }

/** Returns true if a tool call should be auto-approved given the safety config. */
export function isAutoApproved(toolName: string, args: any, safety: SafetyContext): boolean {
    if (toolName === 'run_command' && typeof args?.command === 'string') {
        const cmd = args.command;
        for (const pat of safety.autoApproveCommandPatterns) {
            try {
                if (new RegExp(pat).test(cmd)) return true;
            } catch { /* ignore bad pattern */ }
        }
    }
    return false;
}

export const PROJECT_MEMORY_PATH = '.azure-ai-agent/memory.md';

function workspaceRoot(): string {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) throw new Error('No workspace folder is open. Open a folder in VS Code first.');
    return folders[0].uri.fsPath;
}

function resolveSafe(rel: string): string {
    const root = workspaceRoot();
    const abs = path.resolve(root, rel);
    const rootResolved = path.resolve(root);
    const inside = abs === rootResolved || abs.startsWith(rootResolved + path.sep);
    if (!inside) throw new Error(`Path "${rel}" escapes the workspace root.`);
    return abs;
}

function asString(v: unknown, name: string): string {
    if (typeof v !== 'string') throw new Error(`Argument "${name}" must be a string.`);
    return v;
}
function ok(summary: string, content?: string): ToolResult { return { ok: true, summary, content: content ?? summary }; }
function err(message: string): ToolResult { return { ok: false, summary: `Error: ${message}`, content: `Error: ${message}` }; }

async function readIfExists(uri: vscode.Uri): Promise<string | undefined> {
    try {
        const data = await vscode.workspace.fs.readFile(uri);
        return Buffer.from(data).toString('utf8');
    } catch {
        return undefined;
    }
}

async function ensureDir(absPath: string): Promise<void> {
    try { await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(absPath))); } catch { /* ignore */ }
}

function languageIdFor(rel: string): string {
    const ext = path.extname(rel).toLowerCase();
    return ({
        '.ts': 'typescript', '.tsx': 'typescriptreact',
        '.js': 'javascript', '.jsx': 'javascriptreact',
        '.json': 'json', '.md': 'markdown', '.py': 'python',
        '.go': 'go', '.rs': 'rust', '.java': 'java', '.cs': 'csharp',
        '.html': 'html', '.css': 'css', '.scss': 'scss',
        '.yml': 'yaml', '.yaml': 'yaml', '.sh': 'shellscript', '.ps1': 'powershell'
    } as Record<string, string>)[ext] ?? 'plaintext';
}

// ---------- read_file ----------
async function readFile(args: any, ctx: ToolContext): Promise<ToolResult> {
    try {
        const rel = asString(args.path, 'path');
        const abs = resolveSafe(rel);
        const data = await vscode.workspace.fs.readFile(vscode.Uri.file(abs));
        const startLine = typeof args.start_line === 'number' ? Math.max(1, args.start_line | 0) : undefined;
        const endLine = typeof args.end_line === 'number' ? Math.max(1, args.end_line | 0) : undefined;
        const limit = typeof args.limit === 'number' ? Math.max(1, args.limit | 0) : undefined;
        const fullText = Buffer.from(data).toString('utf8');

        let body: string;
        let summary: string;
        if (startLine !== undefined || endLine !== undefined || limit !== undefined) {
            const lines = fullText.split(/\r?\n/);
            const s = (startLine ?? 1) - 1;
            const e = endLine !== undefined ? endLine : (limit !== undefined ? s + limit : lines.length);
            const slice = lines.slice(s, e);
            const numbered = slice.map((ln, i) => `${(s + i + 1).toString().padStart(5, ' ')}  ${ln}`).join('\n');
            body = numbered;
            summary = `Read ${rel} lines ${s + 1}-${Math.min(e, lines.length)} of ${lines.length}`;
        } else if (data.byteLength > ctx.maxFileBytes) {
            body = Buffer.from(data).slice(0, ctx.maxFileBytes).toString('utf8') +
                `\n\n[truncated to ${ctx.maxFileBytes} of ${data.byteLength} bytes — pass start_line/end_line or limit for ranged reads]`;
            summary = `Read ${rel} (truncated, ${data.byteLength} bytes)`;
        } else {
            body = fullText;
            summary = `Read ${rel} (${data.byteLength} bytes)`;
        }

        if (ctx.safety.scrubSecrets) body = scrubSecrets(body);
        return ok(summary, body);
    } catch (e: any) { return err(e?.message ?? String(e)); }
}

// ---------- secret scrubbing ----------
const SECRET_PATTERNS: RegExp[] = [
    /\bAKIA[0-9A-Z]{16}\b/g,                                    // AWS access key id
    /\bASIA[0-9A-Z]{16}\b/g,                                    // AWS temp keys
    /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,                          // GitHub tokens
    /\bsk-ant-(?:api03|admin01)-[A-Za-z0-9_\-]{80,}\b/g,        // Anthropic
    /\bsk-(?:proj-)?[A-Za-z0-9_\-]{40,}\b/g,                    // OpenAI
    /\bxox[bpoa]-[A-Za-z0-9-]{10,}\b/g,                         // Slack
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT-ish
];
const SECRET_KV_RE = /(["']?(?:api[_-]?key|secret|token|password|passwd|pwd|access[_-]?key)["']?\s*[:=]\s*["'])([^"'\s]{8,})(["'])/gi;

function scrubSecrets(text: string): string {
    let out = text;
    for (const re of SECRET_PATTERNS) out = out.replace(re, '[REDACTED]');
    out = out.replace(SECRET_KV_RE, (_, p, _v, q) => `${p}[REDACTED]${q}`);
    return out;
}

// ---------- write_file ----------
const writeFilePlanner: ToolPlanner = async (args) => {
    const rel = asString(args.path, 'path');
    const content = asString(args.content, 'content');
    const abs = resolveSafe(rel);
    const uri = vscode.Uri.file(abs);
    const before = await readIfExists(uri);
    const plan: DiffPlan = {
        relPath: rel,
        before: before ?? '',
        after: content,
        isNew: before === undefined,
        languageId: languageIdFor(rel)
    };
    return {
        plans: [plan],
        commit: async () => {
            try {
                await ensureDir(abs);
                await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
                return ok(`Wrote ${rel} (${Buffer.byteLength(content, 'utf8')} bytes)`);
            } catch (e: any) { return err(e?.message ?? String(e)); }
        }
    };
};

// ---------- edit_file ----------
function applyEdit(original: string, oldStr: string, newStr: string, replaceAll: boolean): { updated: string; count: number } {
    if (oldStr.length === 0) throw new Error('old_string cannot be empty.');
    let count = 0;
    let idx = 0;
    while ((idx = original.indexOf(oldStr, idx)) !== -1) { count++; idx += oldStr.length; }
    if (count === 0) throw new Error(`old_string not found.`);
    if (!replaceAll && count > 1) throw new Error(`old_string occurs ${count} times; pass replace_all=true or include more context.`);
    const updated = replaceAll ? original.split(oldStr).join(newStr) : original.replace(oldStr, newStr);
    return { updated, count: replaceAll ? count : 1 };
}

const editFilePlanner: ToolPlanner = async (args) => {
    const rel = asString(args.path, 'path');
    const oldStr = asString(args.old_string, 'old_string');
    const newStr = asString(args.new_string, 'new_string');
    const replaceAll = args.replace_all === true;
    const abs = resolveSafe(rel);
    const uri = vscode.Uri.file(abs);
    const before = await readIfExists(uri);
    if (before === undefined) throw new Error(`File ${rel} does not exist.`);
    const { updated, count } = applyEdit(before, oldStr, newStr, replaceAll);
    const plan: DiffPlan = { relPath: rel, before, after: updated, isNew: false, languageId: languageIdFor(rel) };
    return {
        plans: [plan],
        commit: async () => {
            try {
                await vscode.workspace.fs.writeFile(uri, Buffer.from(updated, 'utf8'));
                return ok(`Edited ${rel} (${count} replacement${count === 1 ? '' : 's'})`);
            } catch (e: any) { return err(e?.message ?? String(e)); }
        }
    };
};

// ---------- apply_patch ----------
// Two input modes:
//   1) edits: [{path, old_string, new_string, replace_all?}, ...]   (preferred)
//   2) diff:  unified-diff string covering one or more files
interface ResolvedPatch { rel: string; abs: string; uri: vscode.Uri; before: string; after: string; isNew: boolean; }

function parseUnifiedDiff(diff: string): { rel: string; hunks: { contextHeader: string; lines: string[] }[] }[] {
    const files: { rel: string; hunks: { contextHeader: string; lines: string[] }[] }[] = [];
    const lines = diff.split(/\r?\n/);
    let cur: { rel: string; hunks: { contextHeader: string; lines: string[] }[] } | undefined;
    let curHunk: { contextHeader: string; lines: string[] } | undefined;
    for (const ln of lines) {
        if (ln.startsWith('+++ ')) {
            const raw = ln.slice(4).trim();
            const rel = raw.replace(/^b\//, '').replace(/^"|"$/g, '');
            if (rel === '/dev/null') continue;
            cur = { rel, hunks: [] };
            files.push(cur);
            curHunk = undefined;
        } else if (ln.startsWith('--- ')) {
            // ignore; +++ defines target
        } else if (ln.startsWith('@@')) {
            if (!cur) continue;
            curHunk = { contextHeader: ln, lines: [] };
            cur.hunks.push(curHunk);
        } else if (curHunk) {
            if (ln.startsWith('+') || ln.startsWith('-') || ln.startsWith(' ')) {
                curHunk.lines.push(ln);
            } else if (ln.startsWith('\\')) {
                // "\ No newline at end of file" — ignore
            }
        }
    }
    return files;
}

function applyHunkToText(original: string, hunk: { lines: string[] }): string {
    const oldBlock: string[] = [];
    const newBlock: string[] = [];
    for (const ln of hunk.lines) {
        const tag = ln[0];
        const rest = ln.slice(1);
        if (tag === ' ') { oldBlock.push(rest); newBlock.push(rest); }
        else if (tag === '-') { oldBlock.push(rest); }
        else if (tag === '+') { newBlock.push(rest); }
    }
    const oldStr = oldBlock.join('\n');
    const newStr = newBlock.join('\n');
    if (oldStr.length === 0) {
        return original.length === 0 ? newStr : newStr + '\n' + original;
    }
    const idx = original.indexOf(oldStr);
    if (idx === -1) {
        const idx2 = original.indexOf(oldStr + '\n');
        if (idx2 === -1) throw new Error(`Hunk context not found:\n${oldStr.slice(0, 200)}`);
        return original.slice(0, idx2) + newStr + '\n' + original.slice(idx2 + oldStr.length + 1);
    }
    if (original.indexOf(oldStr, idx + 1) !== -1) {
        throw new Error(`Hunk context is ambiguous (matches more than once). Add more context lines.`);
    }
    return original.slice(0, idx) + newStr + original.slice(idx + oldStr.length);
}

const applyPatchPlanner: ToolPlanner = async (args) => {
    const resolved: ResolvedPatch[] = [];

    if (Array.isArray(args.edits) && args.edits.length > 0) {
        for (const e of args.edits) {
            const rel = asString(e.path, 'edits[].path');
            const oldStr = asString(e.old_string, 'edits[].old_string');
            const newStr = asString(e.new_string, 'edits[].new_string');
            const replaceAll = e.replace_all === true;
            const abs = resolveSafe(rel);
            const uri = vscode.Uri.file(abs);
            const before = await readIfExists(uri);
            if (before === undefined) throw new Error(`File ${rel} does not exist for edit.`);
            const { updated } = applyEdit(before, oldStr, newStr, replaceAll);
            resolved.push({ rel, abs, uri, before, after: updated, isNew: false });
        }
    } else if (typeof args.diff === 'string' && args.diff.trim().length > 0) {
        const files = parseUnifiedDiff(args.diff);
        if (files.length === 0) throw new Error('No file headers (+++ b/path) found in diff.');
        for (const f of files) {
            const abs = resolveSafe(f.rel);
            const uri = vscode.Uri.file(abs);
            const beforeMaybe = await readIfExists(uri);
            const before = beforeMaybe ?? '';
            let after = before;
            for (const h of f.hunks) after = applyHunkToText(after, h);
            resolved.push({ rel: f.rel, abs, uri, before, after, isNew: beforeMaybe === undefined });
        }
    } else {
        throw new Error('apply_patch requires either "edits" (array) or "diff" (unified-diff string).');
    }

    const plans: DiffPlan[] = resolved.map(r => ({
        relPath: r.rel, before: r.before, after: r.after, isNew: r.isNew, languageId: languageIdFor(r.rel)
    }));

    return {
        plans,
        commit: async () => {
            const written: string[] = [];
            try {
                for (const r of resolved) {
                    await ensureDir(r.abs);
                    await vscode.workspace.fs.writeFile(r.uri, Buffer.from(r.after, 'utf8'));
                    written.push(r.rel);
                }
                return ok(`apply_patch wrote ${written.length} file(s)`, written.join('\n'));
            } catch (e: any) { return err(`After writing ${written.join(', ')}: ${e?.message ?? e}`); }
        }
    };
};

// ---------- delete_file ----------
async function deleteFile(args: any): Promise<ToolResult> {
    try {
        const rel = asString(args.path, 'path');
        const abs = resolveSafe(rel);
        await vscode.workspace.fs.delete(vscode.Uri.file(abs), { recursive: true, useTrash: true });
        return ok(`Deleted ${rel} (moved to trash)`);
    } catch (e: any) { return err(e?.message ?? String(e)); }
}

// ---------- list_directory ----------
async function listDirectory(args: any): Promise<ToolResult> {
    try {
        const rel = typeof args?.path === 'string' && args.path.length > 0 ? args.path : '.';
        const abs = resolveSafe(rel);
        const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(abs));
        entries.sort((a, b) => a[0].localeCompare(b[0]));
        const lines = entries.map(([name, type]) => {
            const tag = type === vscode.FileType.Directory ? 'dir ' : type === vscode.FileType.SymbolicLink ? 'link' : 'file';
            return `${tag}  ${name}`;
        });
        return ok(`${entries.length} entries in ${rel}`, lines.join('\n'));
    } catch (e: any) { return err(e?.message ?? String(e)); }
}

// ---------- glob_files ----------
async function globFiles(args: any): Promise<ToolResult> {
    try {
        const pattern = asString(args.pattern, 'pattern');
        const max = typeof args.max === 'number' ? args.max : 200;
        const uris = await vscode.workspace.findFiles(pattern, '**/node_modules/**', max);
        const root = workspaceRoot();
        const rels = uris.map(u => path.relative(root, u.fsPath).replace(/\\/g, '/')).sort();
        return ok(`Found ${rels.length} files for pattern "${pattern}"`, rels.join('\n') || '(no matches)');
    } catch (e: any) { return err(e?.message ?? String(e)); }
}

// ---------- search_text ----------
async function searchText(args: any): Promise<ToolResult> {
    try {
        const query = asString(args.query, 'query');
        const isRegex = args.regex === true;
        const include = typeof args.include === 'string' ? args.include : undefined;
        const maxResults = typeof args.max_results === 'number' ? args.max_results : 200;
        const re = isRegex ? new RegExp(query) : new RegExp(escapeRegex(query));
        const includePattern = include ?? '**/*';
        const uris = await vscode.workspace.findFiles(includePattern, '**/node_modules/**', 5000);
        const root = workspaceRoot();
        const out: string[] = [];
        let total = 0;
        for (const uri of uris) {
            if (total >= maxResults) break;
            try {
                const stat = await vscode.workspace.fs.stat(uri);
                if (stat.size > 1_000_000) continue;
                const data = await vscode.workspace.fs.readFile(uri);
                const text = Buffer.from(data).toString('utf8');
                const lines = text.split(/\r?\n/);
                const rel = path.relative(root, uri.fsPath).replace(/\\/g, '/');
                for (let i = 0; i < lines.length && total < maxResults; i++) {
                    if (re.test(lines[i])) { out.push(`${rel}:${i + 1}: ${lines[i].slice(0, 300)}`); total++; }
                }
            } catch { /* skip */ }
        }
        return ok(`${total} matches for ${isRegex ? 'regex ' : ''}"${query}"`, out.join('\n') || '(no matches)');
    } catch (e: any) { return err(e?.message ?? String(e)); }
}
function escapeRegex(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ---------- run_command ----------
async function runCommand(args: any, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.workspaceTrusted) {
        return err('Workspace is not trusted. Open the folder with "Trust" or run on a trusted workspace before using run_command.');
    }
    try {
        const command = asString(args.command, 'command');
        const cwdRel = typeof args.cwd === 'string' && args.cwd.length > 0 ? args.cwd : '.';
        const cwd = resolveSafe(cwdRel);
        const shellChoice = pickShell(args.shell, ctx.allowedShells);
        if (!shellChoice) return err(`Shell not allowed. Allowed: ${ctx.allowedShells.join(', ')}`);

        return await new Promise<ToolResult>((resolve) => {
            let stdout = '';
            let stderr = '';
            let killedByTimeout = false;
            const child = spawn(shellChoice.exe, shellArgs(shellChoice.name, command), {
                cwd, env: process.env, windowsHide: true
            });
            const timer = setTimeout(() => {
                killedByTimeout = true;
                try { child.kill('SIGKILL'); } catch { /* ignore */ }
            }, ctx.commandTimeoutMs);

            const onAbort = () => { try { child.kill('SIGKILL'); } catch { /* ignore */ } };
            ctx.signal?.addEventListener('abort', onAbort, { once: true });

            child.stdout.on('data', (chunk: Buffer) => {
                const t = chunk.toString('utf8');
                stdout += t;
                if (stdout.length > 5 * 1024 * 1024) stdout = stdout.slice(-5 * 1024 * 1024);
                ctx.onEvent?.('stdout', t);
            });
            child.stderr.on('data', (chunk: Buffer) => {
                const t = chunk.toString('utf8');
                stderr += t;
                if (stderr.length > 5 * 1024 * 1024) stderr = stderr.slice(-5 * 1024 * 1024);
                ctx.onEvent?.('stderr', t);
            });
            child.on('error', (e) => {
                clearTimeout(timer);
                ctx.signal?.removeEventListener('abort', onAbort);
                resolve(err(`spawn failed: ${e?.message ?? e}`));
            });
            child.on('close', (code, signal) => {
                clearTimeout(timer);
                ctx.signal?.removeEventListener('abort', onAbort);
                const exitCode = code ?? (signal ? 128 : 0);
                const head = `exit=${exitCode}${killedByTimeout ? ' (timeout)' : signal ? ` (signal: ${signal})` : ''}  shell=${shellChoice.name}  cwd=${cwdRel}`;
                let outBody = truncate(stdout, 20000);
                let errBody = truncate(stderr, 20000);
                if (ctx.safety.scrubSecrets) {
                    outBody = scrubSecrets(outBody);
                    errBody = scrubSecrets(errBody);
                }
                const body = [
                    head,
                    outBody ? `--- stdout ---\n${outBody}` : '',
                    errBody ? `--- stderr ---\n${errBody}` : ''
                ].filter(Boolean).join('\n');
                resolve({ ok: exitCode === 0, summary: `Ran \`${truncate(command, 80)}\` → exit ${exitCode}`, content: body });
            });
        });
    } catch (e: any) { return err(e?.message ?? String(e)); }
}

function shellArgs(shellName: string, command: string): string[] {
    if (shellName === 'cmd') return ['/d', '/s', '/c', command];
    if (shellName === 'pwsh' || shellName === 'powershell') {
        return ['-NoProfile', '-NonInteractive', '-Command', command];
    }
    return ['-c', command];
}

interface ShellChoice { name: string; exe: string; }
function pickShell(requested: unknown, allowed: string[]): ShellChoice | undefined {
    const norm = (s: string) => s.toLowerCase();
    const allowedNorm = allowed.map(norm);
    let want: string | undefined;
    if (typeof requested === 'string' && requested.length > 0) want = norm(requested);
    const candidates: ShellChoice[] = process.platform === 'win32'
        ? [{ name: 'pwsh', exe: 'pwsh.exe' }, { name: 'powershell', exe: 'powershell.exe' }, { name: 'cmd', exe: 'cmd.exe' }]
        : [{ name: 'bash', exe: '/bin/bash' }, { name: 'sh', exe: '/bin/sh' }];
    if (want) {
        const m = candidates.find(c => c.name === want);
        return m && allowedNorm.includes(m.name) ? m : undefined;
    }
    return candidates.find(c => allowedNorm.includes(c.name));
}
function truncate(s: string, max: number): string { return s.length <= max ? s : s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`; }

// ---------- get_diagnostics ----------
async function getDiagnostics(args: any): Promise<ToolResult> {
    try {
        const rel = typeof args?.path === 'string' && args.path.length > 0 ? args.path : undefined;
        const root = workspaceRoot();
        const all: { uri: vscode.Uri; diags: vscode.Diagnostic[] }[] = [];
        if (rel) {
            const uri = vscode.Uri.file(resolveSafe(rel));
            all.push({ uri, diags: vscode.languages.getDiagnostics(uri) });
        } else {
            for (const [uri, diags] of vscode.languages.getDiagnostics()) {
                if (diags.length > 0) all.push({ uri, diags });
            }
        }
        const lines: string[] = [];
        let total = 0;
        for (const { uri, diags } of all) {
            const r = path.relative(root, uri.fsPath).replace(/\\/g, '/');
            for (const d of diags) {
                lines.push(`${r}:${d.range.start.line + 1}:${d.range.start.character + 1}  ${vscode.DiagnosticSeverity[d.severity]}  ${d.message}`);
                total++;
                if (total >= 200) break;
            }
            if (total >= 200) break;
        }
        return ok(`${total} diagnostics`, lines.join('\n') || '(none)');
    } catch (e: any) { return err(e?.message ?? String(e)); }
}

// ---------- get_workspace_info ----------
async function workspaceInfo(): Promise<ToolResult> {
    try {
        const root = workspaceRoot();
        const folders = vscode.workspace.workspaceFolders ?? [];
        const editor = vscode.window.activeTextEditor;
        const lines: string[] = [];
        lines.push(`platform: ${process.platform} (${os.release()})`);
        lines.push(`workspace_root: ${root}`);
        if (folders.length > 1) { lines.push('extra_folders:'); for (const f of folders.slice(1)) lines.push(`  - ${f.uri.fsPath}`); }
        if (editor) {
            const rel = path.relative(root, editor.document.uri.fsPath).replace(/\\/g, '/');
            const sel = editor.selection;
            lines.push(`active_file: ${rel}`);
            lines.push(`active_language: ${editor.document.languageId}`);
            lines.push(`cursor: line ${sel.active.line + 1}, col ${sel.active.character + 1}`);
            if (!sel.isEmpty) lines.push(`selection: ${sel.start.line + 1}:${sel.start.character + 1} - ${sel.end.line + 1}:${sel.end.character + 1}`);
        } else {
            lines.push('active_file: (none)');
        }
        return ok('Workspace info', lines.join('\n'));
    } catch (e: any) { return err(e?.message ?? String(e)); }
}

// ---------- find_symbols ----------
// Uses VS Code's workspace symbol provider — same data the Ctrl+T fuzzy
// finder uses. Far better than text search for "where is class Foo / function
// bar defined?" questions because it asks the language servers, not regex.
async function findSymbols(args: any): Promise<ToolResult> {
    try {
        const query = asString(args.query, 'query');
        const max = typeof args.max === 'number' ? Math.min(args.max, 500) : 100;
        const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
            'vscode.executeWorkspaceSymbolProvider', query
        );
        const root = workspaceRoot();
        const list = (symbols ?? []).slice(0, max).map(s => {
            const rel = path.relative(root, s.location.uri.fsPath).replace(/\\/g, '/');
            const r = s.location.range;
            const kind = vscode.SymbolKind[s.kind];
            const container = s.containerName ? `  (in ${s.containerName})` : '';
            return `${rel}:${r.start.line + 1}:${r.start.character + 1}  ${kind}  ${s.name}${container}`;
        });
        return ok(`${list.length} symbols matching "${query}"`, list.join('\n') || '(no matches — language server may still be indexing)');
    } catch (e: any) { return err(e?.message ?? String(e)); }
}

// ---------- web helpers ----------
interface HttpResponse { status: number; headers: Record<string, string>; body: Buffer; finalUrl: string; }

async function httpRequest(opts: {
    url: string; timeoutMs: number; maxBytes: number;
    method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string;
    redirects?: number; proxyUrl?: string;
}): Promise<HttpResponse> {
    const maxRedirects = opts.redirects ?? 5;
    let url = opts.url;
    let method = opts.method ?? 'GET';
    let body = opts.body;
    for (let i = 0; i <= maxRedirects; i++) {
        const res = await singleRequest({ ...opts, url, method, body });
        if (res.location && i < maxRedirects) {
            const next = new URL(res.location, url).toString();
            if (method === 'POST' && res.status !== 307 && res.status !== 308) {
                method = 'GET';
                body = undefined;
            }
            url = next;
            continue;
        }
        return { status: res.status, headers: res.headers, body: res.body, finalUrl: url };
    }
    throw new Error(`Too many redirects (>${maxRedirects})`);
}

async function singleRequest(opts: {
    url: string; timeoutMs: number; maxBytes: number;
    method: 'GET' | 'POST'; headers?: Record<string, string>; body?: string;
    proxyUrl?: string;
}): Promise<{ status: number; headers: Record<string, string>; body: Buffer; location?: string }> {
    return new Promise((resolve, reject) => {
        let target: URL;
        try { target = new URL(opts.url); } catch { return reject(new Error(`Invalid URL: ${opts.url}`)); }
        if (target.protocol !== 'http:' && target.protocol !== 'https:') {
            return reject(new Error(`Unsupported protocol: ${target.protocol}`));
        }
        const headers: Record<string, string> = {
            'User-Agent': 'AzureAIAgent/1.1 (+vscode-extension)',
            'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5',
            'Accept-Language': 'en-US,en;q=0.5',
            'Accept-Encoding': 'identity',
            ...(opts.body ? { 'Content-Length': String(Buffer.byteLength(opts.body, 'utf8')) } : {}),
            ...(opts.headers ?? {})
        };

        const proxy = opts.proxyUrl ? safeParseUrl(opts.proxyUrl) : undefined;

        const startResponse = (sendReq: () => any) => {
            const req = sendReq();
            req.on('timeout', () => req.destroy(new Error(`Request timed out after ${opts.timeoutMs}ms`)));
            req.on('error', reject);
            if (opts.body) req.write(opts.body);
            req.end();
        };

        const onResponse = (response: any) => {
            const status = response.statusCode ?? 0;
            const respHeaders: Record<string, string> = {};
            for (const [k, v] of Object.entries(response.headers)) {
                if (typeof v === 'string') respHeaders[k.toLowerCase()] = v;
                else if (Array.isArray(v)) respHeaders[k.toLowerCase()] = (v as string[]).join(', ');
            }
            if (status >= 300 && status < 400 && respHeaders['location']) {
                response.resume();
                resolve({ status, headers: respHeaders, body: Buffer.alloc(0), location: respHeaders['location'] });
                return;
            }
            const chunks: Buffer[] = [];
            let bytes = 0;
            response.on('data', (c: Buffer) => {
                if (bytes + c.length > opts.maxBytes) {
                    chunks.push(c.subarray(0, opts.maxBytes - bytes));
                    bytes = opts.maxBytes;
                    response.destroy();
                } else {
                    chunks.push(c);
                    bytes += c.length;
                }
            });
            response.on('end', () => resolve({ status, headers: respHeaders, body: Buffer.concat(chunks) }));
            response.on('error', reject);
        };

        if (proxy && target.protocol === 'http:') {
            // Plain HTTP through HTTP proxy: send absolute URI as path.
            startResponse(() => http.request({
                method: opts.method,
                hostname: proxy.hostname,
                port: proxy.port || 80,
                path: opts.url,
                headers: { ...headers, Host: target.host },
                timeout: opts.timeoutMs
            }, onResponse));
        } else if (proxy && target.protocol === 'https:') {
            // HTTPS through HTTP proxy: CONNECT tunnel, then https.request over the socket.
            const connectReq = http.request({
                method: 'CONNECT',
                hostname: proxy.hostname,
                port: proxy.port || 80,
                path: `${target.hostname}:${target.port || 443}`,
                headers: { Host: `${target.hostname}:${target.port || 443}` },
                timeout: opts.timeoutMs
            });
            connectReq.on('connect', (proxyRes: any, socket: any) => {
                if (proxyRes.statusCode !== 200) {
                    socket.destroy();
                    reject(new Error(`Proxy CONNECT failed: ${proxyRes.statusCode}`));
                    return;
                }
                startResponse(() => https.request({
                    method: opts.method,
                    hostname: target.hostname,
                    port: Number(target.port) || 443,
                    path: (target.pathname || '/') + target.search,
                    headers,
                    createConnection: () => socket,
                    agent: false,
                    timeout: opts.timeoutMs
                } as any, onResponse));
            });
            connectReq.on('error', reject);
            connectReq.on('timeout', () => connectReq.destroy(new Error('Proxy CONNECT timed out')));
            connectReq.end();
        } else {
            const lib = target.protocol === 'http:' ? http : https;
            startResponse(() => lib.request({
                method: opts.method,
                hostname: target.hostname,
                port: target.port || (target.protocol === 'https:' ? 443 : 80),
                path: (target.pathname || '/') + target.search,
                headers,
                timeout: opts.timeoutMs
            }, onResponse));
        }
    });
}

function safeParseUrl(s: string): URL | undefined {
    try { return new URL(s); } catch { return undefined; }
}

function htmlToText(html: string): string {
    let s = html;
    s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
         .replace(/<style[\s\S]*?<\/style>/gi, ' ')
         .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
         .replace(/<!--[\s\S]*?-->/g, ' ');
    // Prefer the main / article / body region for readability.
    const main = s.match(/<main\b[\s\S]*?<\/main>/i)?.[0]
        ?? s.match(/<article\b[\s\S]*?<\/article>/i)?.[0]
        ?? s.match(/<body\b[\s\S]*?<\/body>/i)?.[0]
        ?? s;
    s = main;
    // Convert structural tags to whitespace before stripping.
    s = s.replace(/<\/(p|div|section|article|header|footer|nav|aside|li|tr|h[1-6]|pre|blockquote)>/gi, '\n')
         .replace(/<br\s*\/?\s*>/gi, '\n')
         .replace(/<\/(td|th)>/gi, '\t')
         .replace(/<li\b[^>]*>/gi, '- ')
         .replace(/<h[1-6]\b[^>]*>/gi, '\n# ');
    s = s.replace(/<[^>]+>/g, '');
    s = s.replace(/&nbsp;/g, ' ')
         .replace(/&amp;/g, '&')
         .replace(/&lt;/g, '<')
         .replace(/&gt;/g, '>')
         .replace(/&quot;/g, '"')
         .replace(/&apos;/g, "'")
         .replace(/&#39;/g, "'")
         .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
         .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
    s = s.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
    return s.split('\n').map(l => l.trim()).join('\n').trim();
}

function hostMatches(host: string, pattern: string): boolean {
    const h = host.toLowerCase();
    const p = pattern.toLowerCase().trim();
    if (!p) return false;
    if (p.startsWith('*.')) {
        const suffix = p.slice(2);
        return h === suffix || h.endsWith('.' + suffix);
    }
    return h === p || h.endsWith('.' + p);
}

async function checkWebPolicy(url: string, web: WebContext): Promise<string | undefined> {
    let u: URL;
    try { u = new URL(url); } catch { return `Invalid URL: ${url}`; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return `Only http(s) URLs allowed (got ${u.protocol}).`;
    const host = u.hostname.toLowerCase();
    if (web.blockedDomains.some(d => hostMatches(host, d))) return `Domain ${host} is blocked by webBrowsing.blockedDomains.`;
    if (web.allowedDomains.length > 0) {
        if (!web.allowedDomains.some(d => hostMatches(host, d))) {
            return `Domain ${host} is not in webBrowsing.allowedDomains.`;
        }
        return undefined;
    }
    // No static allowlist — ask the user the first time we see this host this session.
    if (web.sessionAllowedHosts.has(host)) return undefined;
    if (web.promptForHost) {
        const approved = await web.promptForHost(host);
        if (approved) {
            web.sessionAllowedHosts.add(host);
            return undefined;
        }
        return `User denied web access to ${host}.`;
    }
    return undefined;
}

// ---------- web_fetch ----------
async function webFetch(args: any, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.web.enabled) return err('Web browsing is disabled (azure-ai-agent.webBrowsing.enabled).');
    try {
        const url = asString(args.url, 'url');
        const policyError = await checkWebPolicy(url, ctx.web);
        if (policyError) return err(policyError);
        const raw = args.raw === true;
        const maxBytes = typeof args.max_bytes === 'number' ? Math.min(args.max_bytes, ctx.web.maxBytes) : ctx.web.maxBytes;
        const timeoutMs = typeof args.timeout_ms === 'number' ? Math.min(args.timeout_ms, ctx.web.timeoutMs) : ctx.web.timeoutMs;
        const res = await httpRequest({ url, timeoutMs, maxBytes, proxyUrl: ctx.web.proxyUrl });
        const ctype = (res.headers['content-type'] ?? '').toLowerCase();
        const text = res.body.toString('utf8');
        let body = text;
        if (!raw) {
            if (ctype.includes('json')) {
                try { body = JSON.stringify(JSON.parse(text), null, 2); } catch { /* keep raw */ }
            } else if (ctype.includes('html') || ctype.includes('xml')) {
                body = htmlToText(text);
            }
        }
        const head = `URL: ${res.finalUrl}\nStatus: ${res.status}\nContent-Type: ${ctype || '(none)'}\nBytes: ${res.body.byteLength}`;
        const ok2 = res.status >= 200 && res.status < 400;
        return {
            ok: ok2,
            summary: `Fetched ${new URL(res.finalUrl).host} → ${res.status} (${res.body.byteLength} bytes)`,
            content: `${head}\n\n${body}`
        };
    } catch (e: any) { return err(e?.message ?? String(e)); }
}

// ---------- web_search ----------
async function webSearch(args: any, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.web.enabled) return err('Web browsing is disabled (azure-ai-agent.webBrowsing.enabled).');
    try {
        const query = asString(args.query, 'query');
        const max = typeof args.max_results === 'number' ? Math.min(Math.max(args.max_results, 1), 20) : 8;
        switch (ctx.web.searchProvider) {
            case 'tavily':
                if (!ctx.web.searchApiKey) return err('Tavily search requires an API key (run "Azure AI: Set Web Search API Key").');
                return await searchTavily(query, max, ctx);
            case 'brave':
                if (!ctx.web.searchApiKey) return err('Brave search requires an API key (run "Azure AI: Set Web Search API Key").');
                return await searchBrave(query, max, ctx);
            case 'duckduckgo':
            default:
                return await searchDuckDuckGo(query, max, ctx);
        }
    } catch (e: any) { return err(e?.message ?? String(e)); }
}

interface SearchResult { title: string; url: string; snippet: string; }
function formatResults(provider: string, query: string, results: SearchResult[]): ToolResult {
    if (results.length === 0) return ok(`${provider}: 0 results for "${query}"`, '(no results)');
    const out = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`).join('\n\n');
    return ok(`${provider}: ${results.length} results for "${query}"`, out);
}

async function searchDuckDuckGo(query: string, max: number, ctx: ToolContext): Promise<ToolResult> {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await httpRequest({ url, timeoutMs: ctx.web.timeoutMs, maxBytes: 2_000_000, proxyUrl: ctx.web.proxyUrl });
    if (res.status >= 400) return err(`DuckDuckGo HTTP ${res.status}`);
    const html = res.body.toString('utf8');

    const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

    const links: { title: string; url: string }[] = [];
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(html)) && links.length < max) {
        let href = m[1];
        try {
            const u = new URL(href, 'https://html.duckduckgo.com');
            const uddg = u.searchParams.get('uddg');
            if (uddg) href = decodeURIComponent(uddg);
            else href = u.toString();
        } catch { /* keep raw */ }
        const title = htmlToText(m[2]).replace(/\s+/g, ' ').trim();
        if (title) links.push({ title, url: href });
    }
    const snippets: string[] = [];
    while ((m = snippetRe.exec(html)) && snippets.length < links.length) {
        snippets.push(htmlToText(m[1]).replace(/\s+/g, ' ').trim());
    }
    const results: SearchResult[] = links.map((l, i) => ({ title: l.title, url: l.url, snippet: snippets[i] ?? '' }));
    return formatResults('DuckDuckGo', query, results);
}

async function searchTavily(query: string, max: number, ctx: ToolContext): Promise<ToolResult> {
    const body = JSON.stringify({ api_key: ctx.web.searchApiKey, query, max_results: max, search_depth: 'basic', include_answer: false });
    const res = await httpRequest({
        url: 'https://api.tavily.com/search', method: 'POST', body,
        headers: { 'Content-Type': 'application/json' },
        timeoutMs: ctx.web.timeoutMs, maxBytes: 1_000_000, proxyUrl: ctx.web.proxyUrl
    });
    if (res.status >= 400) return err(`Tavily HTTP ${res.status}: ${res.body.toString('utf8').slice(0, 500)}`);
    const json = JSON.parse(res.body.toString('utf8'));
    const items: any[] = Array.isArray(json.results) ? json.results : [];
    const results: SearchResult[] = items.map(r => ({
        title: String(r.title ?? r.url ?? ''),
        url: String(r.url ?? ''),
        snippet: String(r.content ?? '').replace(/\s+/g, ' ').slice(0, 400)
    }));
    return formatResults('Tavily', query, results);
}

async function searchBrave(query: string, max: number, ctx: ToolContext): Promise<ToolResult> {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${max}`;
    const res = await httpRequest({
        url,
        headers: { 'X-Subscription-Token': ctx.web.searchApiKey, 'Accept': 'application/json' },
        timeoutMs: ctx.web.timeoutMs, maxBytes: 1_000_000, proxyUrl: ctx.web.proxyUrl
    });
    if (res.status >= 400) return err(`Brave HTTP ${res.status}: ${res.body.toString('utf8').slice(0, 500)}`);
    const json = JSON.parse(res.body.toString('utf8'));
    const items: any[] = json?.web?.results ?? [];
    const results: SearchResult[] = items.slice(0, max).map(r => ({
        title: String(r.title ?? r.url ?? ''),
        url: String(r.url ?? ''),
        snippet: String(r.description ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').slice(0, 400)
    }));
    return formatResults('Brave', query, results);
}

// ---------- update_todos ----------
// Stateless: model passes the full list each time. Tool emits a `status` event
// the UI renders as a checklist. Encourages structured planning on long tasks.
async function updateTodos(args: any, ctx: ToolContext): Promise<ToolResult> {
    try {
        const items = Array.isArray(args.items) ? args.items : [];
        const list = items.map((it: any, i: number) => {
            const text = typeof it?.text === 'string' ? it.text : `(item ${i + 1})`;
            const status = String(it?.status ?? 'pending');
            return { text, status };
        });
        ctx.onEvent?.('status', `__todos__:${JSON.stringify(list)}`);
        const fmt = list.map((t: { status: string; text: string }) => {
            const box = t.status === 'done' ? '[x]' : t.status === 'in_progress' ? '[~]' : '[ ]';
            return `${box} ${t.text}`;
        }).join('\n');
        return ok(`${list.length} todos`, fmt || '(empty)');
    } catch (e: any) { return err(e?.message ?? String(e)); }
}

// ---------- get_definition / get_references ----------
async function getDefinition(args: any): Promise<ToolResult> {
    try {
        const rel = asString(args.path, 'path');
        const line = typeof args.line === 'number' ? Math.max(1, args.line | 0) : 1;
        const col = typeof args.character === 'number' ? Math.max(1, args.character | 0) : 1;
        const uri = vscode.Uri.file(resolveSafe(rel));
        const pos = new vscode.Position(line - 1, col - 1);
        const locs = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
            'vscode.executeDefinitionProvider', uri, pos
        );
        return formatLocations('definition', rel, line, col, locs ?? []);
    } catch (e: any) { return err(e?.message ?? String(e)); }
}

async function getReferences(args: any): Promise<ToolResult> {
    try {
        const rel = asString(args.path, 'path');
        const line = typeof args.line === 'number' ? Math.max(1, args.line | 0) : 1;
        const col = typeof args.character === 'number' ? Math.max(1, args.character | 0) : 1;
        const uri = vscode.Uri.file(resolveSafe(rel));
        const pos = new vscode.Position(line - 1, col - 1);
        const locs = await vscode.commands.executeCommand<vscode.Location[]>(
            'vscode.executeReferenceProvider', uri, pos
        );
        return formatLocations('references', rel, line, col, locs ?? []);
    } catch (e: any) { return err(e?.message ?? String(e)); }
}

function formatLocations(kind: string, rel: string, line: number, col: number, locs: (vscode.Location | vscode.LocationLink)[]): ToolResult {
    const root = workspaceRoot();
    const items = (locs ?? []).map(loc => {
        const u = (loc as any).uri ?? (loc as any).targetUri;
        const r = (loc as any).range ?? (loc as any).targetRange ?? (loc as any).targetSelectionRange;
        const file = path.relative(root, u.fsPath).replace(/\\/g, '/');
        return `${file}:${r.start.line + 1}:${r.start.character + 1}`;
    });
    return ok(`${kind} of ${rel}:${line}:${col} → ${items.length} location(s)`, items.join('\n') || '(none)');
}

// ---------- run_task ----------
async function runTask(args: any, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.workspaceTrusted) return err('Workspace is not trusted; cannot run tasks.');
    try {
        const name = asString(args.name, 'name');
        const tasks = await vscode.tasks.fetchTasks();
        const match = tasks.find(t => t.name === name)
            ?? tasks.find(t => t.name.toLowerCase() === name.toLowerCase());
        if (!match) {
            const available = tasks.map(t => `- ${t.name} (${t.source})`).join('\n');
            return err(`Task "${name}" not found.\n\nAvailable:\n${available || '(none)'}`);
        }
        const exec = await vscode.tasks.executeTask(match);
        return await new Promise<ToolResult>((resolve) => {
            const disp = vscode.tasks.onDidEndTaskProcess((e) => {
                if (e.execution === exec) {
                    disp.dispose();
                    resolve({
                        ok: e.exitCode === 0,
                        summary: `Task "${name}" → exit ${e.exitCode}`,
                        content: `Task "${name}" finished with exit code ${e.exitCode}.`
                    });
                }
            });
            const timeoutDisp = setTimeout(() => {
                disp.dispose();
                resolve({ ok: false, summary: `Task "${name}" did not finish in time`, content: 'Timed out waiting for task to finish.' });
            }, ctx.commandTimeoutMs);
            ctx.signal?.addEventListener('abort', () => {
                clearTimeout(timeoutDisp); disp.dispose();
                try { exec.terminate(); } catch { /* ignore */ }
            }, { once: true });
        });
    } catch (e: any) { return err(e?.message ?? String(e)); }
}

// ---------- read_memory / write_memory ----------
const MEMORY_FILE = '.azure-ai-agent/memory.md';

async function readMemory(): Promise<ToolResult> {
    try {
        const abs = resolveSafe(MEMORY_FILE);
        const text = await readIfExists(vscode.Uri.file(abs));
        if (text === undefined) return ok('No memory file yet', '(empty — use write_memory to create one)');
        return ok(`Read ${MEMORY_FILE} (${Buffer.byteLength(text, 'utf8')} bytes)`, text);
    } catch (e: any) { return err(e?.message ?? String(e)); }
}

async function writeMemory(args: any): Promise<ToolResult> {
    try {
        const note = asString(args.note, 'note');
        const mode = args.mode === 'replace' ? 'replace' : 'append';
        const abs = resolveSafe(MEMORY_FILE);
        const uri = vscode.Uri.file(abs);
        await ensureDir(abs);
        const existing = (await readIfExists(uri)) ?? '';
        const stamp = new Date().toISOString().slice(0, 10);
        const next = mode === 'replace'
            ? note
            : (existing ? `${existing.replace(/\n+$/, '')}\n\n## ${stamp}\n${note}\n` : `# Project memory\n\n## ${stamp}\n${note}\n`);
        await vscode.workspace.fs.writeFile(uri, Buffer.from(next, 'utf8'));
        return ok(`${mode === 'replace' ? 'Replaced' : 'Appended to'} ${MEMORY_FILE}`, next.slice(-2000));
    } catch (e: any) { return err(e?.message ?? String(e)); }
}

// ---------- spawn_agent ----------
async function spawnAgent(args: any, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.spawnSubAgent) return err('Sub-agents are not available in this run.');
    try {
        const task = asString(args.task, 'task');
        const allowedTools = Array.isArray(args.allowed_tools) ? args.allowed_tools.filter((s: unknown) => typeof s === 'string') : undefined;
        const maxIter = typeof args.max_iterations === 'number' ? args.max_iterations : 10;
        const result = await ctx.spawnSubAgent({ task, allowedTools, maxIterations: maxIter, signal: ctx.signal });
        return ok(`Sub-agent finished`, result);
    } catch (e: any) { return err(e?.message ?? String(e)); }
}

async function listMcpTools(_args: any, ctx: ToolContext): Promise<ToolResult> {
    try {
        const items = ctx.listMcpTools?.() ?? [];
        if (items.length === 0) return ok('No MCP tools discovered', '(none)');
        const lines = items.map(t => `${t.serverId}: ${t.name}${t.description ? ` — ${t.description}` : ''}`);
        return ok(`${items.length} MCP tool(s) discovered`, lines.join('\n'));
    } catch (e: any) { return err(e?.message ?? String(e)); }
}

// ---------- registry ----------
export function buildToolRegistry(): Record<string, AgentTool> {
    return {
        read_file: {
            destructive: false, handler: readFile,
            spec: { type: 'function', function: { name: 'read_file', description: 'Read a UTF-8 text file from the workspace.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } } }
        },
        write_file: {
            destructive: true,
            handler: async (args, ctx) => (await writeFilePlanner(args, ctx)).commit(),
            plan: writeFilePlanner,
            spec: { type: 'function', function: { name: 'write_file', description: 'Create or overwrite a file with the given UTF-8 content. Parent directories are created.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false } } }
        },
        edit_file: {
            destructive: true,
            handler: async (args, ctx) => (await editFilePlanner(args, ctx)).commit(),
            plan: editFilePlanner,
            spec: { type: 'function', function: { name: 'edit_file', description: 'Replace exact text in a file. old_string must match unless replace_all=true.', parameters: { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['path', 'old_string', 'new_string'], additionalProperties: false } } }
        },
        apply_patch: {
            destructive: true,
            handler: async (args, ctx) => (await applyPatchPlanner(args, ctx)).commit(),
            plan: applyPatchPlanner,
            spec: {
                type: 'function',
                function: {
                    name: 'apply_patch',
                    description: 'Apply changes across multiple files atomically. Provide EITHER `edits` (preferred): an array of {path, old_string, new_string, replace_all?}; OR `diff`: a unified-diff string with +++ b/path headers and @@ hunks.',
                    parameters: {
                        type: 'object',
                        properties: {
                            edits: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } },
                                    required: ['path', 'old_string', 'new_string'],
                                    additionalProperties: false
                                }
                            },
                            diff: { type: 'string', description: 'Unified diff (--- a/x +++ b/x @@ ...).' }
                        },
                        additionalProperties: false
                    }
                }
            }
        },
        delete_file: {
            destructive: true, handler: deleteFile,
            spec: { type: 'function', function: { name: 'delete_file', description: 'Move a file or folder to the OS trash.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } } }
        },
        list_directory: {
            destructive: false, handler: listDirectory,
            spec: { type: 'function', function: { name: 'list_directory', description: 'List names and types of entries directly inside a directory.', parameters: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false } } }
        },
        glob_files: {
            destructive: false, handler: globFiles,
            spec: { type: 'function', function: { name: 'glob_files', description: 'Find files matching a glob (e.g. "src/**/*.ts").', parameters: { type: 'object', properties: { pattern: { type: 'string' }, max: { type: 'number' } }, required: ['pattern'], additionalProperties: false } } }
        },
        search_text: {
            destructive: false, handler: searchText,
            spec: { type: 'function', function: { name: 'search_text', description: 'Search file contents for a string or regex. Returns path:line: match.', parameters: { type: 'object', properties: { query: { type: 'string' }, regex: { type: 'boolean' }, include: { type: 'string' }, max_results: { type: 'number' } }, required: ['query'], additionalProperties: false } } }
        },
        run_command: {
            destructive: true, handler: runCommand,
            spec: { type: 'function', function: { name: 'run_command', description: 'Run a shell command in the workspace. Returns stdout/stderr and exit code.', parameters: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' }, shell: { type: 'string' } }, required: ['command'], additionalProperties: false } } }
        },
        get_diagnostics: {
            destructive: false, handler: getDiagnostics,
            spec: { type: 'function', function: { name: 'get_diagnostics', description: 'Get linter / language-server diagnostics. Omit path for all files.', parameters: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false } } }
        },
        get_workspace_info: {
            destructive: false, handler: workspaceInfo,
            spec: { type: 'function', function: { name: 'get_workspace_info', description: 'Return basic info about the workspace, active editor, selection, platform.', parameters: { type: 'object', properties: {}, additionalProperties: false } } }
        },
        find_symbols: {
            destructive: false, handler: findSymbols,
            spec: {
                type: 'function',
                function: {
                    name: 'find_symbols',
                    description: 'Find classes, functions, methods, etc. across the workspace using the language server. Better than text search when you want a definition. Returns path:line:col KIND name (in container).',
                    parameters: {
                        type: 'object',
                        properties: {
                            query: { type: 'string', description: 'Symbol name or fragment. Empty string returns top-level symbols.' },
                            max: { type: 'number', description: 'Maximum results (default 100, cap 500).' }
                        },
                        required: ['query'],
                        additionalProperties: false
                    }
                }
            }
        },
        web_fetch: {
            destructive: false, handler: webFetch,
            spec: {
                type: 'function',
                function: {
                    name: 'web_fetch',
                    description: 'Fetch the contents of an HTTP(S) URL. By default, HTML is converted to readable text and JSON is pretty-printed. Use raw=true to get bytes-as-utf8 verbatim. Subject to webBrowsing allow/block lists, timeout, and byte cap.',
                    parameters: {
                        type: 'object',
                        properties: {
                            url: { type: 'string', description: 'Absolute http(s) URL.' },
                            raw: { type: 'boolean', description: 'If true, skip HTML→text / JSON pretty-print.' },
                            max_bytes: { type: 'number', description: 'Per-call cap, clamped to extension setting.' },
                            timeout_ms: { type: 'number', description: 'Per-call timeout, clamped to extension setting.' }
                        },
                        required: ['url'],
                        additionalProperties: false
                    }
                }
            }
        },
        web_search: {
            destructive: false, handler: webSearch,
            spec: {
                type: 'function',
                function: {
                    name: 'web_search',
                    description: 'Search the web. Provider chosen by settings (duckduckgo / tavily / brave). Returns ranked title + url + snippet. Use this to discover URLs, then web_fetch to read them.',
                    parameters: {
                        type: 'object',
                        properties: {
                            query: { type: 'string' },
                            max_results: { type: 'number', description: 'Default 8, max 20.' }
                        },
                        required: ['query'],
                        additionalProperties: false
                    }
                }
            }
        },
        update_todos: {
            destructive: false, handler: updateTodos,
            spec: {
                type: 'function',
                function: {
                    name: 'update_todos',
                    description: 'Plan / track multi-step work. Pass the FULL list each time (the previous list is replaced, not merged). The chat UI renders these as a checklist for the user.',
                    parameters: {
                        type: 'object',
                        properties: {
                            items: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    properties: {
                                        text: { type: 'string' },
                                        status: { type: 'string', enum: ['pending', 'in_progress', 'done'] }
                                    },
                                    required: ['text', 'status'],
                                    additionalProperties: false
                                }
                            }
                        },
                        required: ['items'],
                        additionalProperties: false
                    }
                }
            }
        },
        get_definition: {
            destructive: false, handler: getDefinition,
            spec: {
                type: 'function',
                function: {
                    name: 'get_definition',
                    description: 'Jump to definition. Pass workspace-relative path + 1-based line/character at the symbol you want resolved.',
                    parameters: {
                        type: 'object',
                        properties: {
                            path: { type: 'string' }, line: { type: 'number' }, character: { type: 'number' }
                        },
                        required: ['path', 'line', 'character'],
                        additionalProperties: false
                    }
                }
            }
        },
        get_references: {
            destructive: false, handler: getReferences,
            spec: {
                type: 'function',
                function: {
                    name: 'get_references',
                    description: 'Find references to the symbol at path:line:character (1-based). Use to discover all callers / usages.',
                    parameters: {
                        type: 'object',
                        properties: {
                            path: { type: 'string' }, line: { type: 'number' }, character: { type: 'number' }
                        },
                        required: ['path', 'line', 'character'],
                        additionalProperties: false
                    }
                }
            }
        },
        run_task: {
            destructive: true, handler: runTask,
            spec: {
                type: 'function',
                function: {
                    name: 'run_task',
                    description: 'Execute a VS Code task by name (from .vscode/tasks.json or auto-detected). Prefer this over run_command when the user already has a task defined for the operation.',
                    parameters: {
                        type: 'object',
                        properties: { name: { type: 'string' } },
                        required: ['name'],
                        additionalProperties: false
                    }
                }
            }
        },
        read_memory: {
            destructive: false, handler: readMemory,
            spec: {
                type: 'function',
                function: {
                    name: 'read_memory',
                    description: `Read the persistent project memory at ${MEMORY_FILE}. Use to recall conventions, ongoing work, or gotchas across sessions.`,
                    parameters: { type: 'object', properties: {}, additionalProperties: false }
                }
            }
        },
        write_memory: {
            destructive: true, handler: writeMemory,
            spec: {
                type: 'function',
                function: {
                    name: 'write_memory',
                    description: `Append (default) or replace ${MEMORY_FILE}. Save durable, high-signal notes — conventions, gotchas, ongoing initiatives. NOT for ephemeral task state.`,
                    parameters: {
                        type: 'object',
                        properties: {
                            note: { type: 'string' },
                            mode: { type: 'string', enum: ['append', 'replace'] }
                        },
                        required: ['note'],
                        additionalProperties: false
                    }
                }
            }
        },
        spawn_agent: {
            destructive: false, handler: spawnAgent,
            spec: {
                type: 'function',
                function: {
                    name: 'spawn_agent',
                    description: 'Run a focused sub-task in a fresh agent context (saves your own context window). The sub-agent has its own loop; only its final answer is returned. Use for: surveys (e.g. "find all callers of X and summarize"), bulk file scans, multi-step research that does not need the parent\'s history.',
                    parameters: {
                        type: 'object',
                        properties: {
                            task: { type: 'string' },
                            allowed_tools: { type: 'array', items: { type: 'string' }, description: 'Whitelist of tool names; default is all read-only tools.' },
                            max_iterations: { type: 'number' }
                        },
                        required: ['task'],
                        additionalProperties: false
                    }
                }
            }
        },
        list_mcp_tools: {
            destructive: false, handler: listMcpTools,
            spec: {
                type: 'function',
                function: {
                    name: 'list_mcp_tools',
                    description: 'List MCP tools discovered from configured/running MCP servers. Phase 1 is discovery/status only; invocation is not implemented yet.',
                    parameters: { type: 'object', properties: {}, additionalProperties: false }
                }
            }
        }
    };
}
