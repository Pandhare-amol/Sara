"""
SARA Desktop Control Agent â€” FastAPI entrypoint.

Single dispatch endpoint POST /execute { tool, args } -> { result } | { error }.
SARA's Node bridge (server.ts) calls this over HTTP on 127.0.0.1:8765.

Run:
    uvicorn desktop_agent.main:app --host 127.0.0.1 --port 8765
or:
    python -m desktop_agent.main
"""

from __future__ import annotations

import logging
import os
import sys
import traceback
import time
from contextlib import asynccontextmanager
from typing import Any, Dict

from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from . import __version__
from .vision_engine import VISION_ENGINE
from .android_companion import ANDROID_COMPANION_MANAGER
from .agents import MANAGER
from .platform_core import HEALTH
from .registry import DESKTOP_TOOL_NAMES, TOOLS, TOOL_REGISTRY, ToolError, load_all
from .verification import VerificationEngine as PersistentVerificationEngine
from .reward_engine import RewardEngine
from .tool_result import make_tool_result
from . import stt as stt_module
import asyncio
import tempfile
import os

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("sara.desktop")
START_TIME = time.time()

REWARD_ENGINE = RewardEngine()
VERIFICATION_ENGINE = PersistentVerificationEngine()
_RESULT_CACHE: Dict[str, Dict[str, Any]] = {}


# Load all tool modules so their handlers register before the app starts.
load_all()
log.info("Loaded %d desktop tools: %s", len(TOOLS), ", ".join(sorted(TOOLS)))


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("SARA Desktop Control Agent v%s starting up.", __version__)
    from .state_watcher import start_state_watcher, stop_state_watcher
    
    # Start legacy state watcher
    start_state_watcher()
    
    # Start autonomous perception components (Phase 1)
    try:
        from .situational_awareness import start_awareness_engine
        start_awareness_engine()
        log.info("Situational Awareness Engine started")
    except Exception as e:
        log.warning("Failed to start Situational Awareness Engine: %s", e)
    
    try:
        from .user_activity_monitor import start_activity_monitor
        start_activity_monitor()
        log.info("User Activity Monitor started")
    except Exception as e:
        log.warning("Failed to start User Activity Monitor: %s", e)
    
    try:
        from .background_events import start_event_monitor
        start_event_monitor()
        log.info("Background Event Monitor started")
    except Exception as e:
        log.warning("Failed to start Background Event Monitor: %s", e)
    
    # Start autonomous reasoning components (Phase 2)
    try:
        from .autonomous_decision_engine import start_decision_engine
        start_decision_engine()
        log.info("Autonomous Decision Engine started")
    except Exception as e:
        log.warning("Failed to start Autonomous Decision Engine: %s", e)
    
    try:
        from .conversation_manager import get_conversation_manager
        manager = get_conversation_manager()
        manager.new_conversation()
        log.info("Conversation Manager started")
    except Exception as e:
        log.warning("Failed to start Conversation Manager: %s", e)
    
    try:
        from .proactive_assistant import get_proactive_assistant
        assistant = get_proactive_assistant()
        log.info("Proactive Assistant started")
    except Exception as e:
        log.warning("Failed to start Proactive Assistant: %s", e)
    
    # Start autonomous interaction components (Phase 3)
    try:
        from .personality_manager import PersonalityManager
        manager = PersonalityManager.get_instance()
        log.info("Personality Manager started")
    except Exception as e:
        log.warning("Failed to start Personality Manager: %s", e)
    
    try:
        from .quiet_mode_manager import QuietModeManager
        manager = QuietModeManager.get_instance()
        log.info("Quiet Mode Manager started")
    except Exception as e:
        log.warning("Failed to start Quiet Mode Manager: %s", e)
    
    try:
        from .interruption_policy_manager import InterruptionPolicyManager
        manager = InterruptionPolicyManager.get_instance()
        log.info("Interruption Policy Manager started")
    except Exception as e:
        log.warning("Failed to start Interruption Policy Manager: %s", e)
    
    try:
        from .user_feedback_loop import UserFeedbackLoop
        loop = UserFeedbackLoop.get_instance()
        log.info("User Feedback Loop started")
    except Exception as e:
        log.warning("Failed to start User Feedback Loop: %s", e)
    
    try:
        from .self_shutdown_manager import SelfShutdownManager
        manager = SelfShutdownManager.get_instance()
        log.info("Self-Shutdown Manager started")
    except Exception as e:
        log.warning("Failed to start Self-Shutdown Manager: %s", e)
    
    yield
    
    # Clean shutdown of reasoning components (Phase 2)
    try:
        from .autonomous_decision_engine import stop_decision_engine
        stop_decision_engine()
    except Exception:
        pass
    
    # Clean shutdown of perception components (Phase 1)
    try:
        from .situational_awareness import stop_awareness_engine
        stop_awareness_engine()
    except Exception:
        pass
    
    try:
        from .user_activity_monitor import stop_activity_monitor
        stop_activity_monitor()
    except Exception:
        pass
    
    try:
        from .background_events import stop_event_monitor
        stop_event_monitor()
    except Exception:
        pass
    
    # Clean shutdown of the Playwright browser if it was started.
    try:
        from .tools_browser import shutdown_browser

        shutdown_browser()
    except Exception as e:  # noqa: BLE001
        log.warning("Browser shutdown error: %s", e)
    
    stop_state_watcher()
    log.info("SARA Desktop Control Agent stopped.")


app = FastAPI(
    title="SARA Desktop Control Agent",
    version=__version__,
    description="JARVIS-style desktop automation backend for SARA.",
    lifespan=lifespan,
)

# Same-origin Node bridge is the only caller; allow localhost origins flexibly.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ExecuteRequest(BaseModel):
    tool: str | None = None
    args: Dict[str, Any] = {}
    original_args: Dict[str, Any] | None = None


class ExecuteResponse(BaseModel):
    ok: bool
    result: Any = None
    error: str | None = None
    tool: str


@app.get("/health")
def health() -> Dict[str, Any]:
    """Minimal health check endpoint - no large payloads to avoid chunked encoding issues."""
    status = HEALTH.latest() or HEALTH.run()
    return {
        "status": "ok",
        "service": "sara-desktop-agent",
        "service_version": __version__,
        "protocol_version": "1",
        "pid": os.getpid(),
        "tool_count": len(TOOLS),
        "agent_state": "HEALTHY" if status else "STARTING",
        "health": status,
    }

@app.get("/capabilities")
def capabilities() -> Dict[str, Any]:
    return {
        "status": "PROCESS_HEALTHY",
        "capabilities": {
            "mouse": "saraMouseClick" in TOOLS,
            "keyboard": "saraKeyboardType" in TOOLS,
            "screen": "saraScreenshot" in TOOLS,
            "ocr": "saraOcrText" in TOOLS,
            "browser": "saraBrowserNavigate" in TOOLS,
            "file": "saraFileRead" in TOOLS,
            "window": "saraWindowList" in TOOLS,
        }
    }


@app.get("/status")
def status() -> Dict[str, Any]:
    return {
        "status": "ok",
        "agent_state": "HEALTHY" if (HEALTH.latest() or HEALTH.run()) else "STARTING",
        "pid": os.getpid(),
        "port": int(os.environ.get("SARA_AGENT_PORT", "8765")),
        "uptime": int(time.time() - START_TIME),
        "version": __version__,
        "schema_version": 1,
        "active_operations": 0,
        "last_error": None,
        "tool_registry_loaded": bool(TOOLS),
        "capability_matrix_loaded": True,
    }


@app.get("/health/diagnostics")
def health_diagnostics() -> Dict[str, Any]:
    return {"status": "ok", "result": HEALTH.latest() or HEALTH.run()}


@app.get("/tools")
def list_tools() -> Dict[str, Any]:
    return {"tools": sorted(TOOLS.keys()), "count": len(TOOLS)}


# ----------------------------------------------------------
# Autonomous Perception Endpoints
# ----------------------------------------------------------

@app.get("/perception/awareness")
def get_awareness_state() -> Dict[str, Any]:
    """Get current situational awareness state."""
    try:
        from .situational_awareness import get_awareness_engine
        engine = get_awareness_engine()
        state = engine.get_current_state()
        if state:
            return {
                "status": "ok",
                "context": engine.get_state_context()
            }
        return {"status": "ok", "context": {}}
    except Exception as e:
        log.warning("Error getting awareness state: %s", e)
        return {"status": "error", "error": str(e)}


@app.get("/perception/activity")
def get_user_activity() -> Dict[str, Any]:
    """Get current user activity metrics."""
    try:
        from .user_activity_monitor import get_activity_monitor
        monitor = get_activity_monitor()
        metrics = monitor.get_current_activity()
        if metrics:
            return {
                "status": "ok",
                "activity_level": metrics.combined_activity_level.value,
                "idle_seconds": metrics.idle_duration_seconds,
                "is_idle": metrics.is_user_idle,
                "is_frustrated": metrics.appears_frustrated,
                "is_focused": metrics.appears_focused,
                "keyboard_count_5m": metrics.keyboard_count_5m,
                "mouse_count_5m": metrics.mouse_count_5m
            }
        return {"status": "ok", "activity_level": "unknown"}
    except Exception as e:
        log.warning("Error getting activity metrics: %s", e)
        return {"status": "error", "error": str(e)}


@app.get("/perception/events")
def get_pending_events() -> Dict[str, Any]:
    """Get pending background events that should be notified."""
    try:
        from .background_events import get_event_monitor
        monitor = get_event_monitor()
        events = monitor.get_pending_events()
        return {
            "status": "ok",
            "events": [
                {
                    "event_id": e.event_id,
                    "type": e.event_type.value,
                    "importance": e.importance.value,
                    "title": e.title,
                    "timestamp": e.timestamp
                }
                for e in events[:10]  # Limit to 10
            ],
            "count": len(events)
        }
    except Exception as e:
        log.warning("Error getting events: %s", e)
        return {"status": "error", "error": str(e)}


@app.post("/perception/event/notify")
def mark_event_notified(event_id: str) -> Dict[str, Any]:
    """Mark an event as notified."""
    try:
        from .background_events import get_event_monitor
        monitor = get_event_monitor()
        monitor.mark_notified(event_id)
        return {"status": "ok"}
    except Exception as e:
        log.warning("Error marking event notified: %s", e)
        return {"status": "error", "error": str(e)}


@app.get("/perception/health")
def perception_health() -> Dict[str, Any]:
    """Check health of autonomous perception modules."""
    try:
        from .situational_awareness import get_awareness_engine
        from .user_activity_monitor import get_activity_monitor
        from .background_events import get_event_monitor
        
        awareness_ok = False
        activity_ok = False
        events_ok = False
        
        try:
            engine = get_awareness_engine()
            awareness_ok = engine.get_current_state() is not None
        except Exception:
            pass
        
        try:
            monitor = get_activity_monitor()
            activity_ok = monitor.get_current_activity() is not None
        except Exception:
            pass
        
        try:
            monitor = get_event_monitor()
            events_ok = True  # Always ok if we can get it
        except Exception:
            pass
        
        return {
            "status": "ok",
            "perception_modules": {
                "situational_awareness": "HEALTHY" if awareness_ok else "STARTING",
                "user_activity": "HEALTHY" if activity_ok else "STARTING",
                "background_events": "HEALTHY" if events_ok else "STARTING"
            },
            "overall": "HEALTHY" if all([awareness_ok, activity_ok, events_ok]) else "STARTING"
        }
    except Exception as e:
        log.warning("Error checking perception health: %s", e)
        return {"status": "error", "error": str(e), "overall": "ERROR"}


# ----------------------------------------------------------
# Autonomous Decision Engine Endpoints
# ----------------------------------------------------------

@app.post("/autonomous/decide")
def autonomous_decide(context: Dict[str, Any]) -> Dict[str, Any]:
    """Make an autonomous decision based on perception context."""
    try:
        from .autonomous_decision_engine import get_decision_engine, DecisionContext
        
        engine = get_decision_engine()
        
        # Create decision context from provided data
        decision_context = DecisionContext(
            current_desktop_state=context.get("desktop_state", {}),
            user_activity=context.get("user_activity", {}),
            pending_events=context.get("events", []),
            conversation_history=context.get("conversation_history", []),
            current_topic=context.get("current_topic"),
            user_intent=context.get("user_intent"),
            active_task=context.get("active_task"),
            user_idle_duration=context.get("idle_duration", 0.0),
            user_is_focused=context.get("is_focused", False),
            user_is_frustrated=context.get("is_frustrated", False),
            user_quiet_mode=context.get("quiet_mode", False)
        )
        
        # Make decision
        decision = engine.make_decision(decision_context)
        
        return {
            "status": "ok",
            "decision": {
                "type": decision.decision_type.value,
                "action": decision.action,
                "confidence": decision.confidence,
                "reasoning": decision.reasoning,
                "priority": decision.priority,
                "requires_auth": decision.authorization_required.name,
                "timestamp": decision.timestamp.isoformat()
            }
        }
    except Exception as e:
        log.warning("Error making autonomous decision: %s", e)
        return {"status": "error", "error": str(e)}


@app.get("/autonomous/history")
def get_decision_history(limit: int = 50) -> Dict[str, Any]:
    """Get recent decision history."""
    try:
        from .autonomous_decision_engine import get_decision_engine
        
        engine = get_decision_engine()
        history = engine.get_decision_history(limit)
        
        return {
            "status": "ok",
            "decisions": history,
            "count": len(history)
        }
    except Exception as e:
        log.warning("Error retrieving decision history: %s", e)
        return {"status": "error", "error": str(e)}


# ----------------------------------------------------------
# Conversation Manager Endpoints
# ----------------------------------------------------------

@app.post("/conversation/message")
def conversation_message(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Add a user message to conversation."""
    try:
        from .conversation_manager import get_conversation_manager
        
        manager = get_conversation_manager()
        content = payload.get("content", "")
        
        turn, clarification_intent = manager.add_user_message(content)
        
        return {
            "status": "ok",
            "turn": turn.to_dict() if turn else None,
            "clarification_needed": clarification_intent,
            "conversation_state": manager.get_current_state()
        }
    except Exception as e:
        log.warning("Error processing conversation message: %s", e)
        return {"status": "error", "error": str(e)}


@app.get("/conversation/state")
def conversation_state() -> Dict[str, Any]:
    """Get current conversation state."""
    try:
        from .conversation_manager import get_conversation_manager
        
        manager = get_conversation_manager()
        state = manager.get_current_state()
        
        if state:
            return {
                "status": "ok",
                "conversation_state": state
            }
        return {"status": "ok", "conversation_state": None}
    except Exception as e:
        log.warning("Error getting conversation state: %s", e)
        return {"status": "error", "error": str(e)}


@app.post("/conversation/reset")
def conversation_reset() -> Dict[str, Any]:
    """Start a new conversation."""
    try:
        from .conversation_manager import get_conversation_manager
        
        manager = get_conversation_manager()
        manager.clear_conversation()
        manager.new_conversation()
        
        return {
            "status": "ok",
            "result": "Conversation reset"
        }
    except Exception as e:
        log.warning("Error resetting conversation: %s", e)
        return {"status": "error", "error": str(e)}


@app.post("/conversation/quiet_mode")
def conversation_quiet_mode(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Enable/disable quiet mode."""
    try:
        from .conversation_manager import get_conversation_manager
        
        manager = get_conversation_manager()
        enabled = payload.get("enabled", False)
        manager.set_quiet_mode(enabled)
        
        return {
            "status": "ok",
            "quiet_mode": enabled
        }
    except Exception as e:
        log.warning("Error setting quiet mode: %s", e)
        return {"status": "error", "error": str(e)}


# ----------------------------------------------------------
# Proactive Assistant Endpoints
# ----------------------------------------------------------

@app.post("/proactive/suggest")
def generate_suggestions(context: Dict[str, Any]) -> Dict[str, Any]:
    """Generate proactive suggestions based on observations."""
    try:
        from .proactive_assistant import get_proactive_assistant
        
        assistant = get_proactive_assistant()
        
        suggestions = assistant.generate_suggestions(
            user_activity=context.get("user_activity", {}),
            desktop_state=context.get("desktop_state", {}),
            events=context.get("events", []),
            recent_actions=context.get("recent_actions", [])
        )
        
        return {
            "status": "ok",
            "suggestions": [
                {
                    "suggestion_id": sug.suggestion_id,
                    "type": sug.suggestion_type.value,
                    "title": sug.title,
                    "description": sug.description,
                    "confidence": sug.confidence,
                    "importance": sug.importance,
                    "created_at": sug.created_at.isoformat()
                }
                for sug in suggestions
            ],
            "count": len(suggestions)
        }
    except Exception as e:
        log.warning("Error generating suggestions: %s", e)
        return {"status": "error", "error": str(e)}


@app.post("/proactive/accept")
def accept_suggestion(payload: Dict[str, Any]) -> Dict[str, Any]:
    """User accepted a suggestion."""
    try:
        from .proactive_assistant import get_proactive_assistant
        
        assistant = get_proactive_assistant()
        suggestion_id = payload.get("suggestion_id")
        
        suggestion = assistant.accept_suggestion(suggestion_id)
        
        if suggestion:
            return {
                "status": "ok",
                "result": "Suggestion accepted",
                "action": suggestion.action,
                "parameters": suggestion.parameters
            }
        return {"status": "error", "error": "Suggestion not found"}
    except Exception as e:
        log.warning("Error accepting suggestion: %s", e)
        return {"status": "error", "error": str(e)}


@app.post("/proactive/reject")
def reject_suggestion(payload: Dict[str, Any]) -> Dict[str, Any]:
    """User rejected a suggestion."""
    try:
        from .proactive_assistant import get_proactive_assistant
        
        assistant = get_proactive_assistant()
        suggestion_id = payload.get("suggestion_id")
        
        suggestion = assistant.reject_suggestion(suggestion_id)
        
        if suggestion:
            return {"status": "ok", "result": "Suggestion rejected"}
        return {"status": "error", "error": "Suggestion not found"}
    except Exception as e:
        log.warning("Error rejecting suggestion: %s", e)
        return {"status": "error", "error": str(e)}


@app.get("/proactive/history")
def proactive_history(limit: int = 50) -> Dict[str, Any]:
    """Get proactive suggestion history."""
    try:
        from .proactive_assistant import get_proactive_assistant
        
        assistant = get_proactive_assistant()
        history = assistant.get_suggestion_history(limit)
        
        return {
            "status": "ok",
            "suggestions": history,
            "count": len(history)
        }
    except Exception as e:
        log.warning("Error retrieving suggestion history: %s", e)
        return {"status": "error", "error": str(e)}


# ----------------------------------------------------------
# Personality Manager Endpoints (Phase 3)
# ----------------------------------------------------------

@app.get("/personality/profile")
def get_personality_profile() -> Dict[str, Any]:
    """Get current personality profile."""
    try:
        from .personality_manager import PersonalityManager
        
        manager = PersonalityManager.get_instance()
        profile = manager.get_personality_profile()
        
        return {
            "status": "ok",
            "profile": {
                "address_style": profile.address_style,
                "preferred_tone": profile.preferred_tone,
                "humor_preference": profile.humor_preference,
                "warmth_preference": profile.warmth_preference,
                "verbosity_preference": profile.verbosity_preference,
                "curiosity_preference": profile.curiosity_preference,
                "concern_expression": profile.concern_expression,
                "interrupt_frequency": profile.interrupt_frequency
            }
        }
    except Exception as e:
        log.warning("Error getting personality profile: %s", e)
        return {"status": "error", "error": str(e)}


@app.post("/personality/profile")
def update_personality_profile(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Update personality profile preferences."""
    try:
        from .personality_manager import PersonalityManager
        
        manager = PersonalityManager.get_instance()
        manager.update_personality_profile(payload)
        
        return {"status": "ok", "result": "Personality profile updated"}
    except Exception as e:
        log.warning("Error updating personality profile: %s", e)
        return {"status": "error", "error": str(e)}


@app.get("/personality/emotion")
def get_emotional_state() -> Dict[str, Any]:
    """Get current emotional state."""
    try:
        from .personality_manager import PersonalityManager
        
        manager = PersonalityManager.get_instance()
        state = manager.get_current_state()
        
        return {
            "status": "ok",
            "emotion": {
                "state": state.current_state.value,
                "confidence": state.confidence,
                "trigger": state.trigger,
                "timestamp": state.timestamp.isoformat(),
                "response_prefix": manager.get_response_prefix()
            }
        }
    except Exception as e:
        log.warning("Error getting emotional state: %s", e)
        return {"status": "error", "error": str(e)}


@app.post("/personality/emotion")
def update_emotional_state(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Update emotional state based on trigger."""
    try:
        from .personality_manager import PersonalityManager
        
        manager = PersonalityManager.get_instance()
        trigger = payload.get("trigger", "external_event")
        state = manager.update_state(trigger)
        
        return {
            "status": "ok",
            "emotion": state.current_state.value,
            "confidence": state.confidence
        }
    except Exception as e:
        log.warning("Error updating emotional state: %s", e)
        return {"status": "error", "error": str(e)}


# ----------------------------------------------------------
# Quiet Mode Manager Endpoints (Phase 3)
# ----------------------------------------------------------

@app.get("/quiet-mode/state")
def get_quiet_mode_state() -> Dict[str, Any]:
    """Get current quiet mode state."""
    try:
        from .quiet_mode_manager import QuietModeManager
        
        manager = QuietModeManager.get_instance()
        state = manager.get_state()
        
        return {
            "status": "ok",
            "quiet_mode": {
                "level": state.level.value,
                "enabled": manager.is_quiet(),
                "enabled_at": state.enabled_at.isoformat() if state.enabled_at else None,
                "duration": state.duration,
                "reason": state.reason,
                "auto_resume_at": state.auto_resume_at.isoformat() if state.auto_resume_at else None
            }
        }
    except Exception as e:
        log.warning("Error getting quiet mode state: %s", e)
        return {"status": "error", "error": str(e)}


@app.post("/quiet-mode/enable")
def enable_quiet_mode(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Enable quiet mode."""
    try:
        from .quiet_mode_manager import QuietModeManager
        
        manager = QuietModeManager.get_instance()
        level = payload.get("level", "QUIET")
        duration = payload.get("duration")  # Optional: seconds
        reason = payload.get("reason", "user_requested")
        
        manager.enable_quiet_mode(level, duration, reason)
        
        return {
            "status": "ok",
            "result": f"Quiet mode enabled at level {level}"
        }
    except Exception as e:
        log.warning("Error enabling quiet mode: %s", e)
        return {"status": "error", "error": str(e)}


@app.post("/quiet-mode/disable")
def disable_quiet_mode() -> Dict[str, Any]:
    """Disable quiet mode."""
    try:
        from .quiet_mode_manager import QuietModeManager
        
        manager = QuietModeManager.get_instance()
        manager.disable_quiet_mode()
        
        return {"status": "ok", "result": "Quiet mode disabled"}
    except Exception as e:
        log.warning("Error disabling quiet mode: %s", e)
        return {"status": "error", "error": str(e)}


# ----------------------------------------------------------
# Interruption Policy Manager Endpoints (Phase 3)
# ----------------------------------------------------------

@app.post("/interruption/score")
def calculate_interruption_score(context: Dict[str, Any]) -> Dict[str, Any]:
    """Calculate interruption score for a proactive action."""
    try:
        from .interruption_policy_manager import InterruptionPolicyManager
        
        manager = InterruptionPolicyManager.get_instance()
        
        score = manager.calculate_interruption_score(
            action=context.get("action", "unknown"),
            importance=context.get("importance", 0.5),
            confidence=context.get("confidence", 0.5),
            user_activity=context.get("user_activity", {}),
            quiet_mode_active=context.get("quiet_mode", False),
            personality_state=context.get("personality", {})
        )
        
        return {
            "status": "ok",
            "score": {
                "action": score.action,
                "final_score": score.final_score,
                "should_interrupt": score.should_interrupt,
                "reasoning": score.reasoning,
                "activity_penalty": score.user_activity_penalty,
                "quiet_mode_penalty": score.quiet_mode_penalty,
                "cooldown_penalty": score.cooldown_penalty,
                "fatigue_penalty": score.user_fatigue_penalty
            }
        }
    except Exception as e:
        log.warning("Error calculating interruption score: %s", e)
        return {"status": "error", "error": str(e)}


@app.get("/interruption/policy")
def get_interruption_policy() -> Dict[str, Any]:
    """Get current interruption policy."""
    try:
        from .interruption_policy_manager import InterruptionPolicyManager
        
        manager = InterruptionPolicyManager.get_instance()
        policy = manager.get_policy()
        
        return {
            "status": "ok",
            "policy": policy
        }
    except Exception as e:
        log.warning("Error getting interruption policy: %s", e)
        return {"status": "error", "error": str(e)}


@app.get("/interruption/statistics")
def get_interruption_statistics() -> Dict[str, Any]:
    """Get interruption statistics."""
    try:
        from .interruption_policy_manager import InterruptionPolicyManager
        
        manager = InterruptionPolicyManager.get_instance()
        stats = manager.get_interruption_statistics()
        
        return {
            "status": "ok",
            "statistics": stats
        }
    except Exception as e:
        log.warning("Error getting interruption statistics: %s", e)
        return {"status": "error", "error": str(e)}


# ----------------------------------------------------------
# Self-Shutdown Manager Endpoints (Phase 3)
# ----------------------------------------------------------

@app.get("/shutdown/state")
def get_shutdown_state() -> Dict[str, Any]:
    """Get current shutdown state."""
    try:
        from .self_shutdown_manager import SelfShutdownManager
        
        manager = SelfShutdownManager.get_instance()
        state = manager.get_shutdown_state()
        
        if state:
            return {
                "status": "ok",
                "shutdown": {
                    "in_progress": manager.shutdown_in_progress,
                    "saved_conversation": state.saved_conversation,
                    "saved_memory": state.saved_memory,
                    "saved_learning": state.saved_learning,
                    "saved_task_state": state.saved_task_state,
                    "saved_events": state.saved_events,
                    "cleaned_resources": state.cleaned_resources
                }
            }
        return {"status": "ok", "shutdown": None}
    except Exception as e:
        log.warning("Error getting shutdown state: %s", e)
        return {"status": "error", "error": str(e)}


@app.post("/shutdown/initiate")
def initiate_shutdown(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Initiate SARA shutdown (SARA services only, never Windows)."""
    try:
        from .self_shutdown_manager import SelfShutdownManager
        
        manager = SelfShutdownManager.get_instance()
        reason = payload.get("reason", "USER_REQUESTED")
        
        # Start shutdown in background thread to allow response
        import threading
        shutdown_thread = threading.Thread(
            target=manager.initiate_shutdown,
            args=(reason,),
            daemon=True
        )
        shutdown_thread.start()
        
        return {
            "status": "ok",
            "result": f"SARA shutdown initiated with reason: {reason}"
        }
    except Exception as e:
        log.warning("Error initiating shutdown: %s", e)
        return {"status": "error", "error": str(e)}


# ----------------------------------------------------------
# User Feedback Loop Endpoints (Phase 3)
# ----------------------------------------------------------

@app.post("/feedback/record")
def record_user_feedback(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Record user feedback for learning."""
    try:
        from .user_feedback_loop import UserFeedbackLoop, FeedbackType
        
        loop = UserFeedbackLoop.get_instance()
        
        feedback_type_str = payload.get("feedback_type", "ACCEPTED")
        try:
            feedback_type = FeedbackType[feedback_type_str.upper()]
        except KeyError:
            return {"status": "error", "error": f"Unknown feedback type: {feedback_type_str}"}
        
        feedback = loop.record_feedback(
            action_id=payload.get("action_id", "unknown"),
            action_type=payload.get("action_type", "suggestion"),
            feedback_type=feedback_type,
            user_input=payload.get("user_input", ""),
            confidence_before=payload.get("confidence_before", 0.5),
            notes=payload.get("notes", "")
        )
        
        return {
            "status": "ok",
            "result": "Feedback recorded",
            "feedback_id": feedback.feedback_id
        }
    except Exception as e:
        log.warning("Error recording feedback: %s", e)
        return {"status": "error", "error": str(e)}


@app.get("/feedback/history")
def get_feedback_history(limit: int = 50) -> Dict[str, Any]:
    """Get feedback history."""
    try:
        from .user_feedback_loop import UserFeedbackLoop
        
        loop = UserFeedbackLoop.get_instance()
        history = loop.get_feedback_history(limit)
        
        return {
            "status": "ok",
            "feedback": history,
            "count": len(history)
        }
    except Exception as e:
        log.warning("Error retrieving feedback history: %s", e)
        return {"status": "error", "error": str(e)}


@app.get("/feedback/metrics")
def get_feedback_metrics() -> Dict[str, Any]:
    """Get learned metrics for all actions."""
    try:
        from .user_feedback_loop import UserFeedbackLoop
        
        loop = UserFeedbackLoop.get_instance()
        metrics = loop.get_all_metrics()
        
        return {
            "status": "ok",
            "metrics": metrics,
            "count": len(metrics)
        }
    except Exception as e:
        log.warning("Error retrieving feedback metrics: %s", e)
        return {"status": "error", "error": str(e)}


@app.get("/feedback/action-metrics")
def get_action_metrics(action: str) -> Dict[str, Any]:
    """Get metrics for a specific action."""
    try:
        from .user_feedback_loop import UserFeedbackLoop
        
        loop = UserFeedbackLoop.get_instance()
        metrics = loop.get_action_metrics(action)
        
        if metrics:
            return {
                "status": "ok",
                "metrics": metrics
            }
        return {"status": "ok", "metrics": None}
    except Exception as e:
        log.warning("Error retrieving action metrics: %s", e)
        return {"status": "error", "error": str(e)}


# ----------------------------------------------------------
# Interaction Health Check Endpoint (Phase 3)
# ----------------------------------------------------------

@app.get("/interaction/health")
def interaction_health() -> Dict[str, Any]:
    """Check health of autonomous interaction modules."""
    try:
        from .personality_manager import PersonalityManager
        from .quiet_mode_manager import QuietModeManager
        from .interruption_policy_manager import InterruptionPolicyManager
        from .user_feedback_loop import UserFeedbackLoop
        from .self_shutdown_manager import SelfShutdownManager
        
        personality_ok = False
        quiet_mode_ok = False
        interruption_ok = False
        feedback_ok = False
        shutdown_ok = False
        
        try:
            manager = PersonalityManager.get_instance()
            personality_ok = manager.get_current_state() is not None
        except Exception:
            pass
        
        try:
            manager = QuietModeManager.get_instance()
            quiet_mode_ok = manager.get_state() is not None
        except Exception:
            pass
        
        try:
            manager = InterruptionPolicyManager.get_instance()
            quiet_mode_ok = manager.get_policy() is not None
        except Exception:
            pass
        
        try:
            loop = UserFeedbackLoop.get_instance()
            feedback_ok = True  # Always ok if we can get it
        except Exception:
            pass
        
        try:
            manager = SelfShutdownManager.get_instance()
            shutdown_ok = True  # Always ok if we can get it
        except Exception:
            pass
        
        return {
            "status": "ok",
            "interaction_modules": {
                "personality_manager": "HEALTHY" if personality_ok else "STARTING",
                "quiet_mode_manager": "HEALTHY" if quiet_mode_ok else "STARTING",
                "interruption_policy": "HEALTHY" if interruption_ok else "STARTING",
                "user_feedback_loop": "HEALTHY" if feedback_ok else "STARTING",
                "self_shutdown_manager": "HEALTHY" if shutdown_ok else "STARTING"
            },
            "overall": "HEALTHY" if all([personality_ok, quiet_mode_ok, interruption_ok, feedback_ok, shutdown_ok]) else "STARTING"
        }
    except Exception as e:
        log.warning("Error checking interaction health: %s", e)
        return {"status": "error", "error": str(e), "overall": "ERROR"}


# ----------------------------------------------------------
# Orchestrator Endpoints
# ----------------------------------------------------------

def orchestrator_status() -> Dict[str, Any]:
    """Internal helper — returns orchestrator status dict."""
    status = MANAGER.status()
    tasks = list(status.get("tasks", {}).values())
    events = status.get("events", [])
    active_tasks = [task for task in tasks if task.get("status") in {"created", "scheduled", "running"}]
    return {
        "status": "ok",
        "agent_count": len(status.get("agents", {})),
        "active_agents": [agent for agent in status.get("agents", {}).values() if agent.get("status") not in {"stopped", "idle"}],
        "tasks": tasks,
        "active_tasks": active_tasks,
        "events": events[-50:],
        "workflow_count": len([event for event in events if event.get("type") == "workflow_planned"]),
        "checkpoint_count": len([event for event in events if "checkpoint" in str(event.get("payload", {})).lower()]),
    }


@app.get("/orchestrator/status")
def orchestrator_status_endpoint() -> Dict[str, Any]:
    """Return orchestrator status."""
    return orchestrator_status()


# ----------------------------------------------------------
# Vision Engine Endpoints
# ----------------------------------------------------------

@app.post("/vision/enable")
def vision_enable() -> Dict[str, Any]:
    """Start the camera and vision processing loop."""
    VISION_ENGINE.enable()
    return {"result": "Vision engine enabled."}


@app.post("/vision/disable")
def vision_disable() -> Dict[str, Any]:
    """Stop the camera and vision processing loop."""
    VISION_ENGINE.disable()
    return {"result": "Vision engine disabled."}


@app.get("/vision/state")
def vision_state() -> Dict[str, Any]:
    """Return current vision engine status, hand count, gestures, fps, latency."""
    return {"result": VISION_ENGINE.get_state()}


@app.post("/orchestrator/emergency-stop")
def orchestrator_emergency_stop() -> Dict[str, Any]:
    return {"status": "ok", "result": MANAGER.emergency_stop()}


@app.post("/orchestrator/unload-idle")
def orchestrator_unload_idle() -> Dict[str, Any]:
    return {"status": "ok", "result": MANAGER.unload_idle_agents(force=False)}


@app.get("/command-center")
def command_center() -> Dict[str, Any]:
    status = MANAGER.status()
    health = HEALTH.latest() or HEALTH.run(manager_status=status)
    return {
        "status": "ok",
        "health": health,
        "orchestrator": {
            "agent_count": len(status.get("agents", {})),
            "active_agents": [agent for agent in status.get("agents", {}).values() if agent.get("status") not in {"stopped", "idle"}],
            "tasks": list(status.get("tasks", {}).values())[-100:],
            "events": status.get("events", [])[-100:],
        },
        "summary": {
            "browser": health.get("browser"),
            "voice": health.get("voice"),
            "memory": health.get("memory"),
            "rag": health.get("rag"),
            "issues": health.get("issues", 0),
            "warnings": health.get("warnings", 0),
        },
    }


@app.post("/execute", response_model=ExecuteResponse)
def execute(req: ExecuteRequest) -> ExecuteResponse:
    tool = req.tool
    args = req.args or {}
    # If the caller included `original_args`, and the incoming `args` lacks
    # important fields (e.g. phone/contact), prefer values from original_args.
    try:
        if (not args.get('phone') and not args.get('contact')) and req.original_args:
            merged = dict(req.original_args or {})
            merged.update(args)
            args = merged
    except Exception:
        pass
    try:
        log.info("/execute received payload: tool=%s args=%s", tool, _short_args(args))
    except Exception:
        pass
    if not tool and args.get("action"):
        device_id = str(args.get("device_id") or args.get("device") or "")
        token = str(args.get("token") or "")
        try:
            ANDROID_COMPANION_MANAGER.authenticate_device(device_id, token)
        except PermissionError:
            return ExecuteResponse(ok=False, error="Invalid device token", tool="saraAndroidExecute")
        except ValueError as exc:
            return ExecuteResponse(ok=False, error=str(exc), tool="saraAndroidExecute")
        command = ANDROID_COMPANION_MANAGER.enqueue_command(device_id, args)
        return ExecuteResponse(ok=True, result={"result": command}, tool="saraAndroidExecute")
    log.info("EXEC tool=%s args=%s", tool, _short_args(args))

    if tool not in TOOLS:
        known = ", ".join(sorted(TOOLS.keys()))
        operation_id = str(args.get("operation_id") or args.get("operationId") or f"{request_id}:{tool}")
        final = make_tool_result(
            tool=tool or "unknown",
            execution_status="FAILED",
            verification_status="FAILED",
            message=f"Unknown tool '{tool}'. Known tools: {known}",
            details={"error": f"Unknown tool '{tool}'. Known tools: {known}"},
            verification={"status": "FAILED", "reason": "unknown_tool"},
            operation_id=str(args.get("operation_id") or args.get("operationId") or f"{request_id}:{tool}"),
            duration_ms=0,
            changed_state=False,
        )
        final["request_id"] = request_id
        final["operation_id"] = str(args.get("operation_id") or args.get("operationId") or f"{request_id}:{tool}")
        return ExecuteResponse(ok=False, result=final, error=final.get("error"), tool=tool)

    if not TOOL_REGISTRY.is_allowed(tool, args):
        operation_id = str(args.get("operation_id") or args.get("operationId") or f"{request_id}:{tool}")
        final = make_tool_result(
            tool=tool,
            execution_status="FAILED",
            verification_status="FAILED",
            message=f"Permission denied for tool '{tool}'. Explicit confirmation is required.",
            details={"error": f"Permission denied for tool '{tool}'. Explicit confirmation is required."},
            verification={"status": "FAILED", "reason": "permission_denied"},
            operation_id=operation_id,
            duration_ms=0,
            changed_state=False,
        )
        final["request_id"] = request_id
        final["operation_id"] = operation_id
        return ExecuteResponse(ok=False, result=final, error=final.get("error"), tool=tool)

    task_id = args.get("taskId", args.get("task_id", "unknown_task"))
    agent_id = args.get("agent_id", "unknown_agent")
    request_id = str(args.get("request_id") or args.get("requestId") or task_id or "unknown_request")
    operation_id = str(args.get("operation_id") or args.get("operationId") or f"{request_id}:{tool}")

    cached = _RESULT_CACHE.get(operation_id)
    if cached is not None:
        log.info("[ToolResult] duplicate request_id=%s operation_id=%s tool=%s status=%s", request_id, operation_id, tool, cached.get("status"))
        return ExecuteResponse(ok=cached.get("status") == "SUCCESS", result=cached, tool=tool)

    handler = TOOLS[tool]
    started = time.time()
    out: Dict[str, Any] = {}
    try:
        out = handler(args)
    except ToolError as e:
        log.warning("ToolError in %s: %s", tool, e.message)
        out = {"error": e.message, "status": "failed", "executed": False}
    except Exception as e:  # noqa: BLE001
        log.error("Unhandled error in %s: %s\n%s", tool, e, traceback.format_exc())
        out = {"error": f"Internal error in {tool}: {e}", "status": "failed", "executed": False}

    exec_status = "FAILED" if isinstance(out, dict) and out.get("error") else "SUCCESS"
    verification: Dict[str, Any] = {"status": "UNCERTAIN"}
    reward_record: Dict[str, Any] = {"outcome": 0}
    try:
        verification = VERIFICATION_ENGINE.verify_task(task_id, agent_id, tool, out, args=args)
    except Exception as exc:  # noqa: BLE001
        log.error("Verification error for %s: %s", tool, exc)
        verification = {"verification_status": "UNCERTAIN", "status": "UNCERTAIN", "error": str(exc), "method": "verification_failed"}
    try:
        reward_record = REWARD_ENGINE.process_task_result(task_id, agent_id, tool, out)
    except Exception as exc:  # noqa: BLE001
        log.error("Reward persistence error for %s: %s", tool, exc)
        reward_record = {"outcome": 0, "error": str(exc)}

    result_text = str(out.get("result", out)) if isinstance(out, dict) else str(out)
    verify_status = str(verification.get("verification_status") or verification.get("status") or "UNCERTAIN").upper()
    final = make_tool_result(
        tool=tool,
        execution_status=exec_status,
        verification_status=verify_status,
        message=result_text,
        details={"raw_result": out, "reward_outcome": reward_record.get("outcome", 0)},
        verification=verification,
        operation_id=operation_id,
        duration_ms=int((time.time() - started) * 1000),
        changed_state=None,
    )
    final["request_id"] = request_id
    final["operation_id"] = operation_id
    _RESULT_CACHE[operation_id] = dict(final)

    log.info(
        "[EXEC] tool=%s execution=%s verification=%s final=%s duration=%dms",
        tool,
        exec_status,
        verify_status,
        final["status"],
        final["duration_ms"],
    )

    return ExecuteResponse(ok=final["status"] == "SUCCESS", result=final, error=final.get("error"), tool=tool)


@app.post("/companion/pair")
def companion_pair(payload: Dict[str, Any]) -> Dict[str, Any]:
    name = str(payload.get("name") or "Android Device")
    token = str(payload.get("token") or "sara-token")
    return {"ok": True, "result": ANDROID_COMPANION_MANAGER.register_device(name, token)}


@app.post("/companion/auth")
def companion_auth(payload: Dict[str, Any]) -> JSONResponse:
    device_id = str(payload.get("device_id") or payload.get("device") or "")
    token = str(payload.get("token") or "")
    try:
        device = ANDROID_COMPANION_MANAGER.authenticate_device(device_id, token)
    except PermissionError:
        return JSONResponse(status_code=401, content={"ok": False, "error": "Invalid device token"})
    except ValueError as exc:
        return JSONResponse(status_code=404, content={"ok": False, "error": str(exc)})
    return JSONResponse(status_code=200, content={"ok": True, "result": device})


@app.post("/companion/command")
def companion_command(payload: Dict[str, Any]) -> JSONResponse:
    device_id = str(payload.get("device_id") or payload.get("device") or "")
    token = str(payload.get("token") or "")
    try:
        ANDROID_COMPANION_MANAGER.authenticate_device(device_id, token)
    except PermissionError:
        return JSONResponse(status_code=401, content={"ok": False, "error": "Invalid device token"})
    except ValueError as exc:
        return JSONResponse(status_code=404, content={"ok": False, "error": str(exc)})
    command = ANDROID_COMPANION_MANAGER.enqueue_command(device_id, payload)
    return JSONResponse(status_code=200, content={"ok": True, "result": command})


@app.get("/companion/pending/{device_id}")
def companion_pending(device_id: str) -> Dict[str, Any]:
    return {"ok": True, "result": ANDROID_COMPANION_MANAGER.get_pending_commands(device_id)}


@app.post("/companion/result")
def companion_result(payload: Dict[str, Any]) -> Dict[str, Any]:
    device_id = str(payload.get("device_id") or payload.get("device") or "")
    command_id = str(payload.get("command_id") or payload.get("id") or "")
    ANDROID_COMPANION_MANAGER.mark_command_done(device_id, command_id)
    return {"ok": True, "result": {"device_id": device_id, "command_id": command_id}}


def _short_args(args: Dict[str, Any]) -> str:
    """Compact, log-safe representation of args (truncate long values)."""
    parts = []
    for k, v in args.items():
        s = repr(v)
        if len(s) > 60:
            s = s[:60] + "â€¦"
        parts.append(f"{k}={s}")
    return "{" + ", ".join(parts) + "}"


def main() -> None:
    """Allow `python -m desktop_agent.main` to launch uvicorn."""
    import uvicorn

    host = os.environ.get("SARA_AGENT_HOST", "127.0.0.1")
    port = int(os.environ.get("SARA_AGENT_PORT", "8765"))
    log.info("Launching uvicorn on %s:%d", host, port)
    uvicorn.run(
        "desktop_agent.main:app",
        host=host,
        port=port,
        reload=False,
        log_level="info",
    )


if __name__ == "__main__":
    main()


@app.post("/stt/transcribe")
async def stt_transcribe(file: UploadFile = File(...)) -> Dict[str, Any]:
    """Accept an uploaded audio file and return a transcription.

    The endpoint saves the uploaded file to a temporary path, then
    runs the first-available local STT provider (Whisper or Vosk).
    """
    # Save upload to temp file
    suffix = os.path.splitext(file.filename or "")[1] or ".wav"
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    try:
        content = await file.read()
        tmp.write(content)
        tmp.flush()
        tmp.close()
        def run_transcribe(path: str) -> str:
            p = stt_module.detect_provider()
            return p.transcribe_file(path)

        loop = asyncio.get_event_loop()
        try:
            text = await loop.run_in_executor(None, run_transcribe, tmp.name)
        except Exception as e:
            log.exception("STT transcription failed: %s", e)
            return {"ok": False, "error": str(e)}
        return {"ok": True, "result": {"transcript": text}}
    finally:
        try:
            os.unlink(tmp.name)
        except Exception:
            pass


@app.post("/stt/preload")
async def stt_preload(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Request to preload a Whisper model into memory to reduce latency.

    Payload: { "model": "small" }
    """
    model = str(payload.get("model") or os.environ.get("SARA_WHISPER_MODEL", "small"))
    def do_preload(m: str):
        try:
            inst = stt_module.LocalWhisperSTT(model=m)
            inst._ensure_model()
            return True, None
        except Exception as e:
            return False, str(e)

    loop = asyncio.get_event_loop()
    ok, err = await loop.run_in_executor(None, do_preload, model)
    if ok:
        return {"ok": True, "result": {"model": model}}
    return {"ok": False, "error": err}
