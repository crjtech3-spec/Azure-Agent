import * as vscode from 'vscode';

export interface SettingsSnapshot {
    endpoint: string;
    deployment: string;
    apiVersion: string;
    hasApiKey: boolean;
    webSearchProvider: 'duckduckgo' | 'tavily' | 'brave';
    hasWebSearchKey: boolean;
    approvalMode: 'auto' | 'destructive' | 'always';
    mcpApprovalMode: 'auto' | 'destructive' | 'always';
    webBrowsingEnabled: boolean;
    scrubSecrets: boolean;
    compactMode: boolean;
    mcpServersJson: string;
    autoApproveCommandPatternsJson: string;
    diagnostics: string[];
    health: {
        endpointValid: boolean;
        keyPresent: boolean;
        deploymentReachable: boolean;
        searchConfigured: boolean;
        workspaceTrusted: boolean;
    };
    deploymentSuggestions: string[];
}

export interface SettingsViewCallbacks {
    getSnapshot: () => Promise<SettingsSnapshot>;
    save: (payload: {
        endpoint: string;
        deployment: string;
        apiVersion: string;
        apiKey?: string;
        webSearchProvider: 'duckduckgo' | 'tavily' | 'brave';
        webSearchKey?: string;
        approvalMode: 'auto' | 'destructive' | 'always';
        mcpApprovalMode: 'auto' | 'destructive' | 'always';
        webBrowsingEnabled: boolean;
        scrubSecrets: boolean;
        compactMode: boolean;
        mcpServersJson: string;
        autoApproveCommandPatternsJson: string;
    }) => Promise<{ ok: boolean; message: string }>;
    testConnection: (payload: { endpoint: string; deployment: string; apiVersion: string; apiKey?: string }) => Promise<{ ok: boolean; message: string }>;
    openMcpInfo: () => Promise<void>;
    copyCurl: (payload: { endpoint: string; deployment: string; apiVersion: string }) => Promise<{ ok: boolean; message: string }>;
    exportProfile: () => Promise<{ ok: boolean; message: string }>;
    importProfile: () => Promise<{ ok: boolean; message: string }>;
    applyPreset: (preset: 'safe' | 'balanced' | 'power') => Promise<{ ok: boolean; message: string }>;
}

export class SettingsPanel {
    private panel: vscode.WebviewPanel | undefined;

    constructor(private readonly context: vscode.ExtensionContext, private readonly cb: SettingsViewCallbacks) {}

    async show(): Promise<void> {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.One);
            await this.postSnapshot();
            return;
        }
        this.panel = vscode.window.createWebviewPanel(
            'azureAiAgentSettings',
            'Azure AI Agent Settings',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        this.panel.onDidDispose(() => { this.panel = undefined; });
        this.panel.webview.html = this.html(this.panel.webview);
        this.panel.webview.onDidReceiveMessage(async (msg) => {
            switch (msg?.type) {
                case 'ready':
                    await this.postSnapshot();
                    return;
                case 'save': {
                    const res = await this.cb.save(msg.payload);
                    this.panel?.webview.postMessage({ type: 'saveResult', ...res });
                    await this.postSnapshot();
                    return;
                }
                case 'test': {
                    const res = await this.cb.testConnection(msg.payload);
                    this.panel?.webview.postMessage({ type: 'testResult', ...res });
                    await this.postSnapshot();
                    return;
                }
                case 'mcp':
                    await this.cb.openMcpInfo();
                    return;
                case 'copyCurl': {
                    const res = await this.cb.copyCurl(msg.payload);
                    this.panel?.webview.postMessage({ type: 'actionResult', ...res });
                    return;
                }
                case 'exportProfile': {
                    const res = await this.cb.exportProfile();
                    this.panel?.webview.postMessage({ type: 'actionResult', ...res });
                    return;
                }
                case 'importProfile': {
                    const res = await this.cb.importProfile();
                    this.panel?.webview.postMessage({ type: 'actionResult', ...res });
                    await this.postSnapshot();
                    return;
                }
                case 'preset': {
                    const res = await this.cb.applyPreset(msg.preset);
                    this.panel?.webview.postMessage({ type: 'actionResult', ...res });
                    await this.postSnapshot();
                    return;
                }
            }
        });
    }

    private async postSnapshot(): Promise<void> {
        const snapshot = await this.cb.getSnapshot();
        this.panel?.webview.postMessage({ type: 'snapshot', snapshot });
    }

    private html(webview: vscode.Webview): string {
        const nonce = String(Date.now());
        const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
        return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Azure AI Agent Settings</title>
<style>
:root {
  --bg: var(--vscode-editor-background);
  --fg: var(--vscode-foreground);
  --muted: var(--vscode-descriptionForeground);
  --border: color-mix(in srgb, var(--vscode-panel-border) 70%, transparent);
  --card: color-mix(in srgb, var(--vscode-editorWidget-background) 92%, transparent);
  --card-2: color-mix(in srgb, var(--vscode-sideBar-background) 88%, transparent);
  --accent: var(--vscode-button-background);
  --accent-fg: var(--vscode-button-foreground);
  --accent-2: var(--vscode-focusBorder);
  --ok: var(--vscode-testing-iconPassed);
  --warn: var(--vscode-testing-iconQueued);
  --bad: var(--vscode-errorForeground);
  --shadow: 0 16px 40px rgba(0,0,0,.18);
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background:
  radial-gradient(circle at top right, color-mix(in srgb, var(--accent) 14%, transparent), transparent 30%),
  radial-gradient(circle at top left, color-mix(in srgb, var(--accent-2) 10%, transparent), transparent 28%),
  var(--bg); color: var(--fg); font-family: var(--vscode-font-family); }
body { padding: 24px; }
.container { max-width: 1120px; margin: 0 auto; }
.hero { display:grid; grid-template-columns: 1.4fr .8fr; gap:16px; margin-bottom:18px; }
.heroCard, .summaryCard, .card { background: var(--card); border:1px solid var(--border); border-radius:20px; box-shadow: var(--shadow); }
.heroCard { padding:22px; }
.summaryCard { padding:18px; }
.eyebrow { font-size:11px; text-transform:uppercase; letter-spacing:.12em; color: var(--muted); margin-bottom:10px; }
.hero h1 { margin:0; font-size:28px; line-height:1.15; }
.hero p { margin:10px 0 0; color: var(--muted); max-width: 720px; }
.heroActions, .actions { display:flex; gap:10px; flex-wrap:wrap; }
.heroActions { margin-top:18px; }
.grid { display:grid; grid-template-columns: 1.1fr .9fr; gap:16px; }
.stack { display:grid; gap:16px; }
.card { padding:18px; }
.card h2 { margin:0 0 6px; font-size:18px; }
.card .sub { color: var(--muted); font-size:12px; margin-bottom:14px; }
.field { margin-bottom:14px; }
.field.two { display:grid; grid-template-columns: 1fr 1fr; gap:12px; }
label { display:block; font-size:12px; color: var(--muted); margin-bottom:6px; }
input, select, textarea {
  width:100%; padding:12px 13px; border-radius:12px; border:1px solid var(--border);
  background: var(--vscode-input-background); color: var(--vscode-input-foreground);
}
input:focus, select:focus, textarea:focus { outline:none; border-color: var(--accent-2); }
textarea { min-height: 120px; resize: vertical; font-family: var(--vscode-editor-font-family, monospace); }
button {
  border:0; border-radius:12px; padding:11px 14px; cursor:pointer;
  background: linear-gradient(180deg, color-mix(in srgb, var(--accent) 90%, white 10%), var(--accent));
  color: var(--accent-fg); font-weight:600;
}
button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
button.ghost { background: transparent; color: var(--fg); border:1px solid var(--border); }
button:hover { filter: brightness(1.05); }
.status { margin-top:16px; min-height:22px; color: var(--muted); padding: 12px 14px; border-radius: 14px; border:1px solid var(--border); background: var(--card-2); }
.note { color: var(--muted); font-size:12px; line-height:1.5; }
.health { display:grid; grid-template-columns: 1fr 1fr; gap:10px; }
.health .item { border:1px solid var(--border); border-radius:14px; padding:12px; background: var(--card-2); }
.health .label { font-size:12px; color: var(--muted); margin-bottom:6px; }
.health .state { font-weight:700; }
.health .ok { color: var(--ok); }
.health .bad { color: var(--bad); }
.health .warn { color: var(--warn); }
.pillRow { display:flex; gap:8px; flex-wrap:wrap; }
.pill { padding:8px 10px; border-radius:999px; border:1px solid var(--border); background: var(--card-2); font-size:12px; }
.toggleRow { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:12px 0; border-top:1px solid var(--border); }
.toggleRow:first-of-type { border-top:0; }
.toggleText strong { display:block; font-size:13px; }
.toggleText span { display:block; color: var(--muted); font-size:12px; margin-top:3px; }
.switch { position:relative; width:52px; height:30px; display:inline-block; }
.switch input { opacity:0; width:0; height:0; position:absolute; }
.slider { position:absolute; inset:0; background: color-mix(in srgb, var(--muted) 35%, transparent); border:1px solid var(--border); border-radius:999px; transition:.2s; }
.slider:before { content:''; position:absolute; width:22px; height:22px; left:3px; top:3px; border-radius:50%; background:white; transition:.2s; box-shadow: 0 2px 8px rgba(0,0,0,.25); }
.switch input:checked + .slider { background: color-mix(in srgb, var(--accent) 75%, transparent); }
.switch input:checked + .slider:before { transform: translateX(22px); }
details.advanced { border:1px solid var(--border); border-radius:16px; background: var(--card-2); overflow:hidden; }
details.advanced summary { list-style:none; cursor:pointer; padding:14px 16px; font-weight:700; }
details.advanced summary::-webkit-details-marker { display:none; }
details.advanced .advancedBody { padding:0 16px 16px; }
.diagList { display:grid; gap:8px; }
.diagItem { padding:10px 12px; border-radius:12px; border:1px solid var(--border); background: var(--card-2); font-size:12px; }
.kpi { display:grid; grid-template-columns: repeat(3, 1fr); gap:10px; margin-top:14px; }
.kpi .box { border:1px solid var(--border); border-radius:14px; padding:12px; background: var(--card-2); }
.kpi .box .num { font-size:18px; font-weight:800; }
.kpi .box .txt { font-size:12px; color: var(--muted); margin-top:4px; }
.inlineHelp { margin-top:6px; color: var(--muted); font-size:11px; }
@media (max-width: 900px) {
  .hero, .grid, .field.two, .health, .kpi { grid-template-columns: 1fr; }
}
</style>
</head>
<body>
<div class="container">
  <div class="hero">
    <div class="heroCard">
      <div class="eyebrow">Premium guided setup</div>
      <h1>Configure Azure AI Agent in minutes</h1>
      <p>Designed for both technical and non-technical users. Start with your Azure connection, choose how safe or powerful you want the agent to be, then save and test.</p>
      <div class="heroActions">
        <button id="wizardFillSafe" class="secondary">Begin with safest mode</button>
        <button id="wizardFillBalanced">Use recommended mode</button>
        <button id="wizardTest" class="ghost">Test connection</button>
      </div>
      <div class="kpi">
        <div class="box"><div class="num" id="kpiConfigured">0/3</div><div class="txt">Core setup complete</div></div>
        <div class="box"><div class="num" id="kpiSafety">Safe</div><div class="txt">Current safety profile</div></div>
        <div class="box"><div class="num" id="kpiSearch">Off</div><div class="txt">Web browsing status</div></div>
      </div>
    </div>
    <div class="summaryCard">
      <div class="eyebrow">Setup health</div>
      <div id="health" class="health"></div>
    </div>
  </div>

  <div class="grid">
    <div class="stack">
      <div class="card">
        <h2>1. Connect your Azure model</h2>
        <div class="sub">Only three things are required: endpoint, deployment name, and API key.</div>
        <div class="field"><label>Azure endpoint</label><input id="endpoint" placeholder="https://your-resource.openai.azure.com/" /></div>
        <div class="field two">
          <div><label>Deployment name</label><input id="deployment" list="deploymentSuggestions" placeholder="gpt-5.4" /></div>
          <div><label>API version</label><input id="apiVersion" placeholder="2024-12-01-preview" /></div>
        </div>
        <datalist id="deploymentSuggestions"></datalist>
        <div class="field"><label>Azure API key</label><input id="apiKey" type="password" placeholder="Leave blank to keep existing stored key" /><div class="inlineHelp">Stored securely in VS Code SecretStorage.</div></div>
        <div class="actions">
          <button id="test">Test connection</button>
          <button id="copyCurl" class="secondary">Copy test command</button>
        </div>
      </div>

      <div class="card">
        <h2>2. Choose how the agent behaves</h2>
        <div class="sub">Pick a preset or fine-tune the experience below.</div>
        <div class="pillRow" style="margin-bottom:14px;">
          <button class="preset" data-preset="safe">Safe</button>
          <button class="preset" data-preset="balanced">Balanced</button>
          <button class="preset" data-preset="power">Power user</button>
        </div>
        <div class="field"><label>Approval style</label><select id="approvalMode"><option value="always">Ask before most actions (safest)</option><option value="destructive">Ask before risky actions (recommended)</option><option value="auto">Run without asking (fastest)</option></select></div>
        <div class="field"><label>Web search provider</label><select id="webSearchProvider"><option value="duckduckgo">DuckDuckGo (no key needed)</option><option value="tavily">Tavily (API key required)</option><option value="brave">Brave Search (API key required)</option></select></div>
        <div class="field"><label>Web search API key</label><input id="webSearchKey" type="password" placeholder="Only needed for Tavily or Brave" /></div>

        <div class="toggleRow">
          <div class="toggleText"><strong>Enable web browsing</strong><span>Let the agent search the web and fetch documentation pages.</span></div>
          <label class="switch"><input id="webBrowsingEnabled" type="checkbox" /><span class="slider"></span></label>
        </div>
        <div class="toggleRow">
          <div class="toggleText"><strong>Protect secrets automatically</strong><span>Redacts obvious API keys and tokens from tool output before sending to the model.</span></div>
          <label class="switch"><input id="scrubSecrets" type="checkbox" /><span class="slider"></span></label>
        </div>
        <div class="toggleRow">
          <div class="toggleText"><strong>Use compact chat layout</strong><span>Shows a denser chat UI with less spacing.</span></div>
          <label class="switch"><input id="compactMode" type="checkbox" /><span class="slider"></span></label>
        </div>
      </div>
    </div>

    <div class="stack">
      <div class="card">
        <h2>3. Save and go</h2>
        <div class="sub">Recommended for most users: save first, then test once.</div>
        <div class="actions">
          <button id="save">Save settings</button>
          <button id="wizardSave" class="secondary">Save recommended setup</button>
          <button id="exportProfile" class="ghost">Export profile</button>
          <button id="importProfile" class="ghost">Import profile</button>
        </div>
        <div id="status" class="status"></div>
      </div>

      <div class="card">
        <h2>Advanced options</h2>
        <div class="sub">Hidden by default for simplicity. Open only if you need MCP or custom command rules.</div>
        <details class="advanced">
          <summary>Open advanced configuration</summary>
          <div class="advancedBody">
            <div class="field"><label>MCP approval style</label><select id="mcpApprovalMode"><option value="always">Ask before MCP actions</option><option value="destructive">Ask before risky MCP actions</option><option value="auto">Run MCP actions automatically</option></select></div>
            <div class="actions" style="margin-bottom:12px;"><button id="mcp" class="secondary">Open MCP status</button></div>
            <div class="field"><label>MCP servers JSON</label><textarea id="mcpServersJson" placeholder='[{"id":"server","command":"node","args":["server.js"]}]'></textarea><div class="inlineHelp">For advanced integrations only. Most users can leave this empty.</div></div>
            <div class="field"><label>Auto-approve command patterns JSON</label><textarea id="autoApproveCommandPatternsJson" placeholder='["^npm test","^pytest( |$)"]'></textarea><div class="inlineHelp">Optional regex list for commands that should be auto-approved.</div></div>
          </div>
        </details>
      </div>

      <div class="card">
        <h2>Diagnostics</h2>
        <div class="sub">Helpful checks and hints if setup is not working yet.</div>
        <div id="diagnostics" class="diagList"></div>
      </div>
    </div>
  </div>
</div>
<script nonce="${nonce}">
(function(){
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  function setStatus(text, ok) {
    const el = $('status');
    el.textContent = text || '';
    el.style.color = ok === undefined ? 'var(--vscode-descriptionForeground)' : (ok ? 'var(--ok)' : 'var(--bad)');
  }
  function payload() {
    return {
      endpoint: $('endpoint').value.trim(),
      deployment: $('deployment').value.trim(),
      apiVersion: $('apiVersion').value.trim(),
      apiKey: $('apiKey').value.trim(),
      webSearchProvider: $('webSearchProvider').value,
      webSearchKey: $('webSearchKey').value.trim(),
      approvalMode: $('approvalMode').value,
      mcpApprovalMode: $('mcpApprovalMode').value,
      webBrowsingEnabled: $('webBrowsingEnabled').checked,
      scrubSecrets: $('scrubSecrets').checked,
      compactMode: $('compactMode').checked,
      mcpServersJson: $('mcpServersJson').value.trim(),
      autoApproveCommandPatternsJson: $('autoApproveCommandPatternsJson').value.trim()
    };
  }
  function renderHealth(h) {
    const items = [
      ['Endpoint', h.endpointValid ? 'Ready' : 'Needs attention', h.endpointValid ? 'ok' : 'bad'],
      ['API key', h.keyPresent ? 'Stored' : 'Missing', h.keyPresent ? 'ok' : 'bad'],
      ['Deployment', h.deploymentReachable ? 'Reachable' : 'Not verified yet', h.deploymentReachable ? 'ok' : 'warn'],
      ['Web search', h.searchConfigured ? 'Configured' : 'Optional', h.searchConfigured ? 'ok' : 'warn'],
      ['Workspace trust', h.workspaceTrusted ? 'Trusted' : 'Restricted', h.workspaceTrusted ? 'ok' : 'warn']
    ];
    $('health').innerHTML = items.map(([label, state, cls]) => '<div class="item"><div class="label">' + label + '</div><div class="state ' + cls + '">' + state + '</div></div>').join('');
  }
  function updateSummary(s) {
    const configured = [!!s.endpoint, !!s.deployment, !!s.hasApiKey].filter(Boolean).length;
    $('kpiConfigured').textContent = configured + '/3';
    $('kpiSearch').textContent = s.webBrowsingEnabled ? 'On' : 'Off';
    $('kpiSafety').textContent = s.approvalMode === 'always' ? 'Safe' : (s.approvalMode === 'destructive' ? 'Balanced' : 'Fast');
  }
  function applyStarter(kind) {
    if (kind === 'safe') {
      $('approvalMode').value = 'always';
      $('webBrowsingEnabled').checked = false;
      $('scrubSecrets').checked = true;
      $('mcpApprovalMode').value = 'always';
    } else {
      $('approvalMode').value = 'destructive';
      $('webBrowsingEnabled').checked = true;
      $('scrubSecrets').checked = true;
      $('mcpApprovalMode').value = 'destructive';
    }
    updateSummary({
      endpoint: $('endpoint').value.trim(),
      deployment: $('deployment').value.trim(),
      hasApiKey: !!$('apiKey').placeholder,
      webBrowsingEnabled: $('webBrowsingEnabled').checked,
      approvalMode: $('approvalMode').value
    });
    setStatus('Preset applied in the form. Click Save settings to keep it.');
  }
  $('save').addEventListener('click', () => { setStatus('Saving…'); vscode.postMessage({ type: 'save', payload: payload() }); });
  $('wizardSave').addEventListener('click', () => { applyStarter('balanced'); setStatus('Saving…'); vscode.postMessage({ type: 'save', payload: payload() }); });
  $('test').addEventListener('click', () => { setStatus('Testing connection…'); const p = payload(); vscode.postMessage({ type: 'test', payload: { endpoint: p.endpoint, deployment: p.deployment, apiVersion: p.apiVersion, apiKey: p.apiKey } }); });
  $('wizardTest').addEventListener('click', () => { setStatus('Testing connection…'); const p = payload(); vscode.postMessage({ type: 'test', payload: { endpoint: p.endpoint, deployment: p.deployment, apiVersion: p.apiVersion, apiKey: p.apiKey } }); });
  $('wizardFillSafe').addEventListener('click', () => applyStarter('safe'));
  $('wizardFillBalanced').addEventListener('click', () => applyStarter('balanced'));
  $('copyCurl').addEventListener('click', () => { const p = payload(); vscode.postMessage({ type: 'copyCurl', payload: { endpoint: p.endpoint, deployment: p.deployment, apiVersion: p.apiVersion } }); });
  $('mcp').addEventListener('click', () => vscode.postMessage({ type: 'mcp' }));
  $('exportProfile').addEventListener('click', () => vscode.postMessage({ type: 'exportProfile' }));
  $('importProfile').addEventListener('click', () => vscode.postMessage({ type: 'importProfile' }));
  document.querySelectorAll('[data-preset]').forEach(el => el.addEventListener('click', () => vscode.postMessage({ type: 'preset', preset: el.getAttribute('data-preset') })));
  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'snapshot') {
      const s = msg.snapshot;
      $('endpoint').value = s.endpoint || '';
      $('deployment').value = s.deployment || '';
      $('apiVersion').value = s.apiVersion || '';
      $('approvalMode').value = s.approvalMode || 'destructive';
      $('webSearchProvider').value = s.webSearchProvider || 'duckduckgo';
      $('webBrowsingEnabled').checked = !!s.webBrowsingEnabled;
      $('scrubSecrets').checked = !!s.scrubSecrets;
      $('mcpApprovalMode').value = s.mcpApprovalMode || 'destructive';
      $('compactMode').checked = !!s.compactMode;
      $('mcpServersJson').value = s.mcpServersJson || '[]';
      $('autoApproveCommandPatternsJson').value = s.autoApproveCommandPatternsJson || '[]';
      $('apiKey').placeholder = s.hasApiKey ? 'Stored key exists — leave blank to keep it' : 'No stored key yet';
      $('webSearchKey').placeholder = s.hasWebSearchKey ? 'Stored key exists — leave blank to keep it' : 'No stored key yet';
      $('deploymentSuggestions').innerHTML = (s.deploymentSuggestions || []).map(v => '<option value="' + String(v).replace(/"/g, '&quot;') + '"></option>').join('');
      $('diagnostics').innerHTML = (s.diagnostics || []).map(v => '<div class="diagItem">' + String(v) + '</div>').join('');
      renderHealth(s.health);
      updateSummary(s);
      setStatus('Loaded current settings.');
    } else if (msg.type === 'saveResult' || msg.type === 'testResult' || msg.type === 'actionResult') {
      setStatus(msg.message, !!msg.ok);
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
    }
}
