"""The agent loop: plan -> act -> observe -> reflect -> repeat."""

from __future__ import annotations

import json
import threading
from typing import Any, Dict, List

from . import config, executor, logger, prompts, workspace
from .api_client import APIClientError, AzureResponsesClient
from .memory import AgentState, Memory
from .planner import Planner
from .reflection import Reflector


class Agent:
    def __init__(self, goal: str, *, resume: bool = False) -> None:
        self.goal = goal.strip()
        self.client = AzureResponsesClient()
        self.planner = Planner(self.client)
        self.reflector = Reflector(self.client)
        self.memory = Memory()
        self.state = AgentState.load() if resume else AgentState()
        self.stop_requested = threading.Event()

        if resume and self.state.goal and self.state.goal != self.goal:
            logger.warn(
                "Resume requested but goal differs — starting fresh.",
                old=self.state.goal, new=self.goal,
            )
            self.state = AgentState()

        if not self.state.goal:
            self.state.goal = self.goal
        if not self.state.plan:
            self.state.plan = self.planner.make_plan(self.goal)
        self.state.save()
        logger.broadcast({"type": "plan", "plan": self.state.plan})

    def request_stop(self) -> None:
        """Signal the run loop to exit before its next iteration."""
        self.stop_requested.set()

    # ------------------------------------------------------------------ #
    # Public entry point
    # ------------------------------------------------------------------ #

    def run(self, max_iterations: int | None = None) -> Dict[str, Any]:
        max_iterations = max_iterations or config.MAX_ITERATIONS
        logger.info("Agent starting", goal=self.goal,
                    max_iterations=max_iterations,
                    workspace=str(config.WORKSPACE_DIR))

        last_observation = ""
        while not self.state.finished and self.state.iteration < max_iterations:
            if self.stop_requested.is_set():
                logger.info("Stop requested by user — halting.")
                self._finish("Stopped by user.")
                break
            self.state.iteration += 1
            logger.broadcast({
                "type": "iteration",
                "n": self.state.iteration,
                "max": max_iterations,
            })
            logger.info(
                f"=== iteration {self.state.iteration} / {max_iterations} ==="
            )

            current_step = self.state.current_step()
            if current_step is None:
                logger.info("All plan steps marked done — wrapping up.")
                self._finish("All planned steps complete.")
                break

            try:
                decision = self._decide(last_observation)
            except APIClientError as exc:
                logger.error("Model call failed", error=str(exc))
                self.state.consecutive_failures += 1
                last_observation = f"MODEL ERROR: {exc}"
                self._maybe_abort()
                self.state.save()
                continue

            thought = str(decision.get("thought", "")).strip()
            action = decision.get("action") or {}
            logger.thought(thought or "(no thought)")

            if not isinstance(action, dict):
                last_observation = "Model returned malformed action object."
                logger.warn(last_observation, decision=decision)
                self._record(thought, {"tool": "?", "args": {}},
                             last_observation, success=False)
                self.state.consecutive_failures += 1
                self._maybe_abort()
                self.state.save()
                continue

            tool_name = action.get("tool")

            # ---- finish? --------------------------------------------------
            if tool_name == "finish":
                summary = (action.get("args") or {}).get(
                    "summary", "Goal complete."
                )
                self._finish(summary)
                self._record(thought, action, summary, success=True)
                break

            # ---- run the tool --------------------------------------------
            result = executor.execute(action)
            last_observation = result.truncated_output()

            self._record(thought, action, last_observation, success=result.ok)

            # ---- reflect --------------------------------------------------
            reflection = self.reflector.reflect(
                goal=self.goal,
                current_step=current_step.get("title", ""),
                last_action=action,
                last_observation=last_observation,
                history=self.memory.recent(),
                tool_ok=result.ok,
            )
            logger.info(
                "reflection",
                succeeded=reflection.succeeded,
                step_complete=reflection.step_complete,
                goal_complete=reflection.goal_complete,
                diagnosis=reflection.diagnosis,
                next=reflection.next_strategy,
            )

            if reflection.succeeded:
                self.state.consecutive_failures = 0
            else:
                self.state.consecutive_failures += 1

            if reflection.step_complete and current_step:
                self.state.mark_step_done(current_step["id"])
                logger.broadcast({"type": "plan", "plan": self.state.plan})

            if reflection.goal_complete:
                self._finish(reflection.diagnosis or "Goal verified complete.")
                break

            self._maybe_abort()
            self.state.save()

        if not self.state.finished:
            logger.warn("Iteration cap reached without finish.",
                        iterations=self.state.iteration)
            self.state.finish_summary = (
                f"Stopped after {self.state.iteration} iterations without "
                f"finish. Inspect agent.log + state.json + memory.json."
            )
            self.state.save()

        return self.state.to_dict()

    # ------------------------------------------------------------------ #
    # Internal helpers
    # ------------------------------------------------------------------ #

    def _decide(self, last_observation: str) -> Dict[str, Any]:
        memory_summary = self.memory.summary()
        ws_summary = workspace.snapshot()
        # Add a relevance-ranked code excerpt — light-weight "semantic" injection.
        relevant = workspace.relevant_context(self.goal)
        if relevant and relevant != "(no relevant files indexed)":
            ws_summary = f"{ws_summary}\n\n# Relevant file excerpts\n{relevant}"

        messages = prompts.build_agent_messages(
            goal=self.goal,
            plan=self.state.plan,
            workspace_summary=ws_summary,
            memory_summary=memory_summary,
            recent_history=self.memory.recent(),
            last_observation=last_observation,
        )
        return self.client.respond_json(messages, temperature=0.2)

    def _record(self, thought: str, action: Dict[str, Any],
                observation: str, *, success: bool) -> None:
        self.memory.append(
            thought=thought,
            action=action,
            observation=observation,
            success=success,
        )

    def _maybe_abort(self) -> None:
        if self.state.consecutive_failures >= config.MAX_CONSECUTIVE_FAILURES:
            logger.error(
                "Too many consecutive failures — aborting to avoid an infinite loop.",
                consecutive_failures=self.state.consecutive_failures,
            )
            self.state.finished = True
            self.state.finish_summary = (
                f"Aborted after {self.state.consecutive_failures} consecutive "
                f"failures. Review agent.log for diagnosis."
            )

    def _finish(self, summary: str) -> None:
        self.state.finished = True
        self.state.finish_summary = summary
        self.state.save()
        logger.info("AGENT FINISHED", summary=summary)
        logger.broadcast({
            "type": "finished",
            "summary": summary,
            "state": self.state.to_dict(),
        })
