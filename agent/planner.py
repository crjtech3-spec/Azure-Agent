"""Planning module — turns the user goal into an ordered checklist."""

from __future__ import annotations

from typing import Any, Dict, List

from . import logger, prompts, workspace
from .api_client import APIClientError, AzureResponsesClient


class Planner:
    def __init__(self, client: AzureResponsesClient) -> None:
        self.client = client

    def make_plan(self, goal: str) -> List[Dict[str, Any]]:
        """Ask the model for a 3-10 step ordered plan."""
        snapshot = workspace.snapshot()
        messages = prompts.build_planner_messages(goal, snapshot)

        try:
            data = self.client.respond_json(messages, temperature=0.2)
        except APIClientError as exc:
            logger.error("Planner API failure, falling back", error=str(exc))
            return self._fallback_plan(goal)

        plan = data.get("plan")
        if not isinstance(plan, list) or not plan:
            logger.warn("Planner returned bad shape, using fallback", got=data)
            return self._fallback_plan(goal)

        cleaned: List[Dict[str, Any]] = []
        for i, step in enumerate(plan, start=1):
            if not isinstance(step, dict):
                continue
            title = str(step.get("title", "")).strip()
            if not title:
                continue
            cleaned.append({"id": i, "title": title, "done": False})

        if not cleaned:
            return self._fallback_plan(goal)

        logger.info("Plan ready", steps=[s["title"] for s in cleaned])
        return cleaned

    @staticmethod
    def _fallback_plan(goal: str) -> List[Dict[str, Any]]:
        """Used only when the planner call fails — keeps the loop alive."""
        return [
            {"id": 1, "title": f"Understand the goal: {goal}", "done": False},
            {"id": 2, "title": "Inspect existing workspace files", "done": False},
            {"id": 3, "title": "Implement the requested changes", "done": False},
            {"id": 4, "title": "Run / verify the result", "done": False},
            {"id": 5, "title": "Fix any failures and finish", "done": False},
        ]
