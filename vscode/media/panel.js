(function () {
  const vscode = acquireVsCodeApi();

  const state = {
    workspaceMissing: true,
    health: {},
    sessionState: { plan: [], running: false, finished: false, iteration: 0 },
    files: [],
    events: [],
    status: "idle",
  };

  const refs = {
    workspaceMissing: document.getElementById("workspaceMissing"),
    mainContent: document.getElementById("mainContent"),
    workspacePath: document.getElementById("workspacePath"),
    modelName: document.getElementById("modelName"),
    runtimePath: document.getElementById("runtimePath"),
    statusBadge: document.getElementById("statusBadge"),
    healthBadge: document.getElementById("healthBadge"),
    iterationMeta: document.getElementById("iterationMeta"),
    planList: document.getElementById("planList"),
    fileCount: document.getElementById("fileCount"),
    filesList: document.getElementById("filesList"),
    eventCount: document.getElementById("eventCount"),
    eventsLog: document.getElementById("eventsLog"),
    goalInput: document.getElementById("goalInput"),
    maxIterations: document.getElementById("maxIterations"),
    refreshBtn: document.getElementById("refreshBtn"),
    installBtn: document.getElementById("installBtn"),
    outputBtn: document.getElementById("outputBtn"),
    testBtn: document.getElementById("testBtn"),
    resetBtn: document.getElementById("resetBtn"),
    stopBtn: document.getElementById("stopBtn"),
    runBtn: document.getElementById("runBtn"),
  };

  refs.maxIterations.value = "60";

  const post = (type, payload = {}) => vscode.postMessage({ type, ...payload });

  const escapeHtml = (value) =>
    String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");

  const fmtTime = (ts) => {
    const date = new Date((ts || Date.now() / 1000) * 1000);
    return date.toLocaleTimeString([], { hour12: false });
  };

  const statusClass = (status) => {
    if (status === "running") {
      return "badge-running";
    }
    if (status === "finished") {
      return "badge-finished";
    }
    if (status === "error") {
      return "badge-error";
    }
    if (status === "stopped") {
      return "badge-stopped";
    }
    return "badge-idle";
  };

  const eventLabel = (event) => {
    const type = event.type || event.kind || "info";
    return type.replaceAll("_", " ");
  };

  function hydrate(payload) {
    state.workspaceMissing = Boolean(payload.workspaceMissing);
    state.health = payload.health || {};
    state.sessionState = payload.state || state.sessionState;
    state.files = (payload.files && payload.files.files) || [];
    state.events = payload.events || state.events;

    if (state.workspaceMissing) {
      state.status = "idle";
    } else if (state.sessionState.running) {
      state.status = "running";
    } else if (state.sessionState.finished) {
      state.status = "finished";
    }

    render();
  }

  function applyEvent(event) {
    state.events = [...state.events, event].slice(-180);

    if (event.type === "plan" && Array.isArray(event.plan)) {
      state.sessionState.plan = event.plan;
    }
    if (event.type === "iteration") {
      state.sessionState.iteration = event.n || state.sessionState.iteration;
    }
    if (event.type === "run_started") {
      state.sessionState.running = true;
      state.sessionState.finished = false;
      state.status = "running";
    }
    if (event.type === "finished") {
      state.sessionState.running = false;
      state.sessionState.finished = true;
      state.status = "finished";
      if (event.state) {
        state.sessionState = event.state;
      }
    }
    if (event.type === "run_done") {
      state.sessionState.running = false;
      if (!state.sessionState.finished) {
        state.status = "stopped";
      }
      if (event.state) {
        state.sessionState = event.state;
      }
    }
    if (event.type === "error") {
      state.status = "error";
    }

    render();
  }

  function render() {
    refs.workspaceMissing.classList.toggle("hidden", !state.workspaceMissing);
    refs.mainContent.classList.toggle("hidden", state.workspaceMissing);

    refs.workspacePath.textContent = state.health.workspace || "-";
    refs.modelName.textContent = state.health.model || "-";
    refs.runtimePath.textContent = state.health.runtime_dir || "-";

    refs.statusBadge.textContent = state.status;
    refs.statusBadge.className = `badge ${statusClass(state.status)}`;

    refs.healthBadge.textContent = state.health.key_set
      ? "api ready"
      : "api key missing";
    refs.healthBadge.className = `badge ${
      state.health.key_set ? "badge-finished" : "badge-error"
    }`;

    const iteration = Number(state.sessionState.iteration || 0);
    refs.iterationMeta.textContent = iteration
      ? `iteration ${iteration}`
      : "No run yet";

    refs.stopBtn.disabled = !state.sessionState.running;
    refs.runBtn.disabled = state.sessionState.running;

    renderPlan();
    renderFiles();
    renderEvents();
  }

  function renderPlan() {
    const plan = state.sessionState.plan || [];
    if (!plan.length) {
      refs.planList.innerHTML = '<li class="empty-line">No plan yet.</li>';
      return;
    }

    let markedCurrent = false;
    refs.planList.innerHTML = plan
      .map((step) => {
        let className = "";
        if (step.done) {
          className = "done";
        } else if (!markedCurrent) {
          className = "current";
          markedCurrent = true;
        }
        return `<li class="${className}">${escapeHtml(step.title)}</li>`;
      })
      .join("");
  }

  function renderFiles() {
    refs.fileCount.textContent = `${state.files.length}`;
    if (!state.files.length) {
      refs.filesList.innerHTML = '<div class="empty-line">No files indexed yet.</div>';
      return;
    }

    const visible = state.files.slice(0, 120);
    refs.filesList.innerHTML = visible
      .map((file) => {
        if (file.is_dir) {
          return `<div class="file-pill dir">${escapeHtml(file.path)}/</div>`;
        }
        return `<button class="file-pill file" data-path="${escapeHtml(file.path)}">${escapeHtml(file.path)}</button>`;
      })
      .join("");
  }

  function renderEvents() {
    refs.eventCount.textContent = `${state.events.length}`;
    if (!state.events.length) {
      refs.eventsLog.innerHTML = '<div class="empty-line">Session events will appear here.</div>';
      return;
    }

    refs.eventsLog.innerHTML = state.events
      .map((event) => {
        const payload = event.payload || {};
        const body =
          payload.tool && event.type === "action"
            ? `<code>${escapeHtml(payload.tool)}</code>`
            : escapeHtml(
                event.summary ||
                  event.message ||
                  payload.diagnosis ||
                  payload.tool ||
                  eventLabel(event)
              );
        const extra =
          payload.next && event.type === "info"
            ? `<div class="event-extra">${escapeHtml(payload.next)}</div>`
            : "";
        return `
          <article class="event-card event-${escapeHtml(event.type || "info")}">
            <div class="event-meta">
              <span>${escapeHtml(eventLabel(event))}</span>
              <span>${escapeHtml(fmtTime(event.ts))}</span>
            </div>
            <div class="event-body">${body}</div>
            ${extra}
          </article>
        `;
      })
      .join("");

    refs.eventsLog.scrollTop = refs.eventsLog.scrollHeight;
  }

  refs.refreshBtn.addEventListener("click", () => post("refresh"));
  refs.installBtn.addEventListener("click", () => post("installDependencies"));
  refs.outputBtn.addEventListener("click", () => post("showOutput"));
  refs.testBtn.addEventListener("click", () => post("testConnection"));
  refs.resetBtn.addEventListener("click", () => post("reset"));
  refs.stopBtn.addEventListener("click", () => post("stop"));
  refs.runBtn.addEventListener("click", () =>
    post("start", {
      goal: refs.goalInput.value.trim(),
      maxIterations: Number(refs.maxIterations.value || 60),
    })
  );

  refs.goalInput.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      refs.runBtn.click();
    }
  });

  refs.filesList.addEventListener("click", (event) => {
    const target = event.target.closest("[data-path]");
    if (!target) {
      return;
    }
    post("openFile", { path: target.getAttribute("data-path") });
  });

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || !message.type) {
      return;
    }

    if (message.type === "hydrate") {
      hydrate(message.payload || {});
      return;
    }

    if (message.type === "backendEvent") {
      applyEvent(message.event || {});
      return;
    }

    if (message.type === "error") {
      applyEvent({
        type: "error",
        ts: Date.now() / 1000,
        message: message.message || "Unknown error.",
      });
    }
  });

  post("ready");
})();
