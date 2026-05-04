"""Workspace indexing and lightweight semantic search.

The workspace is a single directory on disk (``config.WORKSPACE_DIR``).
We expose helpers for:

* listing files (filtered by extension and protected paths),
* taking a "snapshot" string for prompts,
* searching files by literal/regex,
* ranking files by relevance to a free-text query (TF-overlap).
"""

from __future__ import annotations

import re
from collections import Counter
from pathlib import Path
from typing import Dict, Iterable, List, Tuple

from . import config, logger


# ---------------------------------------------------------------------------
# Path safety
# ---------------------------------------------------------------------------


def resolve_in_workspace(rel_path: str) -> Path:
    """Resolve ``rel_path`` against the workspace root, blocking escapes."""
    if not rel_path or rel_path in (".", "./"):
        return config.WORKSPACE_DIR

    candidate = (config.WORKSPACE_DIR / rel_path).resolve()
    workspace = config.WORKSPACE_DIR.resolve()

    try:
        candidate.relative_to(workspace)
    except ValueError as exc:
        raise PermissionError(
            f"Path '{rel_path}' escapes the workspace root."
        ) from exc

    for part in candidate.parts:
        if part in config.PROTECTED_PATHS:
            raise PermissionError(f"Path '{rel_path}' touches protected '{part}'.")
    return candidate


def is_indexable(path: Path) -> bool:
    if not path.is_file():
        return False
    if path.suffix.lower() not in config.INDEXABLE_EXTENSIONS:
        return False
    try:
        if path.stat().st_size > config.MAX_INDEX_FILE_BYTES:
            return False
    except OSError:
        return False
    if any(part in config.PROTECTED_PATHS for part in path.parts):
        return False
    return True


# ---------------------------------------------------------------------------
# File walking
# ---------------------------------------------------------------------------


def iter_workspace_files() -> Iterable[Path]:
    if not config.WORKSPACE_DIR.exists():
        return []
    for path in config.WORKSPACE_DIR.rglob("*"):
        if path.is_dir():
            continue
        if any(part in config.PROTECTED_PATHS for part in path.parts):
            continue
        yield path


def list_directory(rel_path: str = "", recursive: bool = False) -> List[str]:
    base = resolve_in_workspace(rel_path)
    if not base.exists():
        return []
    if base.is_file():
        return [str(base.relative_to(config.WORKSPACE_DIR))]

    out: List[str] = []
    iterator = base.rglob("*") if recursive else base.iterdir()
    for p in iterator:
        if any(part in config.PROTECTED_PATHS for part in p.parts):
            continue
        rel = p.relative_to(config.WORKSPACE_DIR)
        marker = "/" if p.is_dir() else ""
        out.append(f"{rel}{marker}")
    out.sort()
    return out


# ---------------------------------------------------------------------------
# Snapshot for prompts
# ---------------------------------------------------------------------------


def snapshot(max_files: int = 40) -> str:
    """Compact textual snapshot used inside the planner / agent prompts."""
    all_files = sorted(iter_workspace_files(), key=lambda p: str(p))
    files = all_files[:max_files]
    if not files:
        return "(empty workspace)"

    lines = [f"Workspace root: {config.WORKSPACE_DIR}"]
    for f in files:
        rel = f.relative_to(config.WORKSPACE_DIR)
        try:
            size = f.stat().st_size
        except OSError:
            size = -1
        lines.append(f"  {rel} ({size} bytes)")
    if len(all_files) > max_files:
        lines.append(f"  ... ({len(all_files) - max_files} more files)")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------


def search_code(query: str, rel_path: str = "") -> List[Dict[str, object]]:
    """Find lines matching ``query`` (regex if valid, else literal)."""
    base = resolve_in_workspace(rel_path) if rel_path else config.WORKSPACE_DIR
    try:
        pattern = re.compile(query)
    except re.error:
        pattern = re.compile(re.escape(query))

    results: List[Dict[str, object]] = []
    targets = [base] if base.is_file() else list(base.rglob("*"))
    for path in targets:
        if not is_indexable(path):
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            logger.debug("search_code skip", path=str(path), error=str(exc))
            continue
        for lineno, line in enumerate(text.splitlines(), start=1):
            if pattern.search(line):
                results.append({
                    "path": str(path.relative_to(config.WORKSPACE_DIR)),
                    "line": lineno,
                    "text": line.rstrip()[:240],
                })
                if len(results) >= 200:
                    return results
    return results


# ---------------------------------------------------------------------------
# Relevance ranking ("semantic" via token overlap — cheap and offline)
# ---------------------------------------------------------------------------


_TOKEN_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]{2,}")


def _tokenize(text: str) -> Counter:
    return Counter(t.lower() for t in _TOKEN_RE.findall(text))


def rank_relevant_files(query: str, top_k: int = config.MAX_FILES_IN_PROMPT) -> List[Tuple[str, int]]:
    """Return ``[(rel_path, score), ...]`` for files most relevant to ``query``."""
    q_tokens = _tokenize(query)
    if not q_tokens:
        return []

    scored: List[Tuple[str, int]] = []
    for path in iter_workspace_files():
        if not is_indexable(path):
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        f_tokens = _tokenize(text)
        # Add filename tokens with a boost
        f_tokens.update({t: 3 for t in _TOKEN_RE.findall(path.name.lower())})
        score = sum(min(q_tokens[t], f_tokens[t]) for t in q_tokens)
        if score > 0:
            scored.append((str(path.relative_to(config.WORKSPACE_DIR)), score))

    scored.sort(key=lambda x: x[1], reverse=True)
    return scored[:top_k]


def relevant_context(query: str, max_chars_per_file: int = 1200) -> str:
    """Build a context block of the top-ranked files for ``query``."""
    ranked = rank_relevant_files(query)
    if not ranked:
        return "(no relevant files indexed)"
    chunks = []
    for rel, score in ranked:
        path = config.WORKSPACE_DIR / rel
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        snippet = text[:max_chars_per_file]
        chunks.append(f"--- {rel} (score={score}) ---\n{snippet}")
    return "\n\n".join(chunks)
