"""Contextual proactive conversation and computational emotional state.

This module is deliberately local and conservative. Gemini may use its output
as context, but this engine never invents memories, diagnoses feelings, or
speaks by itself. It decides whether an opportunity is worth presenting.
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from typing import Any, Dict

from .registry import register


_STATES = {
    "CALM", "HAPPY", "CURIOUS", "CONCERNED", "WORRIED", "FOCUSED",
    "SERIOUS", "QUIET", "SUPPORTIVE", "EXCITED", "RELIEVED",
}
_ACTIVE_LEVELS = {"high", "medium", "typing", "coding", "presenting", "gaming", "working"}
_MIN_COOLDOWN_SECONDS = 30 * 60
_EMOTION_HALF_LIFE_SECONDS = 45 * 60


def _state_path() -> Path:
    root = Path(os.environ.get("SARA_DATA_DIR") or Path.cwd() / "data")
    root.mkdir(parents=True, exist_ok=True)
    return root / "proactive_interaction.json"


class ProactiveInteractionEngine:
    """One owner for opportunity scoring, cooldowns, privacy, and emotion."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._state: Dict[str, Any] = {
            "quiet_mode": False,
            "last_proactive_at": 0.0,
            "last_topic": "",
            "ignored_count": 0,
            "current_mode": "NORMAL",  # PERSONAL, PROFESSIONAL, FRIENDLY, COMPANION
            "business_priorities": [],  # Business goals being tracked
            "unmet_business_goals": [],  # Goals currently at risk
            "unanswered_questions": 0,  # Count of questions awaiting answers
            "emotional_state": {
                "state": "CALM",
                "intensity": 0.35,
                "confidence": 0.5,
                "trigger": "startup",
                "updated_at": time.time(),
            },
        }
        self._load()

    def _load(self) -> None:
        try:
            loaded = json.loads(_state_path().read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                self._state.update({k: loaded[k] for k in self._state if k in loaded})
        except (OSError, ValueError, TypeError):
            pass

    def _save(self) -> None:
        try:
            path = _state_path()
            temporary = path.with_suffix(".tmp")
            temporary.write_text(json.dumps(self._state, indent=2), encoding="utf-8")
            temporary.replace(path)
        except OSError:
            pass

    def set_quiet(self, enabled: bool) -> Dict[str, Any]:
        with self._lock:
            self._state["quiet_mode"] = bool(enabled)
            if enabled:
                self._transition("QUIET", 0.8, "user_requested_silence")
            elif self._state["emotional_state"].get("state") == "QUIET":
                self._transition("CALM", 0.4, "quiet_mode_disabled")
            self._save()
            return self.snapshot()

    def set_current_mode(self, mode: str) -> Dict[str, Any]:
        """Update the current SARA operating mode."""
        with self._lock:
            valid_modes = {"NORMAL", "PROFESSIONAL", "FRIENDLY", "COMPANION", "PERSONAL"}
            if mode in valid_modes:
                self._state["current_mode"] = mode
            self._save()
            return self.snapshot()

    def set_business_priorities(self, goals: list[str]) -> Dict[str, Any]:
        """Update business/professional goals being tracked."""
        with self._lock:
            self._state["business_priorities"] = list(goals)[:10]  # Limit to top 10
            self._save()
            return self.snapshot()

    def set_unanswered_questions_count(self, count: int) -> Dict[str, Any]:
        """Update count of unanswered strategic questions."""
        with self._lock:
            self._state["unanswered_questions"] = max(0, int(count))
            self._save()
            return self.snapshot()

    def _transition(self, state: str, intensity: float, trigger: str) -> None:
        if state not in _STATES:
            state = "CALM"
        previous = self._state.get("emotional_state", {}).get("state", "CALM")
        self._state["emotional_state"] = {
            "state": state,
            "intensity": max(0.0, min(1.0, float(intensity))),
            "confidence": 0.7 if state != "CALM" else 0.5,
            "trigger": trigger,
            "previous_state": previous,
            "updated_at": time.time(),
        }

    def _decay_emotion(self, now: float) -> None:
        emotion = self._state.get("emotional_state", {})
        updated_at = float(emotion.get("updated_at", now))
        elapsed = max(0.0, now - updated_at)
        decay = 0.5 ** (elapsed / _EMOTION_HALF_LIFE_SECONDS)
        emotion["intensity"] = round(max(0.05, float(emotion.get("intensity", 0.35)) * decay), 3)
        emotion["decay"] = "exponential"
        emotion["duration_seconds"] = round(elapsed, 1)
        emotion["updated_at"] = now

    @staticmethod
    def _safe_topic(context: Dict[str, Any]) -> str:
        privacy = str(context.get("privacy_level") or "").upper()
        if privacy in {"PRIVATE", "SENSITIVE", "DO_NOT_STORE"} or context.get("do_not_store"):
            return ""
        for key in ("unfinished_topic", "previous_topic", "current_task", "relevant_memory", "user_goal"):
            value = context.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()[:160]
        return ""

    def select_topic(self, context: Dict[str, Any]) -> Dict[str, Any]:
        topic = self._safe_topic(context)
        return {
            "topic": topic,
            "grounded": bool(topic),
            "source": "context" if topic else None,
            "privacy_filtered": not bool(topic) and str(context.get("privacy_level") or "").upper() in {"PRIVATE", "SENSITIVE", "DO_NOT_STORE"},
        }

    def update_emotion(self, event: str, confidence: float = 0.6) -> Dict[str, Any]:
        mapping = {
            "user_success": ("HAPPY", 0.7),
            "task_complete": ("RELIEVED", 0.55),
            "task_failed": ("CONCERNED", 0.7),
            "repeated_failure": ("SUPPORTIVE", 0.8),
            "user_excited": ("EXCITED", 0.75),
            "serious_topic": ("SERIOUS", 0.75),
            "user_frustrated": ("SUPPORTIVE", 0.8),
            "user_speaking": ("FOCUSED", 0.5),
        }
        with self._lock:
            state, intensity = mapping.get(event, ("CURIOUS", 0.35))
            self._transition(state, min(1.0, intensity * max(0.0, min(1.0, confidence))), event)
            self._save()
            return self.snapshot()

    def evaluate(self, context: Dict[str, Any]) -> Dict[str, Any]:
        with self._lock:
            now = time.time()
            self._decay_emotion(now)
            activity = str(context.get("user_activity") or context.get("activity_level") or "idle").lower()
            idle_seconds = float(context.get("idle_duration") or context.get("idle_seconds") or 0)
            quiet = bool(context.get("quiet_mode", self._state.get("quiet_mode", False)))
            focused = activity in _ACTIVE_LEVELS or bool(context.get("focused_work"))
            important = bool(context.get("important_event") or context.get("safety_concern"))
            unfinished = bool(context.get("unfinished_topic") or context.get("current_task"))
            relevant_memory = bool(context.get("relevant_memory") or context.get("previous_topic"))
            ignored = int(self._state.get("ignored_count", 0))
            cooldown_left = max(0.0, _MIN_COOLDOWN_SECONDS - (now - float(self._state.get("last_proactive_at", 0))))

            # Business context: in PROFESSIONAL mode, questions and decisions take priority
            current_mode = str(context.get("mode") or self._state.get("current_mode", "NORMAL")).upper()
            has_unanswered_questions = bool(context.get("unanswered_questions") or self._state.get("unanswered_questions", 0))
            has_business_goals = bool(context.get("business_goals") or self._state.get("business_priorities", []))
            
            score = 0.0
            score += 0.38 if idle_seconds >= 600 else 0.18 if idle_seconds >= 180 else 0.0
            score += 0.28 if relevant_memory else 0.0
            score += 0.22 if unfinished else 0.0
            score += 0.35 if important else 0.0
            
            # PROFESSIONAL mode: boost score if there are unanswered questions or business goals
            if current_mode == "PROFESSIONAL":
                score += 0.25 if has_unanswered_questions else 0.0
                score += 0.15 if has_business_goals else 0.0
            
            score -= 0.45 if focused else 0.0
            score -= min(0.25, ignored * 0.05)
            score = max(0.0, min(1.0, score))

            allowed = not quiet and (cooldown_left <= 0 or important) and (not focused or important or has_unanswered_questions)
            action = "SAY" if allowed and score >= 0.72 else "ASK" if allowed and score >= 0.5 else "WAIT"
            
            # In PROFESSIONAL mode with questions, escalate to ASK
            if current_mode == "PROFESSIONAL" and has_unanswered_questions and score >= 0.4:
                action = "ASK"
            
            reason = "important_event" if important else "relevant_context" if relevant_memory or unfinished else "unanswered_questions" if has_unanswered_questions else "business_goal" if has_business_goals else "user_idle" if idle_seconds >= 180 else "low_signal"
            return {
                "action": action,
                "conversation_score": round(score, 3),
                "reason": reason,
                "cooldown_seconds": round(cooldown_left, 1),
                "quiet_mode": quiet,
                "focused_work": focused,
                "current_mode": current_mode,
                "emotional_state": dict(self._state["emotional_state"]),
                "context_grounded": bool(relevant_memory or unfinished or important or has_unanswered_questions),
                "topic": self.select_topic(context),
            }

    def record_outcome(self, accepted: bool, topic: str = "") -> Dict[str, Any]:
        with self._lock:
            topic = str(topic)[:160]
            if accepted:
                self._state["last_proactive_at"] = time.time()
                self._state["ignored_count"] = 0
                self._state["last_topic"] = topic
            else:
                self._state["ignored_count"] = min(10, int(self._state.get("ignored_count", 0)) + 1)
            self._save()
            return self.snapshot()

    def snapshot(self) -> Dict[str, Any]:
        return {
            "quiet_mode": bool(self._state.get("quiet_mode", False)),
            "last_topic": self._state.get("last_topic", ""),
            "ignored_count": int(self._state.get("ignored_count", 0)),
            "current_mode": self._state.get("current_mode", "NORMAL"),
            "business_priorities": self._state.get("business_priorities", []),
            "unanswered_questions": self._state.get("unanswered_questions", 0),
            "emotional_state": dict(self._state.get("emotional_state", {})),
        }


ENGINE = ProactiveInteractionEngine()


@register("saraProactiveEvaluate")
def sara_proactive_evaluate(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": ENGINE.evaluate(args.get("context") if isinstance(args.get("context"), dict) else args)}


@register("saraProactiveRecordOutcome")
def sara_proactive_record_outcome(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": ENGINE.record_outcome(bool(args.get("accepted")), str(args.get("topic") or ""))}


@register("saraEmotionalState")
def sara_emotional_state(args: Dict[str, Any]) -> Dict[str, Any]:
    if args.get("event"):
        return {"result": ENGINE.update_emotion(str(args["event"]), float(args.get("confidence", 0.6)))}
    return {"result": ENGINE.snapshot()}


@register("saraQuietMode")
def sara_quiet_mode(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": ENGINE.set_quiet(bool(args.get("enabled", True)))}


@register("saraSetMode")
def sara_set_mode(args: Dict[str, Any]) -> Dict[str, Any]:
    """Set SARA's operating mode (PERSONAL, PROFESSIONAL, etc)."""
    mode = str(args.get("mode", "NORMAL")).upper()
    return {"result": ENGINE.set_current_mode(mode)}


@register("saraSetBusinessPriorities")
def sara_set_business_priorities(args: Dict[str, Any]) -> Dict[str, Any]:
    """Update business goals SARA is tracking."""
    goals = args.get("goals") or []
    if isinstance(goals, str):
        goals = [goals]
    return {"result": ENGINE.set_business_priorities([str(g) for g in goals])}


@register("saraSetUnansweredQuestions")
def sara_set_unanswered_questions(args: Dict[str, Any]) -> Dict[str, Any]:
    """Update count of unanswered strategic questions."""
    count = int(args.get("count", 0))
    return {"result": ENGINE.set_unanswered_questions_count(count)}