// VS Code-style frontend for the autonomous coding agent.
// Talks to the Flask server in gui/server.py via fetch + EventSource.

(() => {
  // ---- DOM refs ---------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const fileTree   = $("file-tree");
  const tabName    = $("tab-name");
  const editor     = $("editor-area");
  const editorStatus = $("editor-status");
  const saveBtn    = $("save-file");
  const refreshBtn = $("refresh-files");
  const wsPath     = $("workspace-path");

  const planList   = $("plan-list");
  const chatLog    = $("chat-log");
  const goalInput  = $("goal-input");
  const sendBtn    = $("send-btn");
  const stopBtn    = $("stop-btn");
  const clearBtn   = $("clear-chat");
  const resetBtn   = $("reset-btn");
  const maxIter    = $("max-iter");
  const statusPill = $("status-pill");
  const healthPill = $("health-pill");
  const testConnBtn = $("test-conn-btn");

  // Open Folder modal
  const openFolderBtn = $("open-folder-btn");
  const folderModal   = $("folder-modal");
  const folderClose   = $("folder-close");
  const folderCancel  = $("folder-cancel");
  const folderOpen    = $("folder-open");
  const folderPath    = $("folder-path");
  const folderGo      = $("folder-go");
  const folderList    = $("folder-list");
  const folderCurrent = $("folder-current");

  // New file inline row
  const newFileBtn    = $("new-file-btn");
  const newFileRow    = $("new-file-row");
  const newFileInput  = $("new-file-input");
  const newFileCreate = $("new-file-create");
  const newFileCancel = $("new-file-cancel");

  let modalCurrentPath = "";

  // ---- State ------------------------------------------------------------
  let openFile = null;
  let originalContent = "";
  let isRunning = false;

  // ---- Helpers ----------------------------------------------------------
  const escapeHtml = (s) =>
    String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");

  const fmtTime = (ts) => {
    const d = new Date((ts || Date.now() / 1000) * 1000);
    return d.toLocaleTimeString([], { hour12: false });
  };

  const setStatus = (label, cls) => {
    statusPill.textContent = label;
    statusPill.className = `pill pill-${cls}`;
  };

  const setRunning = (running) => {
    isRunning = running;
    sendBtn.disabled = running;
    stopBtn.disabled = !running;
    resetBtn.disabled = running;
    sendBtn.textContent = running ? "Running…" : "Run";
  };

  // ---- Health -----------------------------------------------------------
  async function loadHealth() {
    try {
      const r = await fetch("/api/health");
      const j = await r.json();
      healthPill.textContent = j.key_set ? `model: ${j.model}` : "API key missing";
      healthPill.className = `pill ${j.key_set ? "pill-finished" : "pill-error"}`;
    } catch {
      healthPill.textContent = "server unreachable";
      healthPill.className = "pill pill-error";
    }
  }

  // ---- Files ------------------------------------------------------------
  async function loadFiles() {
    fileTree.innerHTML = '<li class="empty">Loading…</li>';
    try {
      const r = await fetch("/api/files");
      const j = await r.json();
      wsPath.textContent = j.workspace || "workspace/";
      renderFileTree(j.files || []);
    } catch (e) {
      fileTree.innerHTML = `<li class="empty">Error: ${escapeHtml(e.message)}</li>`;
    }
  }

  function renderFileTree(files) {
    fileTree.innerHTML = "";
    if (!files.length) {
      fileTree.innerHTML =
        '<li class="hint">' +
        'Empty workspace. To get files here, do one of:<br>' +
        '· Click <b>Open Folder</b> (top right) to point at an existing project.<br>' +
        '· Click <b>+</b> above to create a new file.<br>' +
        '· Type a goal in the chat — the agent will create files as it works.' +
        '</li>';
      return;
    }
    for (const f of files) {
      const li = document.createElement("li");
      li.textContent = f.path;
      li.title = f.path;
      li.classList.add(f.is_dir ? "dir" : "file");
      if (f.path === openFile) li.classList.add("active");
      if (!f.is_dir) {
        li.addEventListener("click", () => openFileAt(f.path));
      }
      fileTree.appendChild(li);
    }
  }

  async function openFileAt(path) {
    try {
      const r = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not read file");
      openFile = path;
      originalContent = j.content;
      tabName.textContent = path;
      editor.value = j.content;
      saveBtn.disabled = true;
      editorStatus.textContent = `${j.lines} lines · ${j.bytes} bytes`;
      // refresh active highlight
      [...fileTree.children].forEach((li) =>
        li.classList.toggle("active", li.textContent === path)
      );
    } catch (e) {
      editorStatus.textContent = `Error: ${e.message}`;
    }
  }

  editor.addEventListener("input", () => {
    if (!openFile) return;
    saveBtn.disabled = editor.value === originalContent;
  });

  saveBtn.addEventListener("click", async () => {
    if (!openFile) return;
    saveBtn.disabled = true;
    editorStatus.textContent = "Saving…";
    try {
      const r = await fetch("/api/file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: openFile, content: editor.value }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Save failed");
      originalContent = editor.value;
      editorStatus.textContent = `Saved · ${j.bytes} bytes`;
      loadFiles();
    } catch (e) {
      editorStatus.textContent = `Error: ${e.message}`;
      saveBtn.disabled = false;
    }
  });

  refreshBtn.addEventListener("click", loadFiles);

  // ---- Plan render ------------------------------------------------------
  function renderPlan(plan) {
    if (!plan || !plan.length) {
      planList.innerHTML = '<li class="plan-empty">No plan yet. Send a goal below.</li>';
      return;
    }
    planList.innerHTML = "";
    let foundCurrent = false;
    for (const step of plan) {
      const li = document.createElement("li");
      li.textContent = step.title;
      if (step.done) {
        li.classList.add("done");
      } else if (!foundCurrent) {
        li.classList.add("current");
        foundCurrent = true;
      }
      planList.appendChild(li);
    }
  }

  // ---- Chat render ------------------------------------------------------
  function appendBubble(kind, html, opts = {}) {
    const div = document.createElement("div");
    div.className = `bubble ${kind}${opts.fail ? " fail" : ""}`;
    div.innerHTML = html;
    chatLog.appendChild(div);
    // Auto-scroll only if user is near the bottom
    const nearBottom =
      chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 80;
    if (nearBottom) chatLog.scrollTop = chatLog.scrollHeight;
    return div;
  }

  function handleEvent(evt) {
    const ts = fmtTime(evt.ts);
    const t  = evt.type || evt.kind;

    switch (t) {
      case "run_started": {
        appendBubble("user",
          `<div class="meta">${ts} · YOU</div>${escapeHtml(evt.goal)}`);
        setRunning(true);
        setStatus("running", "running");
        break;
      }
      case "iteration": {
        appendBubble("iteration",
          `── iteration ${evt.n} / ${evt.max} ──`);
        break;
      }
      case "thought": {
        appendBubble("thought",
          `<div class="meta">${ts} · THOUGHT</div>${escapeHtml(evt.message)}`);
        break;
      }
      case "action": {
        const p = evt.payload || {};
        // Only show the high-level "dispatch" action (not the inner run_terminal log)
        if (p.kind === "action" && p.tool) {
          const args = p.args ? `<pre>${escapeHtml(JSON.stringify(p.args, null, 2))}</pre>` : "";
          appendBubble("action",
            `<div class="meta">${ts} · TOOL CALL</div>` +
            `<span class="tool-name">${escapeHtml(p.tool)}</span>${args}`);
        }
        break;
      }
      case "observation": {
        const p = evt.payload || {};
        const ok = p.ok !== false;
        const meta = `${ts} · ${p.tool || "OBSERVATION"} · ${ok ? '<span class="ok">OK</span>' : '<span class="bad">FAIL</span>'}`;
        appendBubble("observation",
          `<div class="meta">${meta}</div>` +
          `<pre>${escapeHtml(p.bytes !== undefined ? `(${p.bytes} bytes of output — see file/log)` : evt.message)}</pre>`,
          { fail: !ok });
        // After tool calls might have written files — refresh tree.
        debouncedRefresh();
        break;
      }
      case "info": {
        // Surface "reflection" info events specially.
        const p = evt.payload || {};
        if (p && p.diagnosis) {
          const goal = p.goal_complete ? '<span class="ok">goal complete</span>' : "";
          appendBubble("reflection",
            `<div class="meta">${ts} · REFLECTION ${goal}</div>` +
            `<div>${escapeHtml(p.diagnosis)}</div>` +
            (p.next ? `<div style="color:var(--text-dim);margin-top:4px">→ ${escapeHtml(p.next)}</div>` : ""));
        } else if (evt.message && !evt.message.startsWith("===")) {
          appendBubble("info",
            `<div class="meta">${ts} · INFO</div>${escapeHtml(evt.message)}`);
        }
        break;
      }
      case "warn": {
        appendBubble("warn",
          `<div class="meta">${ts} · WARN</div>${escapeHtml(evt.message)}`);
        break;
      }
      case "error": {
        const p = evt.payload || {};
        // Surface the underlying error string when present (HTTP status,
        // response body snippet, exception message) — that's what the user
        // actually needs to debug an API call failure.
        const detail = p.error || p.reason || p.detail;
        const detailBlock = detail
          ? `<pre>${escapeHtml(typeof detail === "string" ? detail : JSON.stringify(detail, null, 2))}</pre>`
          : "";
        appendBubble("error",
          `<div class="meta">${ts} · ERROR</div>${escapeHtml(evt.message)}${detailBlock}`);
        break;
      }
      case "plan": {
        renderPlan(evt.plan);
        break;
      }
      case "finished": {
        appendBubble("finished",
          `<div class="meta">${ts} · FINISHED</div>${escapeHtml(evt.summary || "Done.")}`);
        setRunning(false);
        setStatus("finished", "finished");
        if (evt.state && evt.state.plan) renderPlan(evt.state.plan);
        loadFiles();
        break;
      }
      case "run_done": {
        setRunning(false);
        if (evt.state && !evt.state.finished) {
          setStatus("stopped", "stopped");
        }
        loadFiles();
        break;
      }
      case "debug":
        // skip
        break;
      default:
        // Anything else: render compact info
        if (evt.message) {
          appendBubble("info",
            `<div class="meta">${ts} · ${escapeHtml(t || "EVENT")}</div>${escapeHtml(evt.message)}`);
        }
    }
  }

  // Debounce file-tree refresh after observations
  let refreshTimer = null;
  function debouncedRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(loadFiles, 600);
  }

  // ---- SSE wiring -------------------------------------------------------
  let evtSource = null;
  function connectStream() {
    if (evtSource) evtSource.close();
    evtSource = new EventSource("/api/events");
    evtSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        handleEvent(data);
      } catch (err) {
        console.error("Bad SSE payload", err, e.data);
      }
    };
    evtSource.onerror = () => {
      // EventSource auto-reconnects; just visually note it
      healthPill.textContent = "stream reconnecting…";
      healthPill.className = "pill pill-stopped";
      setTimeout(loadHealth, 2000);
    };
  }

  // ---- Controls ---------------------------------------------------------
  sendBtn.addEventListener("click", async () => {
    const goal = goalInput.value.trim();
    if (!goal) return;
    const max = parseInt(maxIter.value, 10) || 60;
    sendBtn.disabled = true;
    try {
      const r = await fetch("/api/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal, max_iterations: max }),
      });
      const j = await r.json();
      if (!r.ok) {
        appendBubble("error",
          `<div class="meta">ERROR</div>${escapeHtml(j.error || r.statusText)}`);
        sendBtn.disabled = false;
        return;
      }
      goalInput.value = "";
      setRunning(true);
    } catch (e) {
      appendBubble("error", `<div class="meta">ERROR</div>${escapeHtml(e.message)}`);
      sendBtn.disabled = false;
    }
  });

  stopBtn.addEventListener("click", async () => {
    stopBtn.disabled = true;
    await fetch("/api/stop", { method: "POST" });
  });

  clearBtn.addEventListener("click", () => {
    chatLog.innerHTML = "";
  });

  resetBtn.addEventListener("click", async () => {
    if (!confirm("Wipe state.json and memory.json? This cannot be undone.")) return;
    const r = await fetch("/api/memory", { method: "DELETE" });
    const j = await r.json();
    if (!r.ok) {
      alert("Reset failed: " + (j.error || r.statusText));
      return;
    }
    chatLog.innerHTML = "";
    renderPlan([]);
    setStatus("idle", "idle");
  });

  // Ctrl/Cmd + Enter to submit
  goalInput.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !sendBtn.disabled) {
      e.preventDefault();
      sendBtn.click();
    }
  });

  // ---- Initial state ----------------------------------------------------
  async function loadInitialState() {
    try {
      const r = await fetch("/api/state");
      const j = await r.json();
      if (j.plan) renderPlan(j.plan);
      if (j.running) {
        setRunning(true);
        setStatus("running", "running");
      } else if (j.finished) {
        setStatus("finished", "finished");
      } else {
        setStatus("idle", "idle");
      }
    } catch {}
  }

  // ---- Test connection -------------------------------------------------
  testConnBtn.addEventListener("click", async () => {
    testConnBtn.disabled = true;
    const original = testConnBtn.textContent;
    testConnBtn.textContent = "Testing…";
    appendBubble("info",
      `<div class="meta">${fmtTime()} · TEST</div>Sending a probe to the model…`);
    try {
      const r = await fetch("/api/test_connection", { method: "POST" });
      const j = await r.json();
      if (r.ok && j.ok) {
        appendBubble("finished",
          `<div class="meta">${fmtTime()} · TEST OK</div>` +
          `<div>Endpoint reachable. Model <b>${escapeHtml(j.model)}</b> replied.</div>` +
          `<pre>${escapeHtml(j.reply || "(empty reply)")}</pre>`);
      } else {
        appendBubble("error",
          `<div class="meta">${fmtTime()} · TEST FAILED (${escapeHtml(j.stage || "unknown")})</div>` +
          `<div>${escapeHtml(j.error || r.statusText)}</div>` +
          (j.endpoint ? `<pre>endpoint: ${escapeHtml(j.endpoint)}\nmodel:    ${escapeHtml(j.model || "?")}</pre>` : ""));
      }
    } catch (e) {
      appendBubble("error",
        `<div class="meta">${fmtTime()} · TEST FAILED</div>${escapeHtml(e.message)}`);
    } finally {
      testConnBtn.disabled = false;
      testConnBtn.textContent = original;
      loadHealth();
    }
  });

  // ---- Open Folder modal -----------------------------------------------
  function showFolderModal() {
    folderModal.classList.remove("hidden");
    // Start at the user's home directory.
    browseTo("~");
  }
  function hideFolderModal() {
    folderModal.classList.add("hidden");
  }

  async function browseTo(path) {
    folderList.innerHTML = '<li class="empty">Loading…</li>';
    folderOpen.disabled = true;
    try {
      const r = await fetch("/api/browse?path=" + encodeURIComponent(path));
      const j = await r.json();
      if (!r.ok) {
        folderList.innerHTML = `<li class="empty">${escapeHtml(j.error || "Error")}</li>`;
        return;
      }
      modalCurrentPath = j.path || "";
      folderPath.value = modalCurrentPath;
      folderCurrent.textContent = modalCurrentPath
        ? `Selected: ${modalCurrentPath}`
        : "Pick a drive to begin";
      folderOpen.disabled = !modalCurrentPath;

      folderList.innerHTML = "";
      if (j.parent !== null && j.parent !== undefined) {
        const up = document.createElement("li");
        up.className = "up";
        up.textContent = j.parent || "(drives)";
        up.title = j.parent || "drive list";
        up.addEventListener("click", () => browseTo(j.parent));
        folderList.appendChild(up);
      }
      if (!j.entries.length) {
        const empty = document.createElement("li");
        empty.className = "empty";
        empty.textContent = "(no subfolders)";
        folderList.appendChild(empty);
      }
      for (const ent of j.entries) {
        const li = document.createElement("li");
        li.className = "dir";
        li.textContent = ent.name;
        li.title = ent.path;
        li.addEventListener("click", () => browseTo(ent.path));
        folderList.appendChild(li);
      }
    } catch (e) {
      folderList.innerHTML = `<li class="empty">Error: ${escapeHtml(e.message)}</li>`;
    }
  }

  openFolderBtn.addEventListener("click", showFolderModal);
  folderClose.addEventListener("click", hideFolderModal);
  folderCancel.addEventListener("click", hideFolderModal);
  folderModal.addEventListener("click", (e) => {
    if (e.target === folderModal) hideFolderModal();
  });
  folderGo.addEventListener("click", () => browseTo(folderPath.value.trim()));
  folderPath.addEventListener("keydown", (e) => {
    if (e.key === "Enter") browseTo(folderPath.value.trim());
  });
  document.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => browseTo(chip.dataset.shortcut || ""));
  });

  folderOpen.addEventListener("click", async () => {
    if (!modalCurrentPath) return;
    folderOpen.disabled = true;
    try {
      const r = await fetch("/api/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: modalCurrentPath }),
      });
      const j = await r.json();
      if (!r.ok) {
        alert("Could not open folder: " + (j.error || r.statusText));
        folderOpen.disabled = false;
        return;
      }
      hideFolderModal();
      // Reset open file + reload tree against the new workspace.
      openFile = null;
      tabName.textContent = "No file selected";
      editor.value = "";
      saveBtn.disabled = true;
      editorStatus.textContent = `Workspace: ${j.workspace}`;
      loadFiles();
      loadHealth();
    } catch (e) {
      alert("Error: " + e.message);
      folderOpen.disabled = false;
    }
  });

  // ---- New File inline row ---------------------------------------------
  function showNewFileRow() {
    newFileRow.classList.remove("hidden");
    newFileInput.value = "";
    newFileInput.focus();
  }
  function hideNewFileRow() {
    newFileRow.classList.add("hidden");
  }

  newFileBtn.addEventListener("click", () => {
    if (newFileRow.classList.contains("hidden")) {
      showNewFileRow();
    } else {
      hideNewFileRow();
    }
  });
  newFileCancel.addEventListener("click", hideNewFileRow);
  newFileInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") newFileCreate.click();
    if (e.key === "Escape") hideNewFileRow();
  });
  newFileCreate.addEventListener("click", async () => {
    const path = newFileInput.value.trim();
    if (!path) return;
    try {
      const r = await fetch("/api/file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, content: "" }),
      });
      const j = await r.json();
      if (!r.ok) {
        alert("Could not create file: " + (j.error || r.statusText));
        return;
      }
      hideNewFileRow();
      await loadFiles();
      openFileAt(path);
    } catch (e) {
      alert("Error: " + e.message);
    }
  });

  // Boot
  loadHealth();
  loadFiles();
  loadInitialState();
  connectStream();
})();
