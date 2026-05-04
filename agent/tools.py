"""Tool implementations exposed to the model.

Every tool returns a ``ToolResult``. The executor (executor.py) is the
only thing that calls these — the model never invokes them directly.
"""

from __future__ import annotations

import os
import re
import shlex
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import config, logger, workspace


# ---------------------------------------------------------------------------
# Result type
# ---------------------------------------------------------------------------


@dataclass
class ToolResult:
    ok: bool
    output: str
    meta: Dict[str, Any]

    def truncated_output(self, limit: int = 6000) -> str:
        if len(self.output) <= limit:
            return self.output
        head = self.output[: limit // 2]
        tail = self.output[-limit // 2 :]
        return f"{head}\n... [truncated {len(self.output) - limit} chars] ...\n{tail}"


# ---------------------------------------------------------------------------
# Safety: block obviously dangerous shell commands
# ---------------------------------------------------------------------------


_DANGER_RES = [re.compile(p, re.IGNORECASE) for p in config.DANGEROUS_COMMAND_PATTERNS]


def _is_dangerous(command: str) -> Optional[str]:
    for r in _DANGER_RES:
        if r.search(command):
            return r.pattern
    return None


# ---------------------------------------------------------------------------
# File tools
# ---------------------------------------------------------------------------


def read_file(path: str) -> ToolResult:
    try:
        target = workspace.resolve_in_workspace(path)
    except PermissionError as exc:
        return ToolResult(False, f"Refused: {exc}", {"path": path})

    if not target.exists():
        return ToolResult(False, f"File not found: {path}", {"path": path})
    if not target.is_file():
        return ToolResult(False, f"Not a file: {path}", {"path": path})

    try:
        text = target.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return ToolResult(False, f"Read error: {exc}", {"path": path})

    return ToolResult(
        True,
        text,
        {"path": path, "bytes": target.stat().st_size, "lines": text.count("\n") + 1},
    )


def write_file(path: str, content: str) -> ToolResult:
    if content is None:
        return ToolResult(False, "write_file requires 'content'", {"path": path})
    try:
        target = workspace.resolve_in_workspace(path)
    except PermissionError as exc:
        return ToolResult(False, f"Refused: {exc}", {"path": path})

    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        target.write_text(content, encoding="utf-8")
    except OSError as exc:
        return ToolResult(False, f"Write error: {exc}", {"path": path})

    return ToolResult(
        True,
        f"Wrote {len(content)} chars to {path}",
        {"path": path, "bytes": len(content.encode('utf-8'))},
    )


def append_file(path: str, content: str) -> ToolResult:
    if content is None:
        return ToolResult(False, "append_file requires 'content'", {"path": path})
    try:
        target = workspace.resolve_in_workspace(path)
    except PermissionError as exc:
        return ToolResult(False, f"Refused: {exc}", {"path": path})

    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        with target.open("a", encoding="utf-8") as fh:
            fh.write(content)
    except OSError as exc:
        return ToolResult(False, f"Append error: {exc}", {"path": path})

    return ToolResult(True, f"Appended {len(content)} chars to {path}", {"path": path})


def list_files(path: str = "", recursive: bool = False) -> ToolResult:
    try:
        items = workspace.list_directory(path, recursive=recursive)
    except PermissionError as exc:
        return ToolResult(False, f"Refused: {exc}", {"path": path})
    if not items:
        return ToolResult(True, "(empty)", {"path": path, "count": 0})
    return ToolResult(True, "\n".join(items), {"path": path, "count": len(items)})


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------


def search_code(query: str, path: str = "") -> ToolResult:
    if not query:
        return ToolResult(False, "search_code requires 'query'", {})
    try:
        hits = workspace.search_code(query, path)
    except PermissionError as exc:
        return ToolResult(False, f"Refused: {exc}", {"query": query})

    if not hits:
        return ToolResult(True, f"No matches for: {query}", {"query": query, "count": 0})

    lines = [f"{h['path']}:{h['line']}: {h['text']}" for h in hits]
    return ToolResult(True, "\n".join(lines), {"query": query, "count": len(hits)})


# ---------------------------------------------------------------------------
# Terminal
# ---------------------------------------------------------------------------


def run_terminal(command: str, cwd: Optional[str] = None) -> ToolResult:
    if not command or not command.strip():
        return ToolResult(False, "run_terminal requires non-empty 'command'", {})

    blocked = _is_dangerous(command)
    if blocked:
        return ToolResult(False, f"Blocked dangerous command (matched /{blocked}/)",
                          {"command": command})

    if cwd:
        try:
            cwd_path = workspace.resolve_in_workspace(cwd)
        except PermissionError as exc:
            return ToolResult(False, f"Refused cwd: {exc}", {"cwd": cwd})
    else:
        cwd_path = config.WORKSPACE_DIR

    cwd_path.mkdir(parents=True, exist_ok=True)

    is_windows = os.name == "nt"
    logger.action("run_terminal", command=command, cwd=str(cwd_path))

    try:
        proc = subprocess.run(
            command,
            shell=True,
            cwd=str(cwd_path),
            capture_output=True,
            text=True,
            timeout=config.TOOL_TIMEOUT_SECONDS,
            executable=None if is_windows else "/bin/bash",
        )
    except subprocess.TimeoutExpired as exc:
        return ToolResult(
            False,
            f"Command timed out after {config.TOOL_TIMEOUT_SECONDS}s.\n"
            f"Partial stdout:\n{exc.stdout or ''}\n"
            f"Partial stderr:\n{exc.stderr or ''}",
            {"command": command, "timeout": True},
        )
    except OSError as exc:
        return ToolResult(False, f"Could not execute: {exc}",
                          {"command": command})

    output = (
        f"$ {command}\n"
        f"[exit={proc.returncode}]\n"
        f"--- stdout ---\n{proc.stdout}\n"
        f"--- stderr ---\n{proc.stderr}"
    )
    return ToolResult(
        proc.returncode == 0,
        output,
        {"command": command, "exit_code": proc.returncode, "cwd": str(cwd_path)},
    )


# ---------------------------------------------------------------------------
# Tests + dependencies
# ---------------------------------------------------------------------------


def run_tests(command: Optional[str] = None) -> ToolResult:
    cmd = command or f"{shlex.quote(sys.executable)} -m pytest -q"
    return run_terminal(cmd)


def install_dependencies(packages: List[str]) -> ToolResult:
    if not packages:
        return ToolResult(False, "install_dependencies requires non-empty 'packages'", {})

    bad = [p for p in packages if not re.match(r"^[A-Za-z0-9_.\-\[\]=<>!~]+$", p)]
    if bad:
        return ToolResult(False, f"Refused suspicious package names: {bad}", {})

    pkg_args = " ".join(shlex.quote(p) for p in packages)
    cmd = f"{shlex.quote(sys.executable)} -m pip install {pkg_args}"
    return run_terminal(cmd)
