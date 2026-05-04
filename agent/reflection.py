"""Reflection module — judge whether the last action worked, retry, or move on."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List

from . import logger, prompts
from .api_client import APIClientError, AzureResponsesClient


@dataclass
class Reflection:
    succeeded: bool
    step_complete: bool
    goal_complete: bool
    diagnosis: str
    next_strategy: str


class Reflector:
    def __init__(self, client: AzureResponsesClient) -> None:
        self.client = client

    def reflect(
        self,
        goal: str,
        current_step: str,
        last_action: Dict[str, Any],
        last_observation: str,
        history: List[Dict[str, Any]],
        tool_ok: bool,
    ) -> Reflection:
        """Best-effort reflection. Falls back to a simple heuristic on failure."""
        messages = prompts.build_reflection_messages(
            goal=goal,
            current_step=current_step,
            last_action=last_action,
            last_observation=last_observation,
            recent_history=history,
        )
        try:
            data = self.client.respond_json(messages, temperature=0.1)
        except APIClientError as exc:
            logger.warn("Reflection API failure, using heuristic", error=str(exc))
            return self._heuristic(tool_ok, last_observation)

        return Reflection(
            succeeded=bool(data.get("succeeded", tool_ok)),
            step_complete=bool(data.get("step_complete", False)),
            goal_complete=bool(data.get("goal_complete", False)),
            diagnosis=str(data.get("diagnosis", ""))[:300],
            next_strategy=str(data.get("next_strategy", ""))[:300],
        )

    @staticmethod
    def _heuristic(tool_ok: bool, observation: str) -> Reflection:
        return Reflection(
            succeeded=tool_ok,
            step_complete=tool_ok,
            goal_complete=False,
            diagnosis=("tool succeeded" if tool_ok
                       else f"tool failed: {observation[:120]}"),
            next_strategy=("continue with the plan" if tool_ok
                           else "diagnose the failure and try a different approach"),
        )
