"""JSON-lines bridge between a VS Code extension host and the Python agent."""

from __future__ import annotations

import json
import os
import sys
import threading
from typing import Any, Dict

from . import logger
from .session import AgentSessionManager, SessionError


class Bridge:
    def __init__(self) -> None:
        logger.set_console_logging(False)
        self.session = AgentSessionManager()
        self.session.subscribe(self._on_event)
        self._write_lock = threading.Lock()

    def close(self) -> None:
        self.session.unsubscribe(self._on_event)
        self.session.close()

    def _write(self, payload: Dict[str, Any]) -> None:
        line = json.dumps(payload, ensure_ascii=False)
        with self._write_lock:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()

    def _on_event(self, evt: Dict[str, Any]) -> None:
        self._write({"type": "event", "event": evt})

    def _respond(self, request_id: Any, *, ok: bool, result: Any = None,
                 error: str = "") -> None:
        payload: Dict[str, Any] = {"type": "response", "id": request_id, "ok": ok}
        if ok:
            payload["result"] = result
        else:
            payload["error"] = error
        self._write(payload)

    def _dispatch(self, method: str, params: Dict[str, Any]) -> Any:
        if method == "initialize":
            workspace = (params.get("workspace") or "").strip()
            if workspace:
                self.session.switch_workspace(workspace)
            return {
                "health": self.session.health(),
                "state": self.session.state(),
                "files": self.session.files_tree(),
                "history": self.session.history(limit=100),
                "events": self.session.recent_events(limit=150),
            }
        if method == "set_workspace":
            path = (params.get("path") or "").strip()
            if not path:
                raise SessionError("Field 'path' is required.")
            new_path = self.session.switch_workspace(path)
            return {
                "workspace": str(new_path),
                "health": self.session.health(),
                "state": self.session.state(),
                "files": self.session.files_tree(),
            }
        if method == "start":
            return self.session.start(
                (params.get("goal") or "").strip(),
                resume=bool(params.get("resume", False)),
                max_iterations=int(params.get("max_iterations") or 60),
            )
        if method == "stop":
            return self.session.stop()
        if method == "state":
            return self.session.state()
        if method == "list_files":
            return self.session.files_tree()
        if method == "read_file":
            return self.session.read_file((params.get("path") or "").strip())
        if method == "write_file":
            path = (params.get("path") or "").strip()
            if not path:
                raise SessionError("Field 'path' is required.")
            return self.session.write_file(path, params.get("content", ""))
        if method == "reset_memory":
            return self.session.reset_memory()
        if method == "history":
            return self.session.history(limit=int(params.get("limit") or 200))
        if method == "health":
            return self.session.health()
        if method == "test_connection":
            return self.session.test_connection()
        raise SessionError(f"Unknown method '{method}'.")

    def run(self) -> int:
        self._write({
            "type": "ready",
            "pid": os.getpid(),
            "workspace": str(self.session.health()["workspace"]),
        })
        try:
            for raw in sys.stdin:
                raw = raw.strip()
                if not raw:
                    continue
                request_id = None
                try:
                    req = json.loads(raw)
                    request_id = req.get("id")
                    method = req.get("method")
                    params = req.get("params") or {}
                    if not isinstance(method, str):
                        raise SessionError("Request is missing string 'method'.")
                    if not isinstance(params, dict):
                        raise SessionError("Request 'params' must be an object.")
                    result = self._dispatch(method, params)
                except SessionError as exc:
                    self._respond(request_id, ok=False, error=str(exc))
                    continue
                except Exception as exc:
                    self._respond(request_id, ok=False, error=f"{type(exc).__name__}: {exc}")
                    continue

                self._respond(request_id, ok=True, result=result)
        finally:
            self.close()
        return 0


def main() -> int:
    return Bridge().run()


if __name__ == "__main__":
    raise SystemExit(main())
