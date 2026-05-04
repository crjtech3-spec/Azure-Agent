"""Structured logger that writes to both stdout and agent.log.

Also exposes a tiny pub/sub channel (``subscribe`` / ``unsubscribe``) so the
GUI server can stream agent events to connected browser clients in real time.
"""

import json
import logging
import sys
import time
from datetime import datetime
from pathlib import Path
from threading import Lock
from typing import Any, Callable, Dict, List, Optional

from . import config


class _JsonAwareFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        ts = datetime.utcfromtimestamp(record.created).strftime("%H:%M:%S")
        prefix = f"[{ts}] [{record.levelname:<5}] [{record.name}]"
        msg = record.getMessage()
        extra = getattr(record, "payload", None)
        if extra is not None:
            try:
                msg += " " + json.dumps(extra, ensure_ascii=False, default=str)
            except Exception:
                msg += f" {extra!r}"
        return f"{prefix} {msg}"


_console_handler: Optional[logging.Handler] = None
_file_handler: Optional[logging.Handler] = None


def _attach_file_handler(logger: logging.Logger, path: Path) -> None:
    global _file_handler
    if _file_handler is not None:
        logger.removeHandler(_file_handler)
        try:
            _file_handler.close()
        except Exception:
            pass

    path.parent.mkdir(parents=True, exist_ok=True)
    file_handler = logging.FileHandler(path, encoding="utf-8")
    file_handler.setLevel(logging.DEBUG)
    file_handler.setFormatter(_JsonAwareFormatter())
    logger.addHandler(file_handler)
    _file_handler = file_handler


def _build_logger() -> logging.Logger:
    global _console_handler
    logger = logging.getLogger("agent")
    if logger.handlers:
        return logger

    logger.setLevel(logging.DEBUG)
    formatter = _JsonAwareFormatter()

    stdout_handler = logging.StreamHandler(sys.stdout)
    stdout_handler.setLevel(logging.INFO)
    stdout_handler.setFormatter(formatter)
    logger.addHandler(stdout_handler)
    _console_handler = stdout_handler

    _attach_file_handler(logger, config.LOG_FILE)

    logger.propagate = False
    return logger


log = _build_logger()


def set_console_logging(enabled: bool) -> None:
    if _console_handler is None:
        return
    _console_handler.setLevel(logging.INFO if enabled else logging.CRITICAL + 1)


def set_log_file(path: Path) -> None:
    _attach_file_handler(log, path)


# ---------------------------------------------------------------------------
# Pub/sub for the GUI
# ---------------------------------------------------------------------------

_subscribers: List[Callable[[Dict[str, Any]], None]] = []
_subscribers_lock = Lock()


def subscribe(callback: Callable[[Dict[str, Any]], None]) -> None:
    """Register a callback that will receive every structured event."""
    with _subscribers_lock:
        if callback not in _subscribers:
            _subscribers.append(callback)


def unsubscribe(callback: Callable[[Dict[str, Any]], None]) -> None:
    with _subscribers_lock:
        if callback in _subscribers:
            _subscribers.remove(callback)


def broadcast(evt: Dict[str, Any]) -> None:
    """Push an arbitrary event dict to all subscribers (used by the server)."""
    evt.setdefault("ts", time.time())
    with _subscribers_lock:
        callbacks = list(_subscribers)
    for cb in callbacks:
        try:
            cb(evt)
        except Exception:
            # Subscribers must never break the agent loop.
            pass


def event(level: str, kind: str, message: str, **payload: Any) -> None:
    """Emit a structured event row.

    `kind` is a short tag like ``thought``, ``action``, ``observation``,
    ``error``, ``api``. Payload is rendered as inline JSON for grep-ability.
    """
    payload.setdefault("kind", kind)
    log.log(getattr(logging, level.upper(), logging.INFO), message,
            extra={"payload": payload})

    # Notify GUI subscribers. ``type`` mirrors ``kind`` so the frontend can
    # switch on a single field across both log events and server events.
    broadcast({
        "type": kind,
        "kind": kind,
        "level": level,
        "message": message,
        "payload": payload,
    })


def thought(msg: str, **p: Any) -> None: event("info", "thought", msg, **p)
def action(msg: str, **p: Any) -> None: event("info", "action", msg, **p)
def observation(msg: str, **p: Any) -> None: event("info", "observation", msg, **p)
def error(msg: str, **p: Any) -> None: event("error", "error", msg, **p)
def warn(msg: str, **p: Any) -> None: event("warning", "warn", msg, **p)
def info(msg: str, **p: Any) -> None: event("info", "info", msg, **p)
def debug(msg: str, **p: Any) -> None: event("debug", "debug", msg, **p)
