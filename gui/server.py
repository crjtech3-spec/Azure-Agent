"""Flask web server that wraps the agent in a browser UI."""

from __future__ import annotations

import json
import os
import queue
import string
from pathlib import Path
from typing import Any, Dict, List, Optional

from flask import Flask, Response, jsonify, request, send_from_directory

from agent import config
from agent.session import AgentSessionManager, SessionError


_static_dir = Path(__file__).resolve().parent / "static"
app = Flask(__name__, static_folder=str(_static_dir), static_url_path="/static")
session = AgentSessionManager()


def _session_error_status(exc: SessionError) -> int:
    text = str(exc)
    if "already in progress" in text or "Stop the running agent" in text:
        return 409
    return 400


@app.route("/")
def index() -> Response:
    return send_from_directory(_static_dir, "index.html")


@app.route("/api/start", methods=["POST"])
def start():
    data = request.get_json(silent=True) or {}
    try:
        result = session.start(
            (data.get("goal") or "").strip(),
            resume=bool(data.get("resume", False)),
            max_iterations=int(data.get("max_iterations") or config.MAX_ITERATIONS),
        )
    except SessionError as exc:
        return jsonify({"error": str(exc)}), _session_error_status(exc)
    return jsonify(result)


@app.route("/api/stop", methods=["POST"])
def stop():
    return jsonify(session.stop())


@app.route("/api/state")
def state():
    return jsonify(session.state())


@app.route("/api/memory", methods=["DELETE"])
def reset_memory():
    try:
        return jsonify(session.reset_memory())
    except SessionError as exc:
        return jsonify({"error": str(exc)}), _session_error_status(exc)
    except OSError as exc:
        return jsonify({"error": str(exc)}), 500


@app.route("/api/events")
def events():
    client_q: "queue.Queue[Dict[str, Any]]" = queue.Queue(maxsize=2000)
    callback = client_q.put_nowait
    session.subscribe(callback)
    backlog = session.recent_events(limit=150)

    def _generate():
        try:
            yield "retry: 2000\n\n"
            for evt in backlog:
                yield f"data: {json.dumps(evt, default=str)}\n\n"
            while True:
                try:
                    evt = client_q.get(timeout=15)
                except queue.Empty:
                    yield ": keepalive\n\n"
                    continue
                yield f"data: {json.dumps(evt, default=str)}\n\n"
        finally:
            session.unsubscribe(callback)

    return Response(
        _generate(),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@app.route("/api/files")
def files():
    return jsonify(session.files_tree())


@app.route("/api/file", methods=["GET"])
def get_file():
    path = request.args.get("path", "")
    if not path:
        return jsonify({"error": "Query param 'path' is required."}), 400
    try:
        return jsonify(session.read_file(path))
    except SessionError as exc:
        return jsonify({"error": str(exc)}), 404


@app.route("/api/file", methods=["POST"])
def post_file():
    data = request.get_json(silent=True) or {}
    path = (data.get("path") or "").strip()
    content = data.get("content")
    if not path or content is None:
        return jsonify({"error": "Both 'path' and 'content' are required."}), 400
    try:
        return jsonify(session.write_file(path, content))
    except SessionError as exc:
        return jsonify({"error": str(exc)}), 400


def _list_windows_drives() -> List[Dict[str, Any]]:
    drives: List[Dict[str, Any]] = []
    for letter in string.ascii_uppercase:
        root = Path(f"{letter}:\\")
        if root.exists():
            drives.append({"name": f"{letter}:\\", "path": str(root)})
    return drives


@app.route("/api/browse")
def browse():
    raw = request.args.get("path", "").strip()

    if os.name == "nt" and raw in ("", "/"):
        return jsonify({
            "path": "",
            "parent": None,
            "is_root": True,
            "entries": _list_windows_drives(),
        })

    if not raw or raw == "~":
        target = Path.home()
    else:
        try:
            target = Path(raw).expanduser().resolve()
        except (OSError, ValueError) as exc:
            return jsonify({"error": f"Bad path: {exc}"}), 400

    if not target.exists():
        return jsonify({"error": f"Path does not exist: {target}"}), 404
    if not target.is_dir():
        return jsonify({"error": f"Not a directory: {target}"}), 400

    entries: List[Dict[str, Any]] = []
    try:
        for child in sorted(target.iterdir(), key=lambda p: p.name.lower()):
            if child.name.startswith("."):
                continue
            try:
                if child.is_dir():
                    entries.append({"name": child.name, "path": str(child)})
            except OSError:
                continue
    except PermissionError:
        return jsonify({"error": f"Permission denied: {target}"}), 403

    if target.parent == target:
        parent: Optional[str] = "" if os.name == "nt" else None
    else:
        parent = str(target.parent)

    return jsonify({
        "path": str(target),
        "parent": parent,
        "is_root": target.parent == target,
        "entries": entries,
    })


@app.route("/api/workspace", methods=["POST"])
def set_workspace_route():
    data = request.get_json(silent=True) or {}
    raw = (data.get("path") or "").strip()
    if not raw:
        return jsonify({"error": "Field 'path' is required."}), 400
    try:
        new_path = session.switch_workspace(raw)
    except SessionError as exc:
        return jsonify({"error": str(exc)}), _session_error_status(exc)
    except (OSError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify({"status": "ok", "workspace": str(new_path)})


@app.route("/api/history")
def history():
    return jsonify(session.history())


@app.route("/api/health")
def health():
    return jsonify(session.health())


@app.route("/api/test_connection", methods=["POST"])
def test_connection():
    try:
        return jsonify(session.test_connection())
    except SessionError as exc:
        return jsonify({
            "ok": False,
            "endpoint": config.AZURE_ENDPOINT,
            "model": config.MODEL_NAME,
            "error": str(exc),
        }), 502 if config.AZURE_API_KEY else 400


def serve(host: str = "127.0.0.1", port: int = 5000, debug: bool = False) -> None:
    print(f"\n  Agent GUI ready at http://{host}:{port}")
    print(f"  Workspace:  {config.WORKSPACE_DIR}")
    print(f"  Runtime:    {config.RUNTIME_DIR}")
    print(f"  Model:      {config.MODEL_NAME}")
    print(
        "  API key:    "
        f"{'set' if config.AZURE_API_KEY else 'NOT SET - set AZURE_OPENAI_API_KEY before starting a run'}"
    )
    print()
    app.run(host=host, port=port, debug=debug, threaded=True, use_reloader=False)


if __name__ == "__main__":
    serve()
