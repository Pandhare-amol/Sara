"""Local social-intelligence adapter for SARA.

This module plans conversational behavior without generating model responses or
claiming certainty about a person's internal state. It delegates persistence to
the existing local MEMORY service and proactive policy engine.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, Literal

from .platform_core import MEMORY
from .proactive_interaction import ENGINE as PROACTIVE_ENGINE

Emotion = Literal["happy", "sad", "angry", "frustrated", "confused", "excited", "stressed", "bored", "neutral", "tired", "uncertain"]
ConversationState = Literal["IDLE", "LISTENING", "THINKING", "RESPONDING", "CASUAL_CHAT", "HELPING", "EMOTIONAL_SUPPORT", "PLAYFUL", "PRANK", "QUIET", "INTERRUPTED"]


@dataclass
class Personality:
    friendliness: float = 0.85
    humor: float = 0.65
    curiosity: float = 0.80
    seriousness: float = 0.60
    playfulness: float = 0.70
    verbosity: float = 0.45
    confidence: float = 0.75
    formality: float = 0.35
    proactivity: float = 0.50


@dataclass
class SocialSettings:
    proactive_conversation: bool = False
    smart_interruption: bool = False
    humor: bool = True
    playful_mode: bool = False
    prank_mode: bool = False
    emotion_awareness: bool = True
    conversation_memory: bool = True
    ai_perspective: bool = True
    quiet_mode: bool = False
    interruption_permission: bool = False
    conversation_cooldown: int = 1800
    personality: Personality = field(default_factory=Personality)


@dataclass
class EmotionSignal:
    emotion: Emotion
    confidence: float
    evidence: list[str]


class SocialIntelligence:
    """Small, deterministic policy layer used before model response generation."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._settings = SocialSettings()
        self._state: ConversationState = "IDLE"
        self._topic = ""
        self._last_turn_at = 0.0
        self._interaction_count = 0
        self._load_environment()
        self._load()

    @property
    def settings(self) -> SocialSettings:
        with self._lock:
            return SocialSettings(
                **{key: value for key, value in asdict(self._settings).items() if key != "personality"},
                personality=Personality(**asdict(self._settings.personality)),
            )

    def _path(self) -> Path:
        root = Path(os.environ.get("SARA_DATA_DIR") or Path.cwd() / "logs")
        root.mkdir(parents=True, exist_ok=True)
        return root / "social_intelligence.json"

    def _load(self) -> None:
        try:
            payload = json.loads(self._path().read_text(encoding="utf-8"))
            if not isinstance(payload, dict):
                return
            personality = payload.get("personality") or {}
            self._interaction_count = max(0, int(payload.get("interaction_count", 0)))
            self._settings = SocialSettings(
                **{key: value for key, value in payload.items() if key in SocialSettings.__dataclass_fields__ and key != "personality"},
                personality=Personality(**{key: value for key, value in personality.items() if key in Personality.__dataclass_fields__}),
            )
        except (OSError, ValueError, TypeError):
            return

    def _load_environment(self) -> None:
        def flag(name: str, default: bool) -> bool:
            value = os.environ.get(name)
            return default if value is None else value.strip().lower() in {"1", "true", "yes", "on"}

        try:
            cooldown = max(0, int(os.environ.get("CONVERSATION_COOLDOWN", self._settings.conversation_cooldown)))
        except (TypeError, ValueError):
            cooldown = self._settings.conversation_cooldown
        self._settings = SocialSettings(
            proactive_conversation=flag("PROACTIVE_CONVERSATION", self._settings.proactive_conversation),
            smart_interruption=flag("SMART_INTERRUPTION", self._settings.smart_interruption),
            humor=flag("HUMOR", self._settings.humor),
            playful_mode=flag("PLAYFUL_MODE", self._settings.playful_mode),
            prank_mode=flag("PRANK_MODE", self._settings.prank_mode),
            emotion_awareness=flag("EMOTION_AWARENESS", self._settings.emotion_awareness),
            conversation_memory=flag("LONG_TERM_MEMORY", self._settings.conversation_memory),
            quiet_mode=flag("QUIET_MODE", self._settings.quiet_mode),
            interruption_permission=self._settings.interruption_permission,
            conversation_cooldown=cooldown,
            ai_perspective=self._settings.ai_perspective,
            personality=self._settings.personality,
        )

    def _save(self) -> None:
        try:
            path = self._path()
            temporary = path.with_suffix(".tmp")
            temporary.write_text(json.dumps(asdict(self._settings), indent=2), encoding="utf-8")
            temporary.replace(path)
        except OSError:
            return

    def update_settings(self, patch: Dict[str, Any]) -> Dict[str, Any]:
        with self._lock:
            aliases = {
                "proactiveConversation": "proactive_conversation",
                "smartInterruption": "smart_interruption",
                "playfulMode": "playful_mode",
                "prankMode": "prank_mode",
                "emotionAwareness": "emotion_awareness",
                "conversationMemory": "conversation_memory",
                "aiPerspective": "ai_perspective",
                "quietMode": "quiet_mode",
                "interruptionPermission": "interruption_permission",
            }
            for key in ("proactive_conversation", "smart_interruption", "humor", "playful_mode", "prank_mode", "emotion_awareness", "conversation_memory", "ai_perspective", "quiet_mode", "interruption_permission"):
                source_key = next((candidate for candidate, target in aliases.items() if target == key), key)
                if source_key in patch:
                    setattr(self._settings, key, bool(patch[source_key]))
            cooldown = patch.get("conversation_cooldown", patch.get("conversationCooldown"))
            if cooldown is not None:
                self._settings.conversation_cooldown = max(0, int(cooldown))
            personality = patch.get("personality")
            if isinstance(personality, dict):
                for key in Personality.__dataclass_fields__:
                    if key in personality:
                        setattr(self._settings.personality, key, max(0.0, min(1.0, float(personality[key]))))
            if "quiet_mode" in patch or "quietMode" in patch:
                PROACTIVE_ENGINE.set_quiet(bool(patch.get("quiet_mode", patch.get("quietMode"))))
            self._save()
            return self.snapshot()

    def detect_emotion(self, text: str) -> Dict[str, Any]:
        normalized = text.lower().strip()
        patterns: list[tuple[Emotion, tuple[str, ...], float]] = [
            ("frustrated", ("stupid", "not working", "broken", "again", "annoying", "can't fix"), 0.82),
            ("confused", ("don't understand", "what does", "confused", "unclear", "how do i"), 0.76),
            ("stressed", ("deadline", "overwhelmed", "too much", "panic", "exam tomorrow"), 0.78),
            ("sad", ("failed", "disappointed", "lonely", "lost"), 0.74),
            ("excited", ("amazing", "worked", "great", "awesome", "finally"), 0.78),
            ("angry", ("hate", "furious", "angry", "ridiculous"), 0.72),
            ("tired", ("exhausted", "sleepy", "so tired"), 0.76),
            ("bored", ("boring", "nothing to do", "bored"), 0.70),
        ]
        for emotion, terms, confidence in patterns:
            evidence = [term for term in terms if term in normalized]
            if evidence:
                return asdict(EmotionSignal(emotion, confidence, evidence))
        return asdict(EmotionSignal("neutral", 0.55, []))

    def plan_response(self, text: str, context: Dict[str, Any] | None = None) -> Dict[str, Any]:
        context = context or {}
        with self._lock:
            emotion = self.detect_emotion(text) if self._settings.emotion_awareness else asdict(EmotionSignal("neutral", 0.0, []))
            normalized = text.lower().strip()
            vague_help = bool(re.search(r"\b(help me with my project|help me with this|i need help)\b", normalized))
            serious = emotion["emotion"] in {"sad", "angry", "stressed", "frustrated"}
            casual = any(word in normalized for word in ("hello", "hi sara", "how are you", "good morning", "joke"))
            self._state = "EMOTIONAL_SUPPORT" if serious else "CASUAL_CHAT" if casual else "HELPING"
            self._topic = str(context.get("topic") or context.get("current_task") or self._topic or "")[:160]
            self._last_turn_at = time.time()
            should_ask = vague_help or bool(context.get("missing_information"))
            memories = []
            if self._settings.conversation_memory:
                try:
                    memories = [item["content"][:240] for item in MEMORY.search(text, limit=3) if isinstance(item, dict) and item.get("content")]
                except Exception:
                    memories = []
            humor_allowed = self._settings.humor and not serious and not bool(context.get("avoid_humor"))
            playful_allowed = humor_allowed and self._settings.playful_mode and not bool(context.get("professional"))
            return {
                "intent": str(context.get("intent") or "conversation"),
                "emotion": emotion["emotion"],
                "emotion_confidence": emotion["confidence"],
                "emotion_evidence": emotion["evidence"],
                "conversation_topic": self._topic,
                "conversation_state": self._state,
                "relevant_memories": memories,
                "relationship_state": str(context.get("relationship_state") or self._relationship_state()),
                "personality": asdict(self._settings.personality),
                "humor_allowed": humor_allowed,
                "playful_allowed": playful_allowed,
                "prank_allowed": self._settings.prank_mode and playful_allowed,
                "proactive_allowed": self._settings.proactive_conversation and not self._settings.quiet_mode,
                "should_ask_question": should_ask,
                "should_offer_help": True,
                "should_remain_silent": False,
                "response_style": "supportive" if serious else "casual" if casual else "clear",
            }

    def should_respond(self, context: Dict[str, Any]) -> Dict[str, Any]:
        with self._lock:
            if not self._settings.proactive_conversation:
                return {"action": "WAIT", "reason": "proactive_conversation_disabled", "relevance": 0.0, "confidence": 1.0}
            if self._settings.quiet_mode:
                return {"action": "WAIT", "reason": "quiet_mode", "relevance": 0.0, "confidence": 1.0}
            last_spoken = float(context.get("last_sara_spoke_at") or 0)
            cooldown_left = max(0.0, self._settings.conversation_cooldown - (time.time() - last_spoken)) if last_spoken else 0.0
            if cooldown_left > 0 and not context.get("important_event"):
                return {"action": "WAIT", "reason": "conversation_cooldown", "cooldown_seconds": round(cooldown_left, 1), "relevance": 0.0, "confidence": 1.0}
            try:
                evaluation = PROACTIVE_ENGINE.evaluate(context)
            except Exception:
                return {"action": "WAIT", "reason": "proactive_policy_unavailable", "relevance": 0.0, "confidence": 1.0}
            relevance = float(evaluation.get("conversation_score", 0.0))
            confidence = min(1.0, relevance + (0.2 if evaluation.get("context_grounded") else 0.0))
            if context.get("user_busy") and not context.get("important_event"):
                return {"action": "WAIT", "reason": "user_busy", "relevance": relevance, "confidence": confidence}
            if context.get("user_busy") and context.get("important_event") and not self._settings.smart_interruption:
                return {"action": "WAIT", "reason": "smart_interruption_disabled", "relevance": relevance, "confidence": confidence}
            if evaluation.get("action") in {"ASK", "SAY"} and confidence >= 0.6:
                topic = evaluation.get("topic") or {}
                topic_text = str(topic.get("topic") or context.get("current_task") or "your work").strip()
                prompt = f"You have been working on {topic_text}. Want to continue, or should I help with the next step?" if context.get("user_busy") else f"I have context about {topic_text}. Would you like to pick that up?"
                return {"action": evaluation["action"], "response_type": "proactive_help", "reason": evaluation.get("reason"), "relevance": relevance, "confidence": confidence, "topic": topic, "suggested_prompt": prompt}
            return {"action": "WAIT", "reason": "low_confidence_or_cooldown", "relevance": relevance, "confidence": confidence}

    def record_turn(self, text: str, context: Dict[str, Any] | None = None) -> Dict[str, Any]:
        plan = self.plan_response(text, context)
        self._interaction_count += 1
        if self._settings.conversation_memory and not re.search(r"\b(password|token|api key|secret|medical|health diagnosis)\b", text, re.IGNORECASE):
            try:
                MEMORY.remember("conversation_context", text[:500], {"topic": plan["conversation_topic"], "emotion": plan["emotion"], "source": "social_intelligence"})
            except Exception:
                pass
        self._save()
        return plan

    def _relationship_state(self) -> str:
        if self._interaction_count >= 50:
            return "familiar_user"
        if self._interaction_count >= 10:
            return "regular_user"
        if self._interaction_count >= 1:
            return "new_user"
        return "stranger"

    def snapshot(self) -> Dict[str, Any]:
        with self._lock:
            return {"settings": asdict(self._settings), "conversation_state": self._state, "topic": self._topic, "last_turn_at": self._last_turn_at, "interaction_count": self._interaction_count, "relationship_state": self._relationship_state()}


SOCIAL_INTELLIGENCE = SocialIntelligence()
