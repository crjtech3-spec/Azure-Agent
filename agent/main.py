"""Command-line entry point.

Usage:
    python -m agent.main "Build a FastAPI app with a /health endpoint"
    python -m agent.main --resume                 # continue the saved goal
    python -m agent.main --max-iterations 30 "Goal here"
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import List, Optional

from . import config, logger
from .agent import Agent
from .memory import AgentState


def _parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="agent",
        description="Devin-class autonomous coding agent (Azure REST API).",
    )
    p.add_argument(
        "goal",
        nargs="*",
        help="What you want the agent to accomplish.",
    )
    p.add_argument(
        "--resume",
        action="store_true",
        help="Continue from the saved state.json instead of re-planning.",
    )
    p.add_argument(
        "--max-iterations",
        type=int,
        default=config.MAX_ITERATIONS,
        help=f"Cap on agent loop iterations (default {config.MAX_ITERATIONS}).",
    )
    return p.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> int:
    args = _parse_args(argv)

    goal = " ".join(args.goal).strip()
    if not goal:
        if args.resume:
            existing = AgentState.load()
            if not existing.goal:
                print("No saved goal to resume. Provide a goal as an argument.",
                      file=sys.stderr)
                return 2
            goal = existing.goal
        else:
            print("Provide a goal, e.g.:\n"
                  "  python -m agent.main \"Build a FastAPI app\"",
                  file=sys.stderr)
            return 2

    if not config.AZURE_API_KEY:
        print(
            "ERROR: AZURE_OPENAI_API_KEY environment variable is not set.\n"
            "Set it before running, e.g. (PowerShell):\n"
            '  $env:AZURE_OPENAI_API_KEY = "<your-key>"',
            file=sys.stderr,
        )
        return 3

    logger.info("Goal received", goal=goal, resume=args.resume)
    agent = Agent(goal, resume=args.resume)
    final = agent.run(max_iterations=args.max_iterations)

    print("\n========== AGENT RESULT ==========")
    print(json.dumps(
        {
            "goal": final["goal"],
            "iterations": final["iteration"],
            "finished": final["finished"],
            "summary": final["finish_summary"],
            "plan": final["plan"],
        },
        indent=2,
        ensure_ascii=False,
    ))
    print("==================================\n")
    print(f"Workspace: {config.WORKSPACE_DIR}")
    print(f"Log file:  {config.LOG_FILE}")
    print(f"State:     {config.STATE_FILE}")
    print(f"Memory:    {config.MEMORY_FILE}")

    return 0 if final["finished"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
