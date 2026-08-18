"""
Autonomous Decision Engine for SARA Desktop Agent.

Makes intelligent decisions based on perception data while respecting safety,
privacy, and user authorization constraints.

Priority Hierarchy:
1. Safety (System integrity, user safety)
2. Explicit Command (Direct user request)
3. Privacy (User data protection)
4. Task (Current work objective)
5. Preferences (User settings)
6. Events (Background notifications)
7. Assistance (Proactive help)
8. Conversation (Ongoing dialogue)
9. Personality (Emotional/behavioral style)
"""

import threading
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional, Any, Callable
from datetime import datetime
import sqlite3
from pathlib import Path
import logging

logger = logging.getLogger(__name__)


class DecisionType(Enum):
    """Types of autonomous decisions."""
    TASK_ACTION = "task_action"                    # Advance current task
    PROACTIVE_SUGGESTION = "proactive_suggestion"  # Offer help
    SAFETY_INTERVENTION = "safety_intervention"    # Prevent harm
    PRIVACY_PROTECTION = "privacy_protection"      # Protect user data
    CONVERSATION = "conversation"                  # Engage in dialogue
    SYSTEM_MAINTENANCE = "system_maintenance"      # Background cleanup
    NOTIFICATION = "notification"                  # Notify user
    CLARIFICATION = "clarification"                # Ask for clarification
    NO_ACTION = "no_action"                        # Do nothing


class ConfidenceLevel(Enum):
    """Confidence in a decision."""
    VERY_LOW = 0.2
    LOW = 0.4
    MEDIUM = 0.6
    HIGH = 0.8
    VERY_HIGH = 1.0


class AuthorizationLevel(Enum):
    """User authorization requirements for actions."""
    NONE = 0                    # No auth needed (safe)
    IMPLICIT = 1                # Allowed unless user says no
    EXPLICIT = 2                # Explicit user permission required
    ADMIN = 3                   # System admin permission only


@dataclass
class Decision:
    """A single autonomous decision."""
    decision_type: DecisionType
    action: str                           # What to do (e.g., "run_test", "save_file")
    parameters: Dict[str, Any] = field(default_factory=dict)
    confidence: float = 0.5                # 0.0 to 1.0
    reasoning: str = ""                   # Why this decision
    authorization_required: AuthorizationLevel = AuthorizationLevel.NONE
    priority: int = 5                      # 1-10, higher is more urgent
    timestamp: datetime = field(default_factory=datetime.now)
    
    # Outcomes
    executed: bool = False
    execution_result: Optional[str] = None
    user_approved: Optional[bool] = None


@dataclass
class DecisionContext:
    """Complete context for making a decision."""
    # Perception inputs
    current_desktop_state: Dict[str, Any] = field(default_factory=dict)
    user_activity: Dict[str, Any] = field(default_factory=dict)
    pending_events: List[Dict[str, Any]] = field(default_factory=list)
    
    # Conversation context
    conversation_history: List[Dict[str, str]] = field(default_factory=list)
    current_topic: Optional[str] = None
    user_intent: Optional[str] = None
    
    # Task context
    active_task: Optional[Dict[str, Any]] = None
    previous_actions: List[str] = field(default_factory=list)
    
    # User state
    user_idle_duration: float = 0.0
    user_is_focused: bool = False
    user_is_frustrated: bool = False
    user_quiet_mode: bool = False
    
    # System state
    system_resource_critical: bool = False
    system_errors: List[str] = field(default_factory=list)


class DecisionHistory:
    """Tracks decision history for learning."""
    
    def __init__(self, db_path: str):
        self.db_path = db_path
        self._initialize_db()
    
    def _initialize_db(self):
        """Initialize database schema."""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS autonomous_decisions (
                    decision_id TEXT PRIMARY KEY,
                    timestamp REAL,
                    decision_type TEXT,
                    action TEXT,
                    confidence REAL,
                    authorization_required TEXT,
                    executed INTEGER,
                    user_approved INTEGER,
                    reasoning TEXT,
                    parameters TEXT
                )
            ''')
            
            conn.commit()
            conn.close()
        except Exception as e:
            logger.warning(f"Failed to initialize decision history: {e}")
    
    def record_decision(self, decision: Decision):
        """Record a decision in history."""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            import json
            decision_id = f"dec_{decision.timestamp.timestamp()}_{hash(decision.action) % 10000}"
            
            cursor.execute('''
                INSERT INTO autonomous_decisions
                (decision_id, timestamp, decision_type, action, confidence,
                 authorization_required, executed, user_approved, reasoning, parameters)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''', (
                decision_id,
                decision.timestamp.timestamp(),
                decision.decision_type.value,
                decision.action,
                decision.confidence,
                decision.authorization_required.name,
                int(decision.executed),
                1 if decision.user_approved else (0 if decision.user_approved is not None else -1),
                decision.reasoning,
                json.dumps(decision.parameters)
            ))
            
            conn.commit()
            conn.close()
        except Exception as e:
            logger.warning(f"Failed to record decision: {e}")
    
    def get_decision_history(self, limit: int = 100) -> List[Dict]:
        """Get recent decisions."""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            cursor.execute('''
                SELECT * FROM autonomous_decisions
                ORDER BY timestamp DESC
                LIMIT ?
            ''', (limit,))
            
            columns = [desc[0] for desc in cursor.description]
            rows = cursor.fetchall()
            conn.close()
            
            return [dict(zip(columns, row)) for row in rows]
        except Exception as e:
            logger.warning(f"Failed to retrieve decision history: {e}")
            return []


class AutonomousDecisionEngine:
    """
    Core decision-making system for SARA.
    
    Interprets perception data and generates autonomous decisions following
    strict priority hierarchy and safety constraints.
    """
    
    # Singleton instance
    _instance: Optional['AutonomousDecisionEngine'] = None
    _lock = threading.RLock()
    
    def __init__(self, db_path: Optional[str] = None):
        if db_path is None:
            from .sqlite_memory import data_root
            db_path = str(data_root() / "sara_memory.db")
        
        self.db_path = db_path
        self.history = DecisionHistory(db_path)
        self._pending_decisions: List[Decision] = []
        self._recent_decisions: Dict[str, Decision] = {}  # action -> decision
        self._observers: List[Callable] = []
        self._decision_cooldown: Dict[str, float] = {}  # action -> timestamp
        self._authorization_cache: Dict[str, bool] = {}  # action -> approved
        self._running = False
        self._processing_thread: Optional[threading.Thread] = None
    
    @classmethod
    def get_instance(cls) -> 'AutonomousDecisionEngine':
        """Get or create singleton instance."""
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = AutonomousDecisionEngine()
        return cls._instance
    
    def start(self):
        """Start decision processing."""
        if self._running:
            return
        
        self._running = True
        self._processing_thread = threading.Thread(
            target=self._processing_loop,
            daemon=True
        )
        self._processing_thread.start()
        logger.info("Autonomous Decision Engine started")
    
    def stop(self):
        """Stop decision processing."""
        self._running = False
        if self._processing_thread:
            self._processing_thread.join(timeout=5)
        logger.info("Autonomous Decision Engine stopped")
    
    def _processing_loop(self):
        """Background thread that processes decisions."""
        while self._running:
            try:
                time.sleep(0.1)  # Check every 100ms
            except Exception as e:
                logger.error(f"Error in decision processing loop: {e}")
    
    def make_decision(self, context: DecisionContext) -> Decision:
        """
        Make an autonomous decision based on context.
        
        Applies priority hierarchy:
        1. Safety (system integrity)
        2. Explicit Command (user request)
        3. Privacy (data protection)
        4. Task (current work)
        5. Preferences (user settings)
        6. Events (notifications)
        7. Assistance (proactive help)
        8. Conversation (dialogue)
        9. Personality (style)
        """
        
        with self._lock:
            # Check safety constraints first
            safety_decision = self._check_safety(context)
            if safety_decision:
                return safety_decision
            
            # Check for explicit commands
            explicit_decision = self._check_explicit_command(context)
            if explicit_decision:
                return explicit_decision
            
            # Check privacy concerns
            privacy_decision = self._check_privacy(context)
            if privacy_decision:
                return privacy_decision
            
            # Check if we should advance current task
            task_decision = self._check_task_advancement(context)
            if task_decision:
                return task_decision
            
            # Check for user preferences
            pref_decision = self._check_preferences(context)
            if pref_decision:
                return pref_decision
            
            # Handle background events
            event_decision = self._check_events(context)
            if event_decision:
                return event_decision
            
            # Offer assistance
            assist_decision = self._check_assistance(context)
            if assist_decision:
                return assist_decision
            
            # Continue conversation
            conversation_decision = self._check_conversation(context)
            if conversation_decision:
                return conversation_decision
            
            # Default: no action
            return Decision(
                decision_type=DecisionType.NO_ACTION,
                action="wait",
                reasoning="No decision required at this time"
            )
    
    def _check_safety(self, context: DecisionContext) -> Optional[Decision]:
        """Priority 1: Safety interventions."""
        
        # Detect critical system issues
        if context.system_resource_critical:
            return Decision(
                decision_type=DecisionType.SAFETY_INTERVENTION,
                action="free_resources",
                reasoning="System resources critical, need to free memory/CPU",
                priority=10,
                confidence=0.95
            )
        
        # Check for system errors
        if context.system_errors:
            return Decision(
                decision_type=DecisionType.SAFETY_INTERVENTION,
                action="handle_system_error",
                parameters={"errors": context.system_errors},
                reasoning=f"System errors detected: {context.system_errors[0]}",
                priority=9,
                confidence=0.9
            )
        
        return None
    
    def _check_explicit_command(self, context: DecisionContext) -> Optional[Decision]:
        """Priority 2: Explicit user commands."""
        
        # Check if user just gave a command in conversation
        if context.conversation_history:
            last_message = context.conversation_history[-1]
            if last_message.get("role") == "user":
                command = last_message.get("content", "")
                
                # High confidence in user intent
                return Decision(
                    decision_type=DecisionType.TASK_ACTION,
                    action="execute_user_command",
                    parameters={"command": command},
                    reasoning=f"User explicitly requested: {command[:50]}...",
                    priority=9,
                    confidence=0.95
                )
        
        return None
    
    def _check_privacy(self, context: DecisionContext) -> Optional[Decision]:
        """Priority 3: Privacy protection."""
        
        # Check if sensitive data is visible
        desktop_state = context.current_desktop_state
        if desktop_state.get("visible_dialogs"):
            # Could contain passwords, sensitive data
            return Decision(
                decision_type=DecisionType.PRIVACY_PROTECTION,
                action="wait_for_dialog_close",
                reasoning="Sensitive dialog detected, protecting user privacy",
                priority=8,
                confidence=0.8
            )
        
        # Check if quiet mode is active
        if context.user_quiet_mode:
            return Decision(
                decision_type=DecisionType.PRIVACY_PROTECTION,
                action="enable_quiet_mode",
                reasoning="User has quiet mode enabled",
                priority=7,
                confidence=1.0
            )
        
        return None
    
    def _check_task_advancement(self, context: DecisionContext) -> Optional[Decision]:
        """Priority 4: Advance current task."""
        
        if not context.active_task:
            return None
        
        task = context.active_task
        current_step = task.get("current_step")
        
        # If task is waiting for something specific
        if task.get("waiting_for"):
            waiting_for = task.get("waiting_for")
            
            # Check if the thing we're waiting for is done
            if self._check_if_ready(waiting_for, context):
                return Decision(
                    decision_type=DecisionType.TASK_ACTION,
                    action="advance_task",
                    parameters={"task_id": task.get("id")},
                    reasoning=f"Task waiting for {waiting_for} is now ready",
                    priority=7,
                    confidence=0.85
                )
        
        return None
    
    def _check_preferences(self, context: DecisionContext) -> Optional[Decision]:
        """Priority 5: Apply user preferences."""
        
        # This would integrate with user settings
        # For now, placeholder
        return None
    
    def _check_events(self, context: DecisionContext) -> Optional[Decision]:
        """Priority 6: Handle background events."""
        
        if not context.pending_events:
            return None
        
        # Check if there are important events
        for event in context.pending_events[:1]:  # Take most important
            event_type = event.get("type")
            importance = event.get("importance")
            
            if importance in ["CRITICAL", "HIGH"]:
                return Decision(
                    decision_type=DecisionType.NOTIFICATION,
                    action="notify_event",
                    parameters={"event": event},
                    reasoning=f"{importance} event: {event.get('title')}",
                    priority=6,
                    confidence=0.9
                )
        
        return None
    
    def _check_assistance(self, context: DecisionContext) -> Optional[Decision]:
        """Priority 7: Offer proactive assistance."""
        
        # Only offer help if user is not busy or frustrated
        if context.user_is_frustrated or context.user_idle_duration < 2:
            return None
        
        # Detect patterns that need help
        activity = context.user_activity
        
        # If user seems stuck (high frustration, repeated actions)
        if activity.get("is_frustrated"):
            return Decision(
                decision_type=DecisionType.PROACTIVE_SUGGESTION,
                action="offer_help",
                reasoning="User appears frustrated, offering assistance",
                priority=3,
                confidence=0.6,
                authorization_required=AuthorizationLevel.IMPLICIT
            )
        
        return None
    
    def _check_conversation(self, context: DecisionContext) -> Optional[Decision]:
        """Priority 8: Maintain conversation."""
        
        if not context.conversation_history:
            return None
        
        # If there's an unanswered question from user
        if context.user_intent and not context.current_topic:
            return Decision(
                decision_type=DecisionType.CONVERSATION,
                action="respond_to_intent",
                parameters={"intent": context.user_intent},
                reasoning=f"User intent detected: {context.user_intent}",
                priority=4,
                confidence=0.7,
                authorization_required=AuthorizationLevel.IMPLICIT
            )
        
        return None
    
    def _check_if_ready(self, waiting_for: str, context: DecisionContext) -> bool:
        """Check if something we're waiting for is ready."""
        # Examples: "build_complete", "file_saved", "download_done"
        
        if waiting_for == "build_complete":
            for event in context.pending_events:
                if event.get("type") in ["BUILD_SUCCESS", "BUILD_FAILED"]:
                    return True
        
        if waiting_for == "download_done":
            for event in context.pending_events:
                if event.get("type") == "DOWNLOAD_COMPLETE":
                    return True
        
        return False
    
    def can_execute(self, decision: Decision, context: DecisionContext) -> bool:
        """Check if a decision can be executed safely."""
        
        # Check authorization level
        if decision.authorization_required == AuthorizationLevel.EXPLICIT:
            # Need explicit user approval
            if not decision.user_approved:
                return False
        
        # Check confidence threshold
        if decision.confidence < 0.5:
            return False
        
        # Check cooldown (don't repeat same action too often)
        action_key = decision.action
        if action_key in self._decision_cooldown:
            cooldown_until = self._decision_cooldown[action_key]
            if time.time() < cooldown_until:
                return False
        
        return True
    
    def execute_decision(self, decision: Decision):
        """Execute a decision (mark it as executed)."""
        with self._lock:
            decision.executed = True
            decision.execution_result = f"Decision {decision.action} executed"
            
            # Set cooldown if needed
            if decision.decision_type != DecisionType.CONVERSATION:
                self._decision_cooldown[decision.action] = time.time() + 2  # 2-second cooldown
            
            # Record in history
            self.history.record_decision(decision)
            
            # Notify observers
            for observer in self._observers:
                try:
                    observer(decision)
                except Exception as e:
                    logger.error(f"Error notifying observer: {e}")
    
    def register_observer(self, callback: Callable):
        """Register for decision notifications."""
        with self._lock:
            if callback not in self._observers:
                self._observers.append(callback)
    
    def unregister_observer(self, callback: Callable):
        """Unregister decision observer."""
        with self._lock:
            if callback in self._observers:
                self._observers.remove(callback)
    
    def get_decision_history(self, limit: int = 50) -> List[Dict]:
        """Get recent decision history."""
        return self.history.get_decision_history(limit)
    
    def get_current_decision_state(self) -> Dict[str, Any]:
        """Get current decision state for diagnostics."""
        with self._lock:
            return {
                "running": self._running,
                "pending_decisions": len(self._pending_decisions),
                "recent_actions": list(self._recent_decisions.keys()),
                "observers": len(self._observers),
                "cooldown_actions": list(self._decision_cooldown.keys())
            }


def get_decision_engine() -> AutonomousDecisionEngine:
    """Get the singleton decision engine."""
    return AutonomousDecisionEngine.get_instance()


def start_decision_engine():
    """Start the decision engine."""
    engine = get_decision_engine()
    engine.start()


def stop_decision_engine():
    """Stop the decision engine."""
    engine = get_decision_engine()
    engine.stop()
