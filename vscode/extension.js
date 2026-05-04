const vscode = require("vscode");
const path = require("path");
const cp = require("child_process");
const readline = require("readline");

const REQUIRED_PYTHON_MODULES = ["requests"];
const BACKEND_REQUIREMENTS_FILE = "requirements-vscode.txt";


class AgentBackendClient {
  constructor(context, output) {
    this.context = context;
    this.output = output;
    this.proc = null;
    this.stdoutReader = null;
    this.pending = new Map();
    this.listeners = new Set();
    this.sequence = 0;
    this.startPromise = null;
    this.dependencyPrompts = new Set();
  }

  dispose() {
    const pending = Array.from(this.pending.values());
    this.pending.clear();
    for (const entry of pending) {
      entry.reject(new Error("Agent backend was disposed."));
    }

    if (this.stdoutReader) {
      this.stdoutReader.close();
      this.stdoutReader = null;
    }
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return new vscode.Disposable(() => this.listeners.delete(listener));
  }

  async initialize(workspacePath) {
    await this.ensureStarted(workspacePath);
    return this.request("initialize", { workspace: workspacePath || "" });
  }

  async request(method, params = {}) {
    await this.ensureStarted();
    if (!this.proc || !this.proc.stdin) {
      throw new Error("Agent backend is not running.");
    }

    const id = String(++this.sequence);
    const payload = JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.proc.stdin.write(payload + "\n", "utf8", (error) => {
        if (!error) {
          return;
        }
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async ensureStarted(workspacePath = "") {
    if (this.proc) {
      return;
    }
    if (!this.startPromise) {
      this.startPromise = this._spawnWithFallbacks(workspacePath).finally(() => {
        this.startPromise = null;
      });
    }
    await this.startPromise;
  }

  async installDependencies(preferredExecutable = "", workspacePath = "") {
    let lastError = null;
    const candidates = preferredExecutable
      ? [preferredExecutable]
      : this._pythonCandidates();

    for (const executable of candidates) {
      try {
        await this._installDependencies(executable, workspacePath);
        return { executable };
      } catch (error) {
        lastError = error;
        this.output.appendLine(
          `[setup] dependency install failed with ${executable}: ${error.message}`
        );
      }
    }

    throw lastError || new Error("Could not install backend dependencies.");
  }

  async _spawnWithFallbacks(workspacePath = "") {
    let lastError = null;
    for (const executable of this._pythonCandidates()) {
      try {
        let inspection = await this._inspectPython(executable, workspacePath);
        if (inspection.missing.length) {
          const installed = await this._offerDependencyInstall(
            executable,
            inspection,
            workspacePath
          );
          if (installed) {
            inspection = await this._inspectPython(executable, workspacePath);
          }
          if (inspection.missing.length) {
            throw new Error(
              `Missing Python modules: ${inspection.missing.join(", ")}.`
            );
          }
        }

        await this._spawn(executable, workspacePath);
        this.output.appendLine(
          `[backend] started with ${inspection.python || executable}`
        );
        return;
      } catch (error) {
        lastError = error;
        this.output.appendLine(
          `[backend] failed with ${executable}: ${error.message}`
        );
      }
    }
    throw lastError || new Error("Could not start the Python backend.");
  }

  _pythonCandidates() {
    const configured = String(
      vscode.workspace.getConfiguration("agentVs").get("pythonPath") || "python"
    ).trim();
    const candidates = [];
    if (configured) {
      candidates.push(configured);
    }
    if (process.platform === "win32" && configured.toLowerCase() !== "py") {
      candidates.push("py");
    }
    return candidates;
  }

  _pythonArgs(executable, args) {
    if (process.platform === "win32" && executable.toLowerCase() === "py") {
      return ["-3", ...args];
    }
    return args;
  }

  _backendEnv(workspacePath = "") {
    const env = { ...process.env, PYTHONIOENCODING: "utf-8" };
    const configuredEnvFile = String(
      vscode.workspace.getConfiguration("agentVs").get("envFile") || ""
    ).trim();
    if (configuredEnvFile) {
      env.AGENT_ENV_FILE = configuredEnvFile;
    }
    if (workspacePath) {
      env.AGENT_WORKSPACE = workspacePath;
    }
    return env;
  }

  _requirementsPath() {
    return path.join(this.context.extensionPath, BACKEND_REQUIREMENTS_FILE);
  }

  _inspectPython(executable, workspacePath = "") {
    const script = [
      "import importlib.util, json, sys",
      `required = ${JSON.stringify(REQUIRED_PYTHON_MODULES)}`,
      "missing = [name for name in required if importlib.util.find_spec(name) is None]",
      "print(json.dumps({'python': sys.executable, 'version': sys.version.split()[0], 'missing': missing}))",
    ].join("; ");

    return new Promise((resolve, reject) => {
      cp.execFile(
        executable,
        this._pythonArgs(executable, ["-c", script]),
        {
          cwd: this.context.extensionPath,
          env: this._backendEnv(workspacePath),
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(
              new Error(
                (stderr || stdout || error.message || "Python probe failed.").trim()
              )
            );
            return;
          }

          try {
            resolve(JSON.parse(String(stdout || "").trim()));
          } catch (parseError) {
            reject(
              new Error(
                `Python probe returned invalid output: ${String(stdout || "").trim()}`
              )
            );
          }
        }
      );
    });
  }

  async _offerDependencyInstall(executable, inspection, workspacePath = "") {
    const shouldPrompt = Boolean(
      vscode.workspace
        .getConfiguration("agentVs")
        .get("promptInstallDependencies", true)
    );
    if (!shouldPrompt) {
      return false;
    }

    const key = `${executable}:${inspection.missing.join(",")}`;
    if (this.dependencyPrompts.has(key)) {
      return false;
    }
    this.dependencyPrompts.add(key);

    const action = await vscode.window.showWarningMessage(
      `Agent VS is missing Python modules (${inspection.missing.join(
        ", "
      )}) for ${inspection.python || executable}.`,
      "Install Dependencies",
      "Show Output"
    );

    if (action === "Show Output") {
      this.output.show(true);
      return false;
    }
    if (action !== "Install Dependencies") {
      return false;
    }

    try {
      await this._installDependencies(executable, workspacePath);
      vscode.window.showInformationMessage(
        "Agent VS backend dependencies installed. Reopen the panel or retry your action."
      );
      return true;
    } catch (error) {
      this.output.show(true);
      vscode.window.showErrorMessage(
        `Could not install Agent VS backend dependencies: ${error.message}`
      );
      return false;
    }
  }

  _installDependencies(executable, workspacePath = "") {
    const requirementsPath = this._requirementsPath();
    const args = this._pythonArgs(executable, [
      "-m",
      "pip",
      "install",
      "-r",
      requirementsPath,
    ]);

    this.output.show(true);
    this.output.appendLine(
      `[setup] installing backend dependencies with ${executable}`
    );

    return new Promise((resolve, reject) => {
      const proc = cp.spawn(executable, args, {
        cwd: this.context.extensionPath,
        env: this._backendEnv(workspacePath),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let combined = "";
      proc.stdout.on("data", (chunk) => {
        const text = chunk.toString();
        combined += text;
        this.output.append(text);
      });
      proc.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        combined += text;
        this.output.append(text);
      });
      proc.once("error", (error) => reject(error));
      proc.once("exit", (code) => {
        if (code === 0) {
          this.output.appendLine("[setup] dependency install completed");
          resolve();
          return;
        }
        reject(
          new Error(
            (combined.trim() || `pip exited with code ${code}.`).slice(-1200)
          )
        );
      });
    });
  }

  _spawn(executable, workspacePath = "") {
    return new Promise((resolve, reject) => {
      const args = this._pythonArgs(executable, ["-u", "-m", "agent.vscode_bridge"]);
      const proc = cp.spawn(executable, args, {
        cwd: this.context.extensionPath,
        env: this._backendEnv(workspacePath),
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let reader = null;
      let stderrBuffer = "";

      let settled = false;
      const startupTimer = setTimeout(() => {
        fail(new Error("Timed out waiting for the Python backend to start."));
      }, 15000);

      const fail = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(startupTimer);
        if (reader) {
          reader.close();
        }
        try {
          proc.kill();
        } catch (_) {
          // Best effort.
        }
        const tail = stderrBuffer.trim().slice(-800);
        if (tail) {
          reject(new Error(`${error.message}\n${tail}`));
          return;
        }
        reject(error);
      };

      const succeed = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(startupTimer);
        this.proc = proc;
        this.stdoutReader = reader;
        proc.on("exit", (code, signal) => this._handleExit(code, signal));
        resolve();
      };

      proc.once("error", fail);
      proc.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        stderrBuffer += text;
        this.output.append(text);
      });

      reader = readline.createInterface({ input: proc.stdout });
      reader.on("line", (line) => {
        const message = this._safeParseMessage(line);
        if (!message) {
          return;
        }
        if (message.type === "ready") {
          succeed();
          return;
        }
        this._handleMessage(message);
      });

      proc.once("exit", (code, signal) => {
        if (!settled) {
          fail(
            new Error(
              `Python backend exited before ready (code ${code}, signal ${
                signal || "none"
              }).`
            )
          );
        }
      });
    });
  }

  _safeParseMessage(line) {
    const text = String(line || "").trim();
    if (!text) {
      return null;
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      this.output.appendLine(`[backend] non-JSON stdout: ${text}`);
      return null;
    }
  }

  _handleMessage(message) {
    if (message.type === "response") {
      const pending = this.pending.get(String(message.id));
      if (!pending) {
        return;
      }
      this.pending.delete(String(message.id));
      if (message.ok) {
        pending.resolve(message.result);
      } else {
        pending.reject(new Error(message.error || "Unknown backend error."));
      }
      return;
    }

    if (message.type === "event") {
      for (const listener of this.listeners) {
        try {
          listener(message.event);
        } catch (_) {
          // Listener failures should not break the bridge.
        }
      }
    }
  }

  _handleExit(code, signal) {
    const description = `Agent backend exited (code ${code}, signal ${signal || "none"}).`;
    this.output.appendLine(`[backend] ${description}`);

    if (this.stdoutReader) {
      this.stdoutReader.close();
      this.stdoutReader = null;
    }
    this.proc = null;

    const pending = Array.from(this.pending.values());
    this.pending.clear();
    for (const entry of pending) {
      entry.reject(new Error(description));
    }

    const event = {
      type: "error",
      ts: Date.now() / 1000,
      message: description,
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (_) {
        // Ignore downstream failures.
      }
    }
  }
}


class AgentSidebarProvider {
  constructor(context) {
    this.context = context;
    this.output = vscode.window.createOutputChannel("Agent VS");
    this.backend = new AgentBackendClient(context, this.output);
    this.view = null;
    this.refreshTimer = null;

    this.disposables = [
      this.output,
      this.backend,
      this.backend.onEvent((event) => this._onBackendEvent(event)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()),
      vscode.workspace.onDidSaveTextDocument(() => this._scheduleRefresh(250)),
    ];
  }

  dispose() {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    vscode.Disposable.from(...this.disposables).dispose();
  }

  showOutput() {
    this.output.show(true);
  }

  async installDependencies() {
    try {
      const result = await this.backend.installDependencies(
        "",
        this._workspacePath()
      );
      vscode.window.showInformationMessage(
        `Agent VS backend dependencies installed with ${result.executable}.`
      );
      this._scheduleRefresh(150);
    } catch (error) {
      this._showError(
        `Could not install Agent VS backend dependencies: ${error.message}`
      );
    }
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "vscode", "media")],
    };
    webviewView.webview.html = this._htmlForWebview(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((message) => {
      this._handleViewMessage(message);
    });
    this.refresh();
  }

  async refresh() {
    if (!this.view) {
      return;
    }

    const workspacePath = this._workspacePath();
    if (!workspacePath) {
      this._postToView({
        type: "hydrate",
        payload: {
          workspaceMissing: true,
          events: [],
          files: { files: [] },
          state: { plan: [], running: false, finished: false },
          health: {},
        },
      });
      return;
    }

    try {
      const snapshot = await this.backend.initialize(workspacePath);
      this._postToView({
        type: "hydrate",
        payload: {
          workspaceMissing: false,
          workspacePath,
          ...snapshot,
        },
      });
    } catch (error) {
      this._showError(`Could not initialize Agent VS: ${error.message}`);
    }
  }

  async _handleViewMessage(message) {
    const type = message && message.type;
    if (!type) {
      return;
    }

    if (type === "ready" || type === "refresh") {
      await this.refresh();
      return;
    }

    if (type === "installDependencies") {
      await this.installDependencies();
      return;
    }

    if (type === "showOutput") {
      this.showOutput();
      return;
    }

    if (type === "start") {
      await this._startGoal(message.goal, message.maxIterations);
      return;
    }

    if (type === "stop") {
      await this._runBackendAction("stop");
      return;
    }

    if (type === "reset") {
      await this._runBackendAction("reset_memory");
      await this.refresh();
      return;
    }

    if (type === "testConnection") {
      await this._testConnection();
      return;
    }

    if (type === "openFile") {
      await this._openWorkspaceFile(message.path);
      return;
    }
  }

  async _startGoal(goal, maxIterations) {
    const workspacePath = this._workspacePath();
    if (!workspacePath) {
      this._showError("Open a folder in VS Code before starting the agent.");
      return;
    }

    const iterations =
      Number(maxIterations) ||
      Number(vscode.workspace.getConfiguration("agentVs").get("maxIterations")) ||
      60;

    try {
      await this.backend.initialize(workspacePath);
      await this.backend.request("start", {
        goal: String(goal || "").trim(),
        max_iterations: iterations,
      });
      this._scheduleRefresh(150);
    } catch (error) {
      this._showError(error.message);
    }
  }

  async _runBackendAction(method, params = {}) {
    try {
      const workspacePath = this._workspacePath();
      if (workspacePath) {
        await this.backend.initialize(workspacePath);
      }
      await this.backend.request(method, params);
    } catch (error) {
      this._showError(error.message);
    }
  }

  async _testConnection() {
    try {
      const workspacePath = this._workspacePath();
      if (workspacePath) {
        await this.backend.initialize(workspacePath);
      }
      const result = await this.backend.request("test_connection");
      vscode.window.showInformationMessage(
        `Agent VS connected to ${result.model}: ${result.reply}`
      );
      await this.refresh();
    } catch (error) {
      this._showError(error.message);
    }
  }

  async _openWorkspaceFile(relativePath) {
    const workspacePath = this._workspacePath();
    if (!workspacePath || !relativePath) {
      return;
    }

    const target = path.join(workspacePath, relativePath);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
    await vscode.window.showTextDocument(document, { preview: false });
  }

  _onBackendEvent(event) {
    this._postToView({ type: "backendEvent", event });

    const eventType = event && event.type;
    if (["observation", "finished", "run_done", "plan"].includes(eventType)) {
      this._scheduleRefresh(350);
    }
  }

  _scheduleRefresh(delayMs) {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.refresh();
    }, delayMs);
  }

  _workspacePath() {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
  }

  _postToView(message) {
    if (this.view) {
      this.view.webview.postMessage(message);
    }
  }

  _showError(message) {
    this.output.show(true);
    this.output.appendLine(`[error] ${message}`);
    vscode.window.showErrorMessage(message);
    this._postToView({ type: "error", message });
  }

  _htmlForWebview(webview) {
    const nonce = String(Date.now()) + String(Math.random()).slice(2);
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "vscode", "media", "panel.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "vscode", "media", "panel.css")
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src ${webview.cspSource} https:; style-src ${webview.cspSource}; script-src ${webview.cspSource} 'nonce-${nonce}';"
  />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Agent VS</title>
</head>
<body>
  <div class="shell">
    <header class="hero">
      <div>
        <div class="eyebrow">Agent VS</div>
        <h1>Workspace Copilot</h1>
        <p>Plan, run, inspect, and iterate without leaving VS Code.</p>
      </div>
      <div class="hero-badges">
        <span id="statusBadge" class="badge badge-idle">idle</span>
        <span id="healthBadge" class="badge">booting</span>
      </div>
    </header>

    <section id="workspaceMissing" class="empty-state hidden">
      Open a folder in VS Code to attach Agent VS to a workspace.
    </section>

    <section id="mainContent" class="stack hidden">
      <div class="facts">
        <article class="fact-card">
          <span class="fact-label">Workspace</span>
          <span id="workspacePath" class="fact-value">-</span>
        </article>
        <article class="fact-card">
          <span class="fact-label">Model</span>
          <span id="modelName" class="fact-value">-</span>
        </article>
        <article class="fact-card">
          <span class="fact-label">Runtime</span>
          <span id="runtimePath" class="fact-value">-</span>
        </article>
      </div>

      <section class="tool-row">
        <button id="refreshBtn" class="ghost-button">Refresh</button>
        <button id="installBtn" class="ghost-button">Install Backend</button>
        <button id="outputBtn" class="ghost-button">Open Output</button>
        <button id="testBtn" class="ghost-button">Test API</button>
        <button id="resetBtn" class="ghost-button danger">Reset Memory</button>
      </section>

      <section class="panel">
        <div class="panel-head">
          <span>Plan</span>
          <span id="iterationMeta" class="panel-meta">No run yet</span>
        </div>
        <ol id="planList" class="plan-list"></ol>
      </section>

      <section class="panel">
        <div class="panel-head">
          <span>Workspace Files</span>
          <span id="fileCount" class="panel-meta">0</span>
        </div>
        <div id="filesList" class="files-list"></div>
      </section>

      <section class="panel log-panel">
        <div class="panel-head">
          <span>Session Feed</span>
          <span id="eventCount" class="panel-meta">0</span>
        </div>
        <div id="eventsLog" class="events-log"></div>
      </section>

      <section class="composer">
        <label class="composer-label" for="goalInput">Goal</label>
        <textarea id="goalInput" rows="4" placeholder="Build or refactor something in the current workspace."></textarea>
        <div class="composer-actions">
          <label class="iter-field">
            <span>Iter cap</span>
            <input id="maxIterations" type="number" min="1" max="500" />
          </label>
          <button id="stopBtn" class="ghost-button">Stop</button>
          <button id="runBtn" class="primary-button">Run</button>
        </div>
      </section>
    </section>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}


function activate(context) {
  const provider = new AgentSidebarProvider(context);

  context.subscriptions.push(
    provider,
    vscode.window.registerWebviewViewProvider("agentVs.sidebar", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("agentVs.openPanel", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.agentVs");
    }),
    vscode.commands.registerCommand("agentVs.installDependencies", async () => {
      await provider.installDependencies();
    }),
    vscode.commands.registerCommand("agentVs.showOutput", () => {
      provider.showOutput();
    })
  );
}


function deactivate() {}


module.exports = {
  activate,
  deactivate,
};
