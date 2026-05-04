"""Dispatch a model-emitted action to the right tool."""

from __future__ import annotations

from typing import Any, Dict

from . import logger, tools
from .tools import ToolResult


_TOOL_TABLE = {
    "read_file":            lambda a: tools.read_file(a.get("path", "")),
    "write_file":           lambda a: tools.write_file(a.get("path", ""), a.get("content", "")),
    "append_file":          lambda a: tools.append_file(a.get("path", ""), a.get("content", "")),
    "list_files":           lambda a: tools.list_files(a.get("path", ""), bool(a.get("recursive", False))),
    "search_code":          lambda a: tools.search_code(a.get("query", ""), a.get("path", "")),
    "run_terminal":         lambda a: tools.run_terminal(a.get("command", ""), a.get("cwd")),
    "run_tests":            lambda a: tools.run_tests(a.get("command")),
    "install_dependencies": lambda a: tools.install_dependencies(a.get("packages", [])),
}


def list_tool_names() -> list[str]:
    return list(_TOOL_TABLE.keys()) + ["finish"]


def execute(action: Dict[str, Any]) -> ToolResult:
    """Run the tool named in ``action`` and return its result.

    The ``finish`` pseudo-tool is handled by the agent loop, not here.
    """
    if not isinstance(action, dict):
        return ToolResult(False, f"Action must be an object, got {type(action).__name__}", {})

    tool_name = action.get("tool")
    args = action.get("args") or {}

    if not isinstance(tool_name, str):
        return ToolResult(False, "Action is missing string 'tool' field", {})
    if not isinstance(args, dict):
        return ToolResult(False, "Action 'args' must be an object", {"tool": tool_name})

    if tool_name == "finish":
        # The agent loop handles 'finish'; surface a clear error if it
        # somehow falls through to here.
        return ToolResult(True, args.get("summary", "finished"), {"finish": True})

    fn = _TOOL_TABLE.get(tool_name)
    if fn is None:
        return ToolResult(
            False,
            f"Unknown tool '{tool_name}'. Available: {', '.join(list_tool_names())}",
            {"tool": tool_name},
        )

    logger.action("dispatch", tool=tool_name, args=_redact_args(args))
    try:
        result = fn(args)
    except TypeError as exc:
        return ToolResult(False, f"Bad arguments for {tool_name}: {exc}",
                          {"tool": tool_name, "args": args})
    except Exception as exc:  # last-resort guard so the loop never dies
        logger.error("Tool raised", tool=tool_name, error=str(exc))
        return ToolResult(False, f"Tool '{tool_name}' raised: {exc}",
                          {"tool": tool_name})

    logger.observation(
        "tool_done",
        tool=tool_name,
        ok=result.ok,
        bytes=len(result.output),
    )
    return result


def _redact_args(args: Dict[str, Any]) -> Dict[str, Any]:
    """Avoid dumping huge file contents into the log."""
    out = {}
    for k, v in args.items():
        if k == "content" and isinstance(v, str) and len(v) > 200:
            out[k] = f"<{len(v)} chars>"
        else:
            out[k] = v
    return out
