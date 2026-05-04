"""Persistent step memory + state.

Two files live next to the agent module:

* ``state.json``   — the live agent state (goal, plan, iteration, recent steps).
* ``memory.json``  — long-term, append-only history of every action taken.

Both are plain JSON so they are trivially inspectable.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import config, logger


# ---------------------------------------------------------------------------
# Generic JSON IO helpers
# ---------------------------------------------------------------------------


def _read_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.warn("Could not read JSON, using default", path=str(path),
                    error=str(exc))
        return default


def _write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False),
                   encoding="utf-8")
    tmp.replace(path)


# ---------------------------------------------------------------------------
# Long-term memory
# ---------------------------------------------------------------------------


class Memory:
    """Append-only history of agent steps with summarisation helpers."""

    def __init__(self, path: Optional[Path] = None) -> None:
        self.path = path or config.MEMORY_FILE
        self.entries: List[Dict[str, Any]] = _read_json(self.path, default=[])

    def append(
        self,
        *,
        thought: str,
        action: Dict[str, Any],
        observation: str,
        success: bool,
    ) -> None:
        self.entries.append({
            "ts": time.time(),
            "thought": thought,
            "action": action,
            "observation": observation[:4000],
            "success": success,
        })
        self.flush()

    def flush(self) -> None:
        _write_json(self.path, self.entries)

    def recent(self, n: int = 8) -> List[Dict[str, Any]]:
        return [
            {
                "thought": e["thought"],
                "action": e["action"],
                "observation_preview": (e["observation"] or "")[:400],
                "success": e["success"],
            }
            for e in self.entries[-n:]
        ]

    def summary(self, max_chars: int = 1800) -> str:
        """A condensed text view of past steps for inclusion in prompts."""
        if not self.entries:
            return "(no prior steps)"
        lines: List[str] = []
        for i, e in enumerate(self.entries[-30:], start=1):
            tool = (e["action"] or {}).get("tool", "?")
            ok = "OK" if e["success"] else "FAIL"
            short = (e["thought"] or "").replace("\n", " ")[:140]
            lines.append(f"{i:>2}. [{ok}] {tool:<22} {short}")
        text = "\n".join(lines)
        if len(text) > max_chars:
            text = text[-max_chars:]
            text = "...\n" + text
        return text


# ---------------------------------------------------------------------------
# Live agent state
# ---------------------------------------------------------------------------


@dataclass
class AgentState:
    goal: str = ""
    plan: List[Dict[str, Any]] = field(default_factory=list)
    current_step_id: Optional[int] = None
    iteration: int = 0
    consecutive_failures: int = 0
    started_at: float = field(default_factory=time.time)
    finished: bool = False
    finish_summary: str = ""

    # ---- IO ----

    def to_dict(self) -> Dict[str, Any]:
        return {
            "goal": self.goal,
            "plan": self.plan,
            "current_step_id": self.current_step_id,
            "iteration": self.iteration,
            "consecutive_failures": self.consecutive_failures,
            "started_at": self.started_at,
            "finished": self.finished,
            "finish_summary": self.finish_summary,
        }

    @classmethod
    def load(cls, path: Optional[Path] = None) -> "AgentState":
        data = _read_json(path or config.STATE_FILE, default=None)
        if not isinstance(data, dict):
            return cls()
        defaults = cls().to_dict()
        return cls(**{k: data.get(k, defaults[k]) for k in defaults})

    def save(self, path: Optional[Path] = None) -> None:
        _write_json(path or config.STATE_FILE, self.to_dict())

    # ---- Plan helpers ----

    def current_step(self) -> Optional[Dict[str, Any]]:
        for s in self.plan:
            if not s.get("done"):
                self.current_step_id = s.get("id")
                return s
        return None

    def mark_step_done(self, step_id: int) -> None:
        for s in self.plan:
            if s.get("id") == step_id:
                s["done"] = True
                return
