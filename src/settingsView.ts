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
  --border: var(--vscode-panel-border);
  --card: var(--vscode-editorWidget-background);
  --accent: var(--vscode-button-background);
}
* { box-sizing: border-box; }
body { margin: 0; padding: 24px; background: var(--bg); color: var(--fg); font-family: var(--vscode-font-family); }
.container { max-width: 980px; margin: 0 auto; }
.hero { display:flex; justify-content:space-between; align-items:center; gap:16px; margin-bottom:20px; }
.hero h1 { margin:0; font-size:24px; }
.hero p { margin:6px 0 0; color: var(--muted); }
.badge { padding:6px 10px; border-radius:999px; border:1px solid var(--border); background: color-mix(in srgb, var(--accent) 18%, transparent); }
.grid { display:grid; grid-template-columns: 1fr 1fr; gap:16px; }
.card { background: var(--card); border:1px solid var(--border); border-radius:16px; padding:16px; box-shadow: 0 10px 30px rgba(0,0,0,.12); }
.card h2 { margin:0 0 12px; font-size:16px; }
.field { margin-bottom:12px; }
label { display:block; font-size:12px; color: var(--muted); margin-bottom:6px; }
input, select, textarea { width:100%; padding:10px 12px; border-radius:10px; border:1px solid var(--border); background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
textarea { min-height: 110px; resize: vertical; font-family: var(--vscode-editor-font-family, monospace); }
.row { display:flex; gap:10px; flex-wrap:wrap; }
.actions { display:flex; gap:10px; margin-top:16px; flex-wrap:wrap; }
button { border:0; border-radius:10px; padding:10px 14px; cursor:pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.status { margin-top:14px; min-height:20px; color: var(--muted); }
.note { color: var(--muted); font-size:12px; }
.health { display:grid; grid-template-columns: 1fr 1fr; gap:8px; }
.health .item { border:1px solid var(--border); border-radius:12px; padding:10px; }
.health .ok { color: var(--vscode-testing-iconPassed); }
.health .bad { color: var(--vscode-errorForeground); }
.preset { min-width: 140px; }
@media (max-width: 760px) { .grid, .health { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<div class="container">
  <div class="hero">
    <div>
      <h1>Azure AI Agent Settings</h1>
      <p>Simple setup for endpoint, deployment, keys, safety, browsing, and presets.</p>
    </div>
    <div class="badge">Modern setup</div>
  </div>
  <div class="card" style="margin-bottom:16px;">
    <h2>Quick start wizard</h2>
    <div class="note">Step 1: connection. Step 2: search. Step 3: safety. Step 4: save and test.</div>
    <div class="actions">
      <button id="wizardFillSafe" class="secondary">Apply safe starter</button>
      <button id="wizardFillBalanced" class="secondary">Apply balanced starter</button>
      <button id="wizardTest">Test now</button>
      <button id="wizardSave">Save now</button>
    </div>
  </div>
  <div class="card" style="margin-bottom:16px;">
    <h2>Onboarding health</h2>
    <div id="health" class="health"></div>
  </div>
  <div class="grid">
    <div class="card">
      <h2>Connection</h2>
      <div class="field"><label>Endpoint</label><input id="endpoint" placeholder="https://your-resource.openai.azure.com/" /></div>
      <div class="field"><label>Deployment</label><input id="deployment" list="deploymentSuggestions" placeholder="gpt-5.4" /></div>
      <datalist id="deploymentSuggestions"></datalist>
      <div class="field"><label>API version</label><input id="apiVersion" placeholder="2024-12-01-preview" /></div>
      <div class="field"><label>Azure API key</label><input id="apiKey" type="password" placeholder="Leave blank to keep existing stored key" /></div>
      <div class="actions">
        <button id="test">Test connection</button>
        <button id="copyCurl" class="secondary">Copy curl test</button>
      </div>
      <div class="note">API keys are stored in VS Code SecretStorage.</div>
    </div>
    <div class="card">
      <h2>Behavior</h2>
      <div class="field"><label>Approval mode</label><select id="approvalMode"><option value="auto">auto</option><option value="destructive">destructive</option><option value="always">always</option></select></div>
      <div class="field"><label>Web search provider</label><select id="webSearchProvider"><option value="duckduckgo">duckduckgo</option><option value="tavily">tavily</option><option value="brave">brave</option></select></div>
      <div class="field"><label>Web search API key</label><input id="webSearchKey" type="password" placeholder="Leave blank to keep existing stored key" /></div>
      <div class="field"><label>Web browsing enabled</label><select id="webBrowsingEnabled"><option value="true">true</option><option value="false">false</option></select></div>
      <div class="field"><label>Secret scrubbing</label><select id="scrubSecrets"><option value="true">true</option><option value="false">false</option></select></div>
      <div class="field"><label>MCP approval mode</label><select id="mcpApprovalMode"><option value="auto">auto</option><option value="destructive">destructive</option><option value="always">always</option></select></div>
      <div class="field"><label>Compact mode</label><select id="compactMode"><option value="false">false</option><option value="true">true</option></select></div>
      <div class="field"><label>MCP servers JSON</label><textarea id="mcpServersJson" placeholder='[{"id":"server","command":"node","args":["server.js"]}]'></textarea></div>
      <div class="field"><label>Auto-approve command patterns JSON</label><textarea id="autoApproveCommandPatternsJson" placeholder='["^npm test","^pytest( |$)"]'></textarea></div>
      <div class="actions">
        <button id="save">Save settings</button>
        <button id="mcp" class="secondary">MCP status</button>
      </div>
    </div>
  </div>
  <div class="card" style="margin-top:16px;">
    <h2>Presets & profiles</h2>
    <div class="actions">
      <button class="preset" data-preset="safe">Safe mode</button>
      <button class="preset" data-preset="balanced">Balanced mode</button>
      <button class="preset" data-preset="power">Power-user mode</button>
      <button id="exportProfile" class="secondary">Export profile</button>
      <button id="importProfile" class="secondary">Import profile</button>
    </div>
    <div class="note">Presets adjust approval mode, browsing, and safety defaults. Profiles let you move settings between workspaces.</div>
  </div>
  <div class="card" style="margin-top:16px;">
    <h2>Connection diagnostics</h2>
    <div id="diagnostics" class="note"></div>
  </div>
  <div id="status" class="status"></div>
</div>
<script nonce="${nonce}">
(function(){
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  function setStatus(text, ok) {
    const el = $('status');
    el.textContent = text || '';
    el.style.color = ok === undefined ? 'var(--vscode-descriptionForeground)' : (ok ? 'var(--vscode-testing-iconPassed)' : 'var(--vscode-errorForeground)');
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
      webBrowsingEnabled: $('webBrowsingEnabled').value === 'true',
      scrubSecrets: $('scrubSecrets').value === 'true',
      compactMode: $('compactMode').value === 'true',
      mcpServersJson: $('mcpServersJson').value.trim(),
      autoApproveCommandPatternsJson: $('autoApproveCommandPatternsJson').value.trim()
    };
  }
  function renderHealth(h) {
    const items = [
      ['Endpoint valid', h.endpointValid],
      ['API key present', h.keyPresent],
      ['Deployment reachable', h.deploymentReachable],
      ['Search configured', h.searchConfigured],
      ['Workspace trusted', h.workspaceTrusted]
    ];
    $('health').innerHTML = items.map(([label, ok]) => '<div class="item"><div>' + label + '</div><div class="' + (ok ? 'ok' : 'bad') + '">' + (ok ? 'OK' : 'Needs attention') + '</div></div>').join('');
  }
  function applyStarter(kind) {
    if (kind === 'safe') {
      $('approvalMode').value = 'always';
      $('webBrowsingEnabled').value = 'false';
      $('scrubSecrets').value = 'true';
      $('mcpApprovalMode').value = 'always';
    } else {
      $('approvalMode').value = 'destructive';
      $('webBrowsingEnabled').value = 'true';
      $('scrubSecrets').value = 'true';
      $('mcpApprovalMode').value = 'destructive';
    }
    setStatus('Starter preset applied in the form. Save to persist.');
  }
  $('save').addEventListener('click', () => { setStatus('Saving…'); vscode.postMessage({ type: 'save', payload: payload() }); });
  $('wizardSave').addEventListener('click', () => { setStatus('Saving…'); vscode.postMessage({ type: 'save', payload: payload() }); });
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
      $('webBrowsingEnabled').value = String(!!s.webBrowsingEnabled);
      $('scrubSecrets').value = String(!!s.scrubSecrets);
      $('mcpApprovalMode').value = s.mcpApprovalMode || 'destructive';
      $('compactMode').value = String(!!s.compactMode);
      $('mcpServersJson').value = s.mcpServersJson || '[]';
      $('autoApproveCommandPatternsJson').value = s.autoApproveCommandPatternsJson || '[]';
      $('apiKey').placeholder = s.hasApiKey ? 'Stored key exists — leave blank to keep it' : 'No stored key yet';
      $('webSearchKey').placeholder = s.hasWebSearchKey ? 'Stored key exists — leave blank to keep it' : 'No stored key yet';
      $('deploymentSuggestions').innerHTML = (s.deploymentSuggestions || []).map(v => '<option value="' + String(v).replace(/"/g, '&quot;') + '"></option>').join('');
      $('diagnostics').innerHTML = (s.diagnostics || []).map(v => '<div>• ' + String(v) + '</div>').join('');
      renderHealth(s.health);
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
