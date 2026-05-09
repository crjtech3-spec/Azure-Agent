// Chat webview view. Renders the conversation, input box, and tool-event
// stream. Uses a tiny custom markdown renderer (no deps). Supports:
// - streaming assistant text (assistant_text_delta events)
// - image attachments (file picker, paste, drag & drop)
// - @mention file completion against workspace
// - slash commands forwarded to the host
// - per-workspace history persistence (rendered from host on init)

import * as vscode from 'vscode';
import { AgentEvent } from './agentExecutor';
import { ChatMessage } from './azureClient';

export interface ChatViewCallbacks {
    onSendMessage: (text: string, images: string[]) => void;
    onCancel: () => void;
    onClear: () => void;
    onOpenSettings: () => void;
    onAttachImage: () => void;
    loadHistory: () => Promise<ChatMessage[]>;
    saveHistory: (msgs: ChatMessage[]) => Promise<void>;
    getWelcomeState?: () => Promise<{ configured: boolean; compactMode?: boolean }>;
    setCompactMode?: (compact: boolean) => Promise<void>;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
    private view: vscode.WebviewView | undefined;
    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly cb: ChatViewCallbacks
    ) {}

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        view.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.context.extensionUri]
        };
        view.webview.html = this.html(view.webview);

        view.webview.onDidReceiveMessage(async (msg) => {
            switch (msg?.type) {
                case 'ready': {
                    const history = await this.cb.loadHistory();
                    view.webview.postMessage({ type: 'history', messages: history });
                    if (this.cb.getWelcomeState) {
                        const welcome = await this.cb.getWelcomeState();
                        view.webview.postMessage({ type: 'welcomeState', welcome });
                    }
                    return;
                }
                case 'send':
                    this.cb.onSendMessage(String(msg.text ?? ''), Array.isArray(msg.images) ? msg.images : []);
                    return;
                case 'cancel': this.cb.onCancel(); return;
                case 'clear': this.cb.onClear(); return;
                case 'openSettings': this.cb.onOpenSettings(); return;
                case 'attachImage': this.cb.onAttachImage(); return;
                case 'mentionQuery': {
                    const results = await mentionSearch(String(msg.q ?? ''));
                    view.webview.postMessage({ type: 'mentionResults', q: msg.q, results });
                    return;
                }
                case 'mentionFile': {
                    const text = await readMentionedFile(String(msg.path ?? ''));
                    view.webview.postMessage({ type: 'mentionFileContent', path: msg.path, text });
                    return;
                }
                case 'setCompactMode':
                    await this.cb.setCompactMode?.(!!msg.compact);
                    return;
            }
        });
    }

    postEvent(event: AgentEvent): void {
        this.view?.webview.postMessage({ type: 'agentEvent', event });
    }
    postAttachImages(items: { dataUrl: string; name: string }[]): void {
        this.view?.webview.postMessage({ type: 'attachImages', items });
    }
    injectUserMessage(text: string): void {
        this.view?.webview.postMessage({ type: 'injectUser', text });
    }
    notifyHistoryCleared(): void {
        this.view?.webview.postMessage({ type: 'cleared' });
    }

    private html(webview: vscode.Webview): string {
        const nonce = makeNonce();
        const csp = [
            "default-src 'none'",
            `style-src ${webview.cspSource} 'unsafe-inline'`,
            `img-src ${webview.cspSource} data: https:`,
            `script-src 'nonce-${nonce}'`,
            `font-src ${webview.cspSource}`
        ].join('; ');

        return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<title>Azure AI Agent</title>
<style>${CSS}</style>
</head>
<body>
<div id="app-shell">
  <div id="welcome" hidden></div>
  <div id="hero">
    <div class="hero-copy">
      <div id="hero-title">Azure AI Agent</div>
      <div id="hero-subtitle">A polished coding assistant for Azure-powered development, research, and workspace automation.</div>
    </div>
    <div class="hero-actions">
      <button id="hero-settings" class="ghost">Setup</button>
      <div id="hero-badge">Ready</div>
    </div>
  </div>
  <div id="quick-actions"></div>
  <div id="todos" hidden></div>
  <div id="messages" aria-live="polite"></div>
  <div id="status"></div>
  <div id="composer">
    <div id="attachments"></div>
    <div id="mention-popup" hidden></div>
    <div class="composer-topline">
      <div class="composer-title">Ask anything about your code</div>
      <div class="composer-hint">Enter to send · Shift+Enter for newline · @ to reference files</div>
    </div>
    <textarea id="input" rows="3" placeholder="Example: Review this file, explain the bug, and suggest the safest fix."></textarea>
    <div class="row">
      <button id="attach" class="ghost" title="Attach image">Attach image</button>
      <button id="send" title="Send (Enter)">Send</button>
      <button id="cancel" title="Cancel" hidden>Stop</button>
      <button id="clear" class="ghost" title="Clear chat">Clear</button>
      <button id="compact-toggle" class="ghost" title="Toggle compact mode">Compact</button>
      <span id="usage"></span>
    </div>
  </div>
</div>
<script nonce="${nonce}">${CLIENT_JS}</script>
</body>
</html>`;
    }
}

async function mentionSearch(q: string): Promise<string[]> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return [];
    const pattern = q.length === 0 ? '**/*' : `**/*${q}*`;
    const uris = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 25);
    const root = folders[0].uri.fsPath;
    return uris.map(u => relPath(root, u.fsPath)).sort();
}

async function readMentionedFile(rel: string): Promise<string> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return '';
    try {
        const uri = vscode.Uri.joinPath(folders[0].uri, rel);
        const data = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(data).toString('utf8');
        return text.length > 8000 ? text.slice(0, 8000) + '\n…[truncated]' : text;
    } catch { return ''; }
}

function relPath(root: string, abs: string): string {
    let r = abs.startsWith(root) ? abs.slice(root.length) : abs;
    if (r.startsWith('/') || r.startsWith('\\')) r = r.slice(1);
    return r.replace(/\\/g, '/');
}

function makeNonce(): string {
    const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let s = '';
    for (let i = 0; i < 32; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
    return s;
}

const CSS = `
:root {
  --bg: var(--vscode-sideBar-background);
  --fg: var(--vscode-foreground);
  --muted: var(--vscode-descriptionForeground);
  --border: color-mix(in srgb, var(--vscode-panel-border, rgba(128,128,128,0.3)) 70%, transparent);
  --accent: var(--vscode-textLink-foreground);
  --accent-2: var(--vscode-focusBorder);
  --surface: color-mix(in srgb, var(--vscode-editorWidget-background) 92%, transparent);
  --surface-2: color-mix(in srgb, var(--vscode-editorHoverWidget-background) 92%, transparent);
  --bubble-user: color-mix(in srgb, var(--vscode-editor-inactiveSelectionBackground) 82%, transparent);
  --bubble-assistant: color-mix(in srgb, var(--vscode-editorWidget-background) 92%, transparent);
  --bubble-tool: color-mix(in srgb, var(--vscode-editorHoverWidget-background) 92%, transparent);
  --code-bg: var(--vscode-textCodeBlock-background);
  --error: var(--vscode-errorForeground);
  --ok: var(--vscode-testing-iconPassed);
  --shadow: 0 14px 36px rgba(0,0,0,0.18);
}
* { box-sizing: border-box; }
html, body {
  padding: 0; margin: 0; height: 100%; color: var(--fg); background:
  radial-gradient(circle at top, color-mix(in srgb, var(--accent) 10%, transparent), transparent 35%),
  var(--bg);
  font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
}
body { display: flex; flex-direction: column; }
#app-shell { display: flex; flex-direction: column; min-height: 100%; }
body.compact #hero-subtitle, body.compact #welcome .sub, body.compact #status, body.compact #todos, body.compact #quick-actions, body.compact .composer-topline { display: none; }
body.compact .msg { margin: 4px 0; padding: 7px 9px; border-radius: 10px; box-shadow: none; }
body.compact #messages { padding: 6px; }
body.compact #composer { padding: 6px; }
body.compact #input { min-height: 42px; border-radius: 8px; box-shadow: none; }
#welcome, #quick-actions, #todos {
  margin: 10px 10px 0; border: 1px solid var(--border); border-radius: 16px;
  background: color-mix(in srgb, var(--surface) 94%, transparent); box-shadow: var(--shadow);
  animation: slideIn .18s ease-out;
}
#welcome { padding: 16px; }
#welcome .title { font-size: 17px; font-weight: 700; margin-bottom: 6px; }
#welcome .sub { color: var(--muted); font-size: 12px; margin-bottom: 12px; line-height: 1.5; }
#welcome .actions { display: flex; gap: 8px; flex-wrap: wrap; }
#welcome .steps { display:grid; gap:8px; margin: 12px 0; }
#welcome .step { display:flex; gap:10px; align-items:flex-start; padding:10px 12px; border-radius:12px; background: var(--surface-2); border:1px solid var(--border); }
#welcome .step .num { width:22px; height:22px; border-radius:999px; display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:700; background: color-mix(in srgb, var(--accent) 20%, transparent); }
#hero {
  display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 12px 10px; border-bottom: 1px solid var(--border);
}
.hero-copy { min-width: 0; }
.hero-actions { display:flex; align-items:center; gap:8px; }
#hero-title { font-size: 16px; font-weight: 800; letter-spacing: 0.02em; }
#hero-subtitle { font-size: 11px; color: var(--muted); margin-top: 3px; line-height: 1.4; }
#hero-badge { padding: 5px 10px; border-radius: 999px; background: color-mix(in srgb, var(--ok) 18%, transparent); color: var(--fg); font-size: 11px; border: 1px solid var(--border); }
#quick-actions { padding: 12px; }
#quick-actions .title { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin-bottom: 8px; }
#quick-actions .chips { display:flex; gap:8px; flex-wrap:wrap; }
.chip {
  padding:8px 10px; border-radius:999px; border:1px solid var(--border); background: var(--surface-2);
  cursor:pointer; font-size:12px;
}
.chip:hover { border-color: var(--accent-2); }
#todos { padding: 10px 12px; }
#todos .title { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin-bottom: 8px; }
#todos .todo { display: flex; align-items: center; gap: 8px; padding: 6px 0; }
#todos .dot { width: 10px; height: 10px; border-radius: 999px; background: var(--muted); }
#todos .todo.done .dot { background: #2ea043; }
#todos .todo.in_progress .dot { background: #d29922; box-shadow: 0 0 0 4px color-mix(in srgb, #d29922 20%, transparent); }
#todos .todo .label { flex: 1; }
#todos .todo.done .label { text-decoration: line-through; opacity: .8; }
#messages { flex: 1; overflow-y: auto; padding: 10px; scroll-behavior: smooth; }
#messages.empty::before {
  content: 'Start with a question, paste code, or use one of the quick actions above.';
  display:block; margin: 18px 8px; padding: 14px; border-radius: 14px; color: var(--muted);
  background: color-mix(in srgb, var(--surface) 90%, transparent); border:1px dashed var(--border);
}
#status { padding: 2px 12px 8px; color: var(--muted); font-size: 11px; min-height: 18px; }
#composer {
  border-top: 1px solid var(--border); padding: 10px; position: sticky; bottom: 0;
  background: color-mix(in srgb, var(--bg) 92%, transparent); backdrop-filter: blur(10px);
}
.composer-topline { display:flex; justify-content:space-between; gap:10px; margin-bottom:8px; }
.composer-title { font-size:12px; font-weight:700; }
.composer-hint { font-size:11px; color: var(--muted); }
#composer .row { display: flex; gap: 8px; align-items: center; margin-top: 8px; flex-wrap: wrap; }
#composer #usage { margin-left: auto; color: var(--muted); font-size: 11px; }
#input {
  width: 100%; resize: vertical; min-height: 64px; max-height: 240px; padding: 12px 13px;
  background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, var(--border)); border-radius: 14px;
  font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); box-shadow: var(--shadow);
  transition: border-color .15s ease, transform .15s ease;
}
#input:focus { outline: none; border-color: var(--accent-2); transform: translateY(-1px); }
button {
  background: linear-gradient(180deg, color-mix(in srgb, var(--vscode-button-background) 92%, white 8%), var(--vscode-button-background));
  color: var(--vscode-button-foreground); border: 0; padding: 8px 12px; border-radius: 10px; cursor: pointer;
  transition: transform .12s ease, filter .12s ease;
}
button.ghost { background: transparent; color: var(--fg); border: 1px solid var(--border); }
button:hover { background: var(--vscode-button-hoverBackground); transform: translateY(-1px); }
button.ghost:hover { background: var(--surface-2); }
button:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
.msg {
  margin: 8px 0; padding: 12px 13px; border-radius: 16px; white-space: pre-wrap; word-wrap: break-word;
  box-shadow: var(--shadow); animation: slideIn .18s ease-out;
}
.msg.user { background: var(--bubble-user); margin-left: 18px; }
.msg.assistant { background: var(--bubble-assistant); border: 1px solid var(--border); margin-right: 18px; }
.msg.tool { background: var(--bubble-tool); border-left: 3px solid var(--accent); font-family: var(--vscode-editor-font-family); font-size: 12px; }
.msg.error { color: var(--error); border-left: 3px solid var(--error); }
.msg .role { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 6px; }
.msg pre { background: var(--code-bg); padding: 8px; border-radius: 8px; overflow-x: auto; margin: 6px 0; font-family: var(--vscode-editor-font-family); font-size: 12px; }
.msg code { background: var(--code-bg); padding: 1px 4px; border-radius: 3px; font-family: var(--vscode-editor-font-family); font-size: 92%; }
.msg pre code { background: transparent; padding: 0; }
.msg img.thumb { max-width: 240px; max-height: 200px; border-radius: 8px; margin: 4px 4px 0 0; vertical-align: top; }
.tool-summary { font-weight: 600; }
.tool-detail { color: var(--muted); margin-top: 4px; max-height: 160px; overflow: auto; }
.attachment {
  display: inline-flex; align-items: center; gap: 6px; padding: 5px 9px; margin: 2px;
  border: 1px solid var(--border); border-radius: 999px; font-size: 11px;
  background: color-mix(in srgb, var(--bubble-tool) 80%, transparent); animation: slideIn .18s ease-out;
}
.attachment img { width: 18px; height: 18px; object-fit: cover; border-radius: 4px; }
.attachment .x { cursor: pointer; color: var(--muted); }
#mention-popup {
  position: absolute; left: 10px; right: 10px; bottom: 118px; max-height: 180px; overflow: auto;
  background: var(--vscode-editorWidget-background); border: 1px solid var(--border); border-radius: 12px; z-index: 5; box-shadow: var(--shadow);
}
#mention-popup .item { padding: 8px 10px; cursor: pointer; font-family: var(--vscode-editor-font-family); font-size: 12px; }
#mention-popup .item:hover, #mention-popup .item.active { background: var(--vscode-list-hoverBackground); }
.dragover { outline: 2px dashed var(--accent); outline-offset: -4px; }
a { color: var(--accent); }
@keyframes slideIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
`;

const CLIENT_JS = `
(function () {
  const vscode = acquireVsCodeApi();
  const $messages = document.getElementById('messages');
  const $status = document.getElementById('status');
  const $welcome = document.getElementById('welcome');
  const $input = document.getElementById('input');
  const $send = document.getElementById('send');
  const $cancel = document.getElementById('cancel');
  const $clear = document.getElementById('clear');
  const $attach = document.getElementById('attach');
  const $compactToggle = document.getElementById('compact-toggle');
  const $attachments = document.getElementById('attachments');
  const $mention = document.getElementById('mention-popup');
  const $usage = document.getElementById('usage');
  const $todos = document.getElementById('todos');
  const $quickActions = document.getElementById('quick-actions');
  const $heroSettings = document.getElementById('hero-settings');

  let attachments = [];
  let busy = false;
  let compactMode = false;
  let streamingMsg = null;
  let liveToolStreams = new Map();

  function escapeHtml(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function renderMarkdown(src) {
    if (typeof src !== 'string') src = String(src ?? '');
    const parts = [];
    const re = /\\\`\\\`\\\`(\\w*)\\n([\\s\\S]*?)\\n\\\`\\\`\\\`/g;
    let m, last = 0;
    while ((m = re.exec(src)) !== null) {
      if (m.index > last) parts.push({ kind:'text', text: src.slice(last, m.index) });
      parts.push({ kind:'code', text: m[2] });
      last = m.index + m[0].length;
    }
    if (last < src.length) parts.push({ kind:'text', text: src.slice(last) });
    return parts.map(p => p.kind === 'code' ? '<pre><code>' + escapeHtml(p.text) + '</code></pre>' : inlineMarkdown(p.text)).join('');
  }
  function inlineMarkdown(text) {
    let s = escapeHtml(text);
    s = s.replace(/^######\\s?(.+)$/gm, '<h6>$1</h6>')
         .replace(/^#####\\s?(.+)$/gm, '<h5>$1</h5>')
         .replace(/^####\\s?(.+)$/gm, '<h4>$1</h4>')
         .replace(/^###\\s?(.+)$/gm, '<h3>$1</h3>')
         .replace(/^##\\s?(.+)$/gm, '<h2>$1</h2>')
         .replace(/^#\\s?(.+)$/gm, '<h1>$1</h1>');
    s = s.replace(/\`([^\`\\n]+)\`/g, '<code>$1</code>');
    s = s.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
    s = s.replace(/(?<!\\*)\\*([^*\\n]+)\\*(?!\\*)/g, '<em>$1</em>');
    s = s.replace(/\\[([^\\]]+)\\]\\((https?:[^)]+)\\)/g, '<a href="$2">$1</a>');
    s = s.replace(/^(?:- |\\* )(.*)$/gm, '<li>$1</li>');
    s = s.replace(/(<li>[\\s\\S]+?<\\/li>)(?!<\\/ul>)/g, '<ul>$1</ul>');
    s = s.replace(/\\n/g, '<br/>');
    return s;
  }

  function refreshEmptyState() {
    $messages.classList.toggle('empty', !$messages.children.length);
  }
  function addMessage(role, htmlContent, extraClass = '') {
    const el = document.createElement('div');
    el.className = 'msg ' + role + (extraClass ? ' ' + extraClass : '');
    el.innerHTML = '<div class="role">' + role + '</div>' + htmlContent;
    $messages.appendChild(el);
    refreshEmptyState();
    $messages.scrollTop = $messages.scrollHeight;
    return el;
  }
  function renderUserMessage(text, imageUrls) {
    let html = '';
    if (imageUrls && imageUrls.length > 0) {
      for (const url of imageUrls) html += '<img class="thumb" src="' + url + '" />';
      if (text) html += '<div>' + renderMarkdown(text) + '</div>';
    } else {
      html = renderMarkdown(text || '');
    }
    addMessage('user', html);
  }
  function startAssistantBubble() {
    const el = addMessage('assistant', '<div class="typing">Thinking…</div>');
    streamingMsg = { el, buf: '' };
  }
  function appendAssistantDelta(t) {
    if (!streamingMsg) startAssistantBubble();
    streamingMsg.buf += t;
    streamingMsg.el.innerHTML = '<div class="role">assistant</div>' + renderMarkdown(streamingMsg.buf);
    $messages.scrollTop = $messages.scrollHeight;
  }
  function finalizeAssistant(finalText) {
    if (!streamingMsg) {
      addMessage('assistant', renderMarkdown(finalText));
      return;
    }
    streamingMsg.el.innerHTML = '<div class="role">assistant</div>' + renderMarkdown(finalText || streamingMsg.buf);
    streamingMsg = null;
    $messages.scrollTop = $messages.scrollHeight;
  }
  function toolBlock(title, body, extraClass) {
    const id = 'tool-' + Math.random().toString(36).slice(2);
    const html = '<details class="tool-collapsible" ' + (compactMode ? '' : 'open') + '>' +
      '<summary class="tool-summary">' + title + '</summary>' +
      (body ? '<div id="' + id + '" class="tool-detail">' + body + '</div>' : '') +
      '</details>';
    const el = addMessage('tool', html, extraClass || '');
    return { el, id };
  }
  function toolCategory(name) {
    if (!name) return 'tool';
    if (name.startsWith('mcp__')) return 'mcp';
    if (['read_file','list_directory','glob_files','search_text','find_symbols','get_diagnostics','get_workspace_info','get_definition','get_references','read_memory','list_mcp_tools'].includes(name)) return 'read';
    if (['write_file','edit_file','apply_patch','delete_file','write_memory'].includes(name)) return 'write';
    if (['run_command','run_task','spawn_agent'].includes(name)) return 'exec';
    if (['web_search','web_fetch'].includes(name)) return 'web';
    return 'tool';
  }
  function renderToolCall(ev) {
    const name = String(ev.tool || '?');
    const args = ev.args !== undefined ? '<pre>' + escapeHtml(safeJson(ev.args)) + '</pre>' : '<div class="tool-detail">Running…</div>';
    toolBlock('[' + toolCategory(name) + '] → ' + escapeHtml(name), args, 'call');
  }
  function renderToolResult(ev) {
    const cls = ev.ok ? '' : 'error';
    const name = String(ev.tool || '?');
    const head = '[' + toolCategory(name) + '] ' + (ev.ok ? '✓ ' : '✗ ') + escapeHtml(name);
    const body = ev.text ? '<pre>' + escapeHtml(String(ev.text).slice(0, 4000)) + '</pre>' : '<div class="tool-detail">Completed.</div>';
    toolBlock(head, body, cls);
  }
  function safeJson(v) {
    try { return JSON.stringify(v, null, 2); } catch { return String(v); }
  }
  function setBusy(b) {
    busy = b;
    $send.disabled = b;
    $cancel.hidden = !b;
  }
  function setStatus(msg) { $status.textContent = msg || ''; }
  function setUsage(u) {
    $usage.textContent = u && u.total_tokens ? ('Tokens: ' + u.total_tokens.toLocaleString()) : '';
  }
  function renderTodos(items) {
    if (!items || items.length === 0) {
      $todos.hidden = true;
      $todos.innerHTML = '';
      return;
    }
    $todos.hidden = false;
    $todos.innerHTML = '<div class="title">Current plan</div>' + items.map(t =>
      '<div class="todo ' + escapeHtml(String(t.status || 'pending')) + '">' +
      '<span class="dot"></span>' +
      '<span class="label">' + escapeHtml(String(t.text || '')) + '</span>' +
      '</div>'
    ).join('');
  }
  function renderQuickActions() {
    const prompts = [
      'Explain the selected code',
      'Find the bug in this file',
      'Create a step-by-step fix plan',
      'Write tests for this module',
      'Summarize this repository'
    ];
    $quickActions.innerHTML = '<div class="title">Quick actions</div><div class="chips">' + prompts.map(p => '<button class="chip" data-prompt="' + escapeHtml(p) + '">' + escapeHtml(p) + '</button>').join('') + '</div>';
    Array.from($quickActions.querySelectorAll('[data-prompt]')).forEach(el => {
      el.addEventListener('click', () => {
        $input.value = el.getAttribute('data-prompt') || '';
        $input.focus();
      });
    });
  }
  function renderWelcome(configured) {
    if (configured) {
      $welcome.hidden = true;
      $welcome.innerHTML = '';
      return;
    }
    $welcome.hidden = false;
    $welcome.innerHTML =
      '<div class="title">Welcome to Azure AI Agent</div>' +
      '<div class="sub">This guided experience is designed to be simple even if you are not technical. Follow the steps below once, then start chatting naturally.</div>' +
      '<div class="steps">' +
      '<div class="step"><div class="num">1</div><div><strong>Open setup</strong><div class="sub">Add your Azure endpoint, deployment name, and API key.</div></div></div>' +
      '<div class="step"><div class="num">2</div><div><strong>Choose a safe preset</strong><div class="sub">Balanced mode is recommended for most users.</div></div></div>' +
      '<div class="step"><div class="num">3</div><div><strong>Ask your first question</strong><div class="sub">Example: Explain this file and suggest improvements.</div></div></div>' +
      '</div>' +
      '<div class="actions">' +
      '<button id="welcome-setup">Open guided setup</button>' +
      '<button id="welcome-example" class="ghost">Insert example prompt</button>' +
      '</div>';
    document.getElementById('welcome-setup')?.addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
    document.getElementById('welcome-example')?.addEventListener('click', () => {
      $input.value = 'Explain this code in simple terms and suggest the safest improvements.';
      $input.focus();
    });
  }
  function renderAttachments() {
    $attachments.innerHTML = '';
    attachments.forEach((a, i) => {
      const tag = document.createElement('span');
      tag.className = 'attachment';
      tag.innerHTML = '<img src="' + a.dataUrl + '"/><span>' + escapeHtml(a.name) + '</span><span class="x" data-i="' + i + '">×</span>';
      $attachments.appendChild(tag);
    });
    $attachments.querySelectorAll('.x').forEach(x => {
      x.addEventListener('click', (e) => {
        const i = parseInt(e.currentTarget.getAttribute('data-i'), 10);
        attachments.splice(i, 1);
        renderAttachments();
      });
    });
  }
  function send() {
    const text = $input.value;
    if (!text.trim() && attachments.length === 0) return;
    if (attachments.length > 0 || (text.trim() && !text.trim().startsWith('/'))) {
      renderUserMessage(text, attachments.map(a => a.dataUrl));
    }
    vscode.postMessage({ type: 'send', text, images: attachments.map(a => a.dataUrl) });
    $input.value = '';
    attachments = [];
    renderAttachments();
    setBusy(true);
    setStatus('Working…');
  }
  function applyCompactMode() {
    document.body.classList.toggle('compact', compactMode);
    $compactToggle.textContent = compactMode ? 'Comfortable' : 'Compact';
  }

  $send.addEventListener('click', send);
  $cancel.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  $clear.addEventListener('click', () => vscode.postMessage({ type: 'clear' }));
  $attach.addEventListener('click', () => vscode.postMessage({ type: 'attachImage' }));
  $heroSettings.addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
  $compactToggle.addEventListener('click', () => {
    compactMode = !compactMode;
    applyCompactMode();
    vscode.postMessage({ type: 'setCompactMode', compact: compactMode });
  });
  $input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); return; }
    if (e.key === 'Escape' && busy) { vscode.postMessage({ type: 'cancel' }); }
  });

  function ingestFiles(files) {
    Array.from(files).forEach(f => {
      if (!f.type || !f.type.startsWith('image/')) return;
      const reader = new FileReader();
      reader.onload = () => {
        attachments.push({ dataUrl: String(reader.result), name: f.name || 'image' });
        renderAttachments();
      };
      reader.readAsDataURL(f);
    });
  }
  document.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragover'); });
  document.addEventListener('dragleave', () => document.body.classList.remove('dragover'));
  document.addEventListener('drop', (e) => {
    e.preventDefault(); document.body.classList.remove('dragover');
    if (e.dataTransfer && e.dataTransfer.files) ingestFiles(e.dataTransfer.files);
  });
  $input.addEventListener('paste', (e) => {
    if (e.clipboardData && e.clipboardData.files && e.clipboardData.files.length > 0) ingestFiles(e.clipboardData.files);
  });

  let mentionStart = -1;
  let mentionItems = [];
  let mentionActive = 0;
  function hideMention() { $mention.hidden = true; mentionStart = -1; mentionItems = []; }
  function showMention(items) {
    mentionItems = items;
    mentionActive = 0;
    if (items.length === 0) { hideMention(); return; }
    $mention.innerHTML = items.map((p, i) => '<div class="item' + (i===0?' active':'') + '" data-i="' + i + '">' + escapeHtml(p) + '</div>').join('');
    $mention.hidden = false;
    Array.from($mention.querySelectorAll('.item')).forEach(el => el.addEventListener('click', () => acceptMention(parseInt(el.getAttribute('data-i'), 10))));
  }
  function acceptMention(i) {
    if (i < 0 || i >= mentionItems.length) return;
    const path = mentionItems[i];
    const before = $input.value.slice(0, mentionStart);
    const after = $input.value.slice($input.selectionStart);
    $input.value = before + '@' + path + ' ' + after;
    hideMention();
    $input.focus();
  }
  $input.addEventListener('input', () => {
    const v = $input.value;
    const cur = $input.selectionStart;
    const head = v.slice(0, cur);
    const m = head.match(/(?:^|\\s)@([^\\s@]*)$/);
    if (m) {
      mentionStart = cur - m[1].length - 1;
      vscode.postMessage({ type: 'mentionQuery', q: m[1] });
    } else {
      hideMention();
    }
  });
  $input.addEventListener('keydown', (e) => {
    if ($mention.hidden) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); mentionActive = Math.min(mentionItems.length - 1, mentionActive + 1); refreshMentionActive(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); mentionActive = Math.max(0, mentionActive - 1); refreshMentionActive(); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acceptMention(mentionActive); }
    else if (e.key === 'Escape') { e.preventDefault(); hideMention(); }
  });
  function refreshMentionActive() {
    Array.from($mention.querySelectorAll('.item')).forEach((el, i) => el.classList.toggle('active', i === mentionActive));
  }

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg) return;
    switch (msg.type) {
      case 'history':
        renderHistory(msg.messages || []);
        break;
      case 'agentEvent':
        handleAgentEvent(msg.event);
        break;
      case 'attachImages':
        for (const it of (msg.items || [])) attachments.push(it);
        renderAttachments();
        break;
      case 'injectUser':
        renderUserMessage(String(msg.text || ''), []);
        setBusy(true);
        break;
      case 'cleared':
        $messages.innerHTML = '';
        refreshEmptyState();
        setStatus('History cleared.');
        break;
      case 'mentionResults':
        showMention(msg.results || []);
        break;
      case 'welcomeState':
        compactMode = !!msg.welcome?.compactMode;
        applyCompactMode();
        renderWelcome(!!msg.welcome?.configured);
        break;
    }
  });

  function handleAgentEvent(ev) {
    if (!ev) return;
    switch (ev.kind) {
      case 'iteration': setStatus('Working on step ' + ev.iteration + '…'); break;
      case 'assistant_text_delta': appendAssistantDelta(ev.text || ''); break;
      case 'assistant_text': finalizeAssistant(ev.text || ''); break;
      case 'tool_call': renderToolCall(ev); break;
      case 'tool_result': renderToolResult(ev); break;
      case 'tool_stream': {
        const key = String(ev.stream || 'stream');
        const chunk = String(ev.text || '');
        const existing = liveToolStreams.get(key);
        if (!existing) {
          const created = toolBlock(escapeHtml(key), '<pre>' + escapeHtml(chunk.slice(0, 4000)) + '</pre>');
          liveToolStreams.set(key, { id: created.id, text: chunk });
        } else {
          existing.text += chunk;
          const body = document.getElementById(existing.id);
          if (body) body.innerHTML = '<pre>' + escapeHtml(existing.text.slice(-12000)) + '</pre>';
        }
        break;
      }
      case 'usage': setUsage(ev.usage); break;
      case 'status': setStatus(ev.text || ''); break;
      case 'todos': renderTodos(ev.todos || []); break;
      case 'error':
        addMessage('assistant', renderMarkdown('**Error:** ' + (ev.text || 'unknown')), 'error');
        setBusy(false);
        setStatus('');
        break;
      case 'done':
        if (streamingMsg) finalizeAssistant(streamingMsg.buf);
        liveToolStreams.clear();
        setBusy(false);
        setStatus('');
        break;
    }
  }

  function renderHistory(msgs) {
    $messages.innerHTML = '';
    for (const m of msgs) {
      if (m.role === 'user') {
        if (typeof m.content === 'string') renderUserMessage(m.content, []);
        else if (Array.isArray(m.content)) {
          const text = m.content.filter(p => p.type === 'text').map(p => p.text).join('\\n');
          const imgs = m.content.filter(p => p.type === 'image_url').map(p => p.image_url.url);
          renderUserMessage(text, imgs);
        }
      } else if (m.role === 'assistant') {
        if (m.content && (typeof m.content === 'string' ? m.content.trim() : true)) {
          addMessage('assistant', renderMarkdown(typeof m.content === 'string' ? m.content : ''));
        }
        if (m.tool_calls) {
          for (const tc of m.tool_calls) renderToolCall({ tool: tc.function.name, args: tryParse(tc.function.arguments) });
        }
      } else if (m.role === 'tool') {
        renderToolResult({ tool: '(tool)', ok: true, text: typeof m.content === 'string' ? m.content : '' });
      }
    }
    refreshEmptyState();
  }
  function tryParse(s) { try { return JSON.parse(s); } catch { return s; } }

  renderQuickActions();
  refreshEmptyState();
  vscode.postMessage({ type: 'ready' });
})();
`;
