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
from datetime import datetime
from pathlib import Path
from typing import Any, Dict

from .registry import register


_STATES = {
    "CALM", "HAPPY", "CURIOUS", "CONCERNED", "WORRIED", "FOCUSED",
    "SERIOUS", "QUIET", "SUPPORTIVE", "EXCITED", "RELIEVED",
}
_ACTIVE_LEVELS = {"high", "medium", "typing", "coding", "presenting", "gaming", "working"}
_DEFAULT_COOLDOWN_SECONDS = 45 * 60
_EMOTION_HALF_LIFE_SECONDS = 45 * 60


def _state_path() -> Path:
    root = Path(os.environ.get("SARA_DATA_DIR") or Path.cwd() / "data")
    root.mkdir(parents=True, exist_ok=True)
    return root / "proactive_interaction.json"


class ProactiveInteractionEngine:
    """One owner for opportunity scoring, timing limits, privacy, and emotion."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._state: Dict[str, Any] = {
            "quiet_mode": False,
            "last_proactive_at": 0.0,
            "daily_proactive_date": "",
            "daily_proactive_count": 0,
            "last_topic": "",
            "recent_proactive_topics": [],
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
        for key in ("unfinished_topic", "relevant_memory", "previous_topic", "current_task", "user_goal"):
            value = context.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()[:160]
        return ""

    def select_topic(self, context: Dict[str, Any]) -> Dict[str, Any]:
        privacy = str(context.get("privacy_level") or "").upper()
        topic = self._safe_topic(context)
        memory = ""
        if privacy not in {"PRIVATE", "SENSITIVE", "DO_NOT_STORE"} and not context.get("do_not_store"):
            candidate = context.get("relevant_memory")
            if isinstance(candidate, str) and candidate.strip():
                memory = candidate.strip()[:320]
        return {
            "topic": topic,
            "memory": memory,
            "grounded": bool(topic or memory),
            "source": "memory" if memory else "context" if topic else None,
            "privacy_filtered": not bool(topic or memory) and privacy in {"PRIVATE", "SENSITIVE", "DO_NOT_STORE"},
        }

    def _remember_topic(self, topic: str) -> None:
        normalized = " ".join(str(topic).strip().split())[:160]
        if not normalized:
            return
        recent = self._state.get("recent_proactive_topics", [])
        recent = [str(value) for value in recent if str(value).casefold() != normalized.casefold()]
        recent.append(normalized)
        self._state["recent_proactive_topics"] = recent[-8:]
        self._state["last_topic"] = normalized

    @staticmethod
    def _local_date_key(timestamp: float) -> str:
        return time.strftime("%Y-%m-%d", time.localtime(timestamp))

    @staticmethod
    def _minutes_since_midnight(value: Any, fallback: str) -> int:
        try:
            hour_text, minute_text = str(value).split(":", 1)
            hour, minute = int(hour_text), int(minute_text)
            if 0 <= hour <= 23 and 0 <= minute <= 59:
                return hour * 60 + minute
        except (TypeError, ValueError):
            pass
        fallback_hour, fallback_minute = (int(part) for part in fallback.split(":"))
        return fallback_hour * 60 + fallback_minute

    @classmethod
    def _is_within_quiet_hours(cls, current_local_time: datetime, start: Any, end: Any) -> bool:
        """Handle both ordinary and overnight local quiet-hour windows."""
        start_minute = cls._minutes_since_midnight(start, "22:00")
        end_minute = cls._minutes_since_midnight(end, "08:00")
        current_minute = current_local_time.hour * 60 + current_local_time.minute
        if start_minute == end_minute:
            return True
        if start_minute < end_minute:
            return start_minute <= current_minute < end_minute
        return current_minute >= start_minute or current_minute < end_minute

    def _daily_count(self, now: float) -> int:
        if self._state.get("daily_proactive_date") != self._local_date_key(now):
            return 0
        try:
            return max(0, int(self._state.get("daily_proactive_count", 0)))
        except (TypeError, ValueError):
            return 0

    def record_proactive_sent(self, topic: str = "") -> Dict[str, Any]:
        """Persist a sent check-in so reconnects honor cooldown, topic variety, and daily limits."""
        with self._lock:
            now = time.time()
            today = self._local_date_key(now)
            current_count = self._daily_count(now) if self._state.get("daily_proactive_date") == today else 0
            self._state["last_proactive_at"] = now
            self._state["daily_proactive_date"] = today
            self._state["daily_proactive_count"] = current_count + 1
            self._remember_topic(topic)
            self._save()
            return self.snapshot()

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

            try:
                cooldown_seconds = max(0, int(context.get("conversation_cooldown_seconds", _DEFAULT_COOLDOWN_SECONDS)))
            except (TypeError, ValueError):
                cooldown_seconds = _DEFAULT_COOLDOWN_SECONDS
            cooldown_left = max(0.0, cooldown_seconds - (now - float(self._state.get("last_proactive_at", 0))))

            try:
                daily_limit = max(0, int(context.get("max_proactive_conversations_per_day", 3)))
            except (TypeError, ValueError):
                daily_limit = 3
            daily_count = self._daily_count(now)
            daily_limit_reached = daily_count >= daily_limit

            quiet_hours_enabled = bool(context.get("quiet_hours_enabled", True))
            local_now = datetime.fromtimestamp(now).astimezone()
            in_quiet_hours = quiet_hours_enabled and self._is_within_quiet_hours(
                local_now,
                context.get("quiet_hours_start", "22:00"),
                context.get("quiet_hours_end", "08:00"),
            )

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

            allowed = (
                not quiet
                and not in_quiet_hours
                and not daily_limit_reached
                and (cooldown_left <= 0 or important)
                and (not focused or important or has_unanswered_questions)
            )
            action = "SAY" if allowed and score >= 0.72 else "ASK" if allowed and score >= 0.5 else "WAIT"

            # In PROFESSIONAL mode with questions, escalate only when all safety gates pass.
            if allowed and current_mode == "PROFESSIONAL" and has_unanswered_questions and score >= 0.4:
                action = "ASK"

            policy_reason = (
                "quiet_mode" if quiet else
                "quiet_hours" if in_quiet_hours else
                "daily_limit_reached" if daily_limit_reached else
                "conversation_cooldown" if cooldown_left > 0 and not important else
                "user_focused" if focused and not important and not has_unanswered_questions else
                None
            )
            reason = "important_event" if important else "relevant_context" if relevant_memory or unfinished else "unanswered_questions" if has_unanswered_questions else "business_goal" if has_business_goals else "user_idle" if idle_seconds >= 180 else "low_signal"
            return {
                "action": action,
                "conversation_score": round(score, 3),
                "reason": reason,
                "policy_reason": policy_reason,
                "cooldown_seconds": round(cooldown_left, 1),
                "daily_count": daily_count,
                "daily_limit": daily_limit,
                "quiet_mode": quiet,
                "quiet_hours": in_quiet_hours,
                "focused_work": focused,
                "current_mode": current_mode,
                "emotional_state": dict(self._state["emotional_state"]),
                "context_grounded": bool(relevant_memory or unfinished or important or has_unanswered_questions),
                "topic": self.select_topic(context),
            }

    def record_outcome(self, accepted: bool, topic: str = "") -> Dict[str, Any]:
        with self._lock:
            topic = str(topic)[:160]
            if accepted and topic:
                self._remember_topic(topic)
            if accepted:
                self._state["last_proactive_at"] = time.time()
                self._state["ignored_count"] = 0
            else:
                self._state["ignored_count"] = min(10, int(self._state.get("ignored_count", 0)) + 1)
            self._save()
            return self.snapshot()

    def snapshot(self) -> Dict[str, Any]:
        now = time.time()
        return {
            "quiet_mode": bool(self._state.get("quiet_mode", False)),
            "daily_proactive_date": self._local_date_key(now),
            "daily_proactive_count": self._daily_count(now),
            "last_topic": self._state.get("last_topic", ""),
            "recent_proactive_topics": list(self._state.get("recent_proactive_topics", []))[-8:],
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
    topic = str(args.get("topic") or "")
    if args.get("sent") is True:
        return {"result": ENGINE.record_proactive_sent(topic)}
    return {"result": ENGINE.record_outcome(bool(args.get("accepted")), topic)}


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