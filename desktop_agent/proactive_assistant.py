"""
Proactive Assistant for SARA Desktop Agent.

Generates useful suggestions based on observations while respecting user
activity state and privacy preferences.
"""

import threading
import sqlite3
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional, Callable, Any
from datetime import datetime
import logging

logger = logging.getLogger(__name__)


class SuggestionType(Enum):
    """Types of proactive suggestions."""
    WORKFLOW_OPTIMIZATION = "workflow_optimization"  # Automate repeated actions
    ERROR_RECOVERY = "error_recovery"                # Help recover from errors
    PERFORMANCE = "performance"                      # Performance improvement
    LEARNING = "learning"                            # Teach new features
    SAFETY = "safety"                                # Safety/security suggestion
    MAINTENANCE = "maintenance"                      # System maintenance
    CONVENIENCE = "convenience"                      # Convenience improvement


@dataclass
class Suggestion:
    """A proactive suggestion for the user."""
    suggestion_id: str
    suggestion_type: SuggestionType
    title: str                         # Short title
    description: str                   # Full description
    action: str                        # What SARA would do
    parameters: Dict[str, Any] = field(default_factory=dict)
    confidence: float = 0.5            # 0.0 to 1.0
    importance: str = "MEDIUM"         # LOW, MEDIUM, HIGH, CRITICAL
    created_at: datetime = field(default_factory=datetime.now)
    
    # Interaction state
    presented: bool = False
    presented_at: Optional[datetime] = None
    accepted: Optional[bool] = None
    accepted_at: Optional[datetime] = None
    dismissed: bool = False


class SuggestionAnalyzer:
    """Analyzes observations to generate suggestions."""
    
    @classmethod
    def analyze_user_activity(
        cls,
        activity: Dict[str, Any],
        desktop_state: Dict[str, Any],
        events: List[Dict[str, Any]]
    ) -> List[Suggestion]:
        """
        Analyze user activity and generate suggestions.
        
        Returns list of suggestions based on observations.
        """
        suggestions = []
        
        # Check for repeated actions (workflow pattern)
        if activity.get("is_frustrated"):
            suggestions.append(Suggestion(
                suggestion_id=f"sug_frustration_{datetime.now().timestamp()}",
                suggestion_type=SuggestionType.ERROR_RECOVERY,
                title="Let me help with that",
                description="I notice you've been working on this for a while. Would you like me to help?",
                action="offer_assistance",
                confidence=0.7,
                importance="HIGH"
            ))
        
        # Check for build/test completion
        for event in events:
            if event.get("type") == "BUILD_SUCCESS":
                suggestions.append(Suggestion(
                    suggestion_id=f"sug_build_complete_{datetime.now().timestamp()}",
                    suggestion_type=SuggestionType.WORKFLOW_OPTIMIZATION,
                    title="Build completed successfully",
                    description="Your build finished successfully. Ready to run tests?",
                    action="offer_next_step",
                    parameters={"next_action": "run_tests"},
                    confidence=0.9,
                    importance="MEDIUM"
                ))
            
            if event.get("type") == "TEST_FAILED":
                suggestions.append(Suggestion(
                    suggestion_id=f"sug_test_failed_{datetime.now().timestamp()}",
                    suggestion_type=SuggestionType.ERROR_RECOVERY,
                    title="Test failed - need investigation",
                    description="A test failed. Let me show you the error details?",
                    action="show_test_results",
                    confidence=0.85,
                    importance="HIGH"
                ))
        
        # Check for idle periods
        idle_seconds = activity.get("idle_seconds", 0)
        if idle_seconds > 300:  # 5+ minutes
            suggestions.append(Suggestion(
                suggestion_id=f"sug_idle_{datetime.now().timestamp()}",
                suggestion_type=SuggestionType.CONVENIENCE,
                title="You've been idle for a while",
                description="Would you like me to auto-save your work and lock the screen?",
                action="offer_idle_actions",
                confidence=0.6,
                importance="LOW"
            ))
        
        return suggestions
    
    @classmethod
    def analyze_workflow_patterns(
        cls,
        recent_actions: List[str]
    ) -> List[Suggestion]:
        """Analyze workflow patterns to suggest automation."""
        suggestions = []
        
        # Check for repeated sequences
        if len(recent_actions) >= 3:
            # Look for pattern: build -> test -> commit
            if ("build" in recent_actions and 
                "test" in recent_actions and 
                "commit" in recent_actions):
                suggestions.append(Suggestion(
                    suggestion_id=f"sug_workflow_auto_{datetime.now().timestamp()}",
                    suggestion_type=SuggestionType.WORKFLOW_OPTIMIZATION,
                    title="Automate build-test-commit",
                    description="I've noticed you always build, test, then commit. Can I automate this?",
                    action="create_workflow_automation",
                    parameters={"workflow": "build_test_commit"},
                    confidence=0.75,
                    importance="MEDIUM"
                ))
        
        return suggestions


class SuggestionFilter:
    """Filters suggestions based on user context."""
    
    @classmethod
    def should_present_suggestion(
        cls,
        suggestion: Suggestion,
        user_activity: Dict[str, Any],
        user_quiet_mode: bool
    ) -> bool:
        """Determine if suggestion should be presented to user."""
        
        # Respect quiet mode
        if user_quiet_mode and suggestion.importance == "LOW":
            return False
        
        # Don't interrupt user if active
        activity_level = user_activity.get("activity_level", "IDLE")
        if activity_level == "HIGH" and suggestion.importance == "LOW":
            return False
        
        # Check if user is focused on something
        is_focused = user_activity.get("is_focused", False)
        if is_focused and suggestion.importance not in ["HIGH", "CRITICAL"]:
            return False
        
        # Don't suggest if user just dismissed similar suggestion
        # (would check against recent_dismissals)
        
        return True
    
    @classmethod
    def rank_suggestions(cls, suggestions: List[Suggestion]) -> List[Suggestion]:
        """Rank suggestions by priority."""
        importance_order = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3}
        
        def sort_key(sug):
            imp_score = importance_order.get(sug.importance, 4)
            conf_score = (1 - sug.confidence) * 10  # Lower confidence = higher score = lower rank
            return (imp_score, conf_score)
        
        return sorted(suggestions, key=sort_key)


class SuggestionHistory:
    """Persistent storage for suggestions."""
    
    def __init__(self, db_path: str):
        self.db_path = db_path
        self._initialize_db()
    
    def _initialize_db(self):
        """Initialize database schema."""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS suggestions (
                    suggestion_id TEXT PRIMARY KEY,
                    suggestion_type TEXT,
                    title TEXT,
                    description TEXT,
                    action TEXT,
                    confidence REAL,
                    importance TEXT,
                    created_at REAL,
                    presented INTEGER,
                    presented_at REAL,
                    accepted INTEGER,
                    accepted_at REAL,
                    dismissed INTEGER,
                    parameters TEXT
                )
            ''')
            
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS suggestion_feedback (
                    feedback_id TEXT PRIMARY KEY,
                    suggestion_id TEXT,
                    user_rating INTEGER,
                    useful_rating TEXT,
                    timestamp REAL,
                    notes TEXT,
                    FOREIGN KEY (suggestion_id) REFERENCES suggestions(suggestion_id)
                )
            ''')
            
            conn.commit()
            conn.close()
        except Exception as e:
            logger.warning(f"Failed to initialize suggestion history: {e}")
    
    def save_suggestion(self, suggestion: Suggestion):
        """Save suggestion to database."""
        try:
            import json
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            cursor.execute('''
                INSERT OR REPLACE INTO suggestions
                (suggestion_id, suggestion_type, title, description, action,
                 confidence, importance, created_at, presented, presented_at,
                 accepted, accepted_at, dismissed, parameters)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''', (
                suggestion.suggestion_id,
                suggestion.suggestion_type.value,
                suggestion.title,
                suggestion.description,
                suggestion.action,
                suggestion.confidence,
                suggestion.importance,
                suggestion.created_at.timestamp(),
                int(suggestion.presented),
                suggestion.presented_at.timestamp() if suggestion.presented_at else None,
                1 if suggestion.accepted else (0 if suggestion.accepted is not None else None),
                suggestion.accepted_at.timestamp() if suggestion.accepted_at else None,
                int(suggestion.dismissed),
                json.dumps(suggestion.parameters)
            ))
            
            conn.commit()
            conn.close()
        except Exception as e:
            logger.warning(f"Failed to save suggestion: {e}")
    
    def get_suggestion_history(self, limit: int = 50) -> List[Dict]:
        """Get recent suggestions."""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            cursor.execute('''
                SELECT * FROM suggestions
                ORDER BY created_at DESC
                LIMIT ?
            ''', (limit,))
            
            columns = [desc[0] for desc in cursor.description]
            rows = cursor.fetchall()
            conn.close()
            
            return [dict(zip(columns, row)) for row in rows]
        except Exception as e:
            logger.warning(f"Failed to retrieve suggestion history: {e}")
            return []


class ProactiveAssistant:
    """
    Proactive suggestion system for SARA.
    
    Responsibilities:
    - Analyze observations for suggestion opportunities
    - Filter suggestions based on user context
    - Rank suggestions by priority
    - Track suggestion acceptance/rejection
    - Learn from user feedback
    """
    
    # Singleton instance
    _instance: Optional['ProactiveAssistant'] = None
    _lock = threading.RLock()
    
    def __init__(self, db_path: Optional[str] = None):
        if db_path is None:
            from .sqlite_memory import data_root
            db_path = str(data_root() / "sara_memory.db")
        
        self.db_path = db_path
        self.history = SuggestionHistory(db_path)
        self._pending_suggestions: List[Suggestion] = []
        self._observers: List[Callable] = []
        self._analyzer = SuggestionAnalyzer()
        self._filter = SuggestionFilter()
    
    @classmethod
    def get_instance(cls) -> 'ProactiveAssistant':
        """Get or create singleton instance."""
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = ProactiveAssistant()
        return cls._instance
    
    def generate_suggestions(
        self,
        user_activity: Dict[str, Any],
        desktop_state: Dict[str, Any],
        events: List[Dict[str, Any]],
        recent_actions: List[str]
    ) -> List[Suggestion]:
        """
        Generate suggestions based on current observations.
        
        Returns ranked list of suggestions.
        """
        with self._lock:
            suggestions = []
            
            # Analyze activity for suggestions
            activity_suggestions = self._analyzer.analyze_user_activity(
                user_activity, desktop_state, events
            )
            suggestions.extend(activity_suggestions)
            
            # Analyze workflow patterns
            workflow_suggestions = self._analyzer.analyze_workflow_patterns(
                recent_actions
            )
            suggestions.extend(workflow_suggestions)
            
            # Deduplicate suggestions
            unique_suggestions = {}
            for sug in suggestions:
                key = (sug.suggestion_type, sug.action)
                if key not in unique_suggestions:
                    unique_suggestions[key] = sug
            
            suggestions = list(unique_suggestions.values())
            
            # Rank suggestions
            ranked = self._filter.rank_suggestions(suggestions)
            
            # Filter based on user context
            presentable = [
                sug for sug in ranked
                if self._filter.should_present_suggestion(
                    sug, user_activity, 
                    desktop_state.get("quiet_mode", False)
                )
            ]
            
            # Keep pending suggestions
            self._pending_suggestions = presentable[:5]  # Max 5 pending
            
            # Save to history
            for sug in self._pending_suggestions:
                self.history.save_suggestion(sug)
            
            return self._pending_suggestions
    
    def get_pending_suggestions(self) -> List[Suggestion]:
        """Get suggestions waiting to be presented."""
        with self._lock:
            return self._pending_suggestions.copy()
    
    def present_suggestion(self, suggestion_id: str) -> Optional[Suggestion]:
        """Mark suggestion as presented to user."""
        with self._lock:
            for sug in self._pending_suggestions:
                if sug.suggestion_id == suggestion_id:
                    sug.presented = True
                    sug.presented_at = datetime.now()
                    self.history.save_suggestion(sug)
                    
                    # Notify observers
                    for observer in self._observers:
                        try:
                            observer("suggestion_presented", sug)
                        except Exception as e:
                            logger.error(f"Error notifying observer: {e}")
                    
                    return sug
        
        return None
    
    def accept_suggestion(self, suggestion_id: str) -> Optional[Suggestion]:
        """User accepted a suggestion."""
        with self._lock:
            for sug in self._pending_suggestions:
                if sug.suggestion_id == suggestion_id:
                    sug.accepted = True
                    sug.accepted_at = datetime.now()
                    self.history.save_suggestion(sug)
                    
                    # Notify observers
                    for observer in self._observers:
                        try:
                            observer("suggestion_accepted", sug)
                        except Exception as e:
                            logger.error(f"Error notifying observer: {e}")
                    
                    # Remove from pending
                    self._pending_suggestions.remove(sug)
                    
                    return sug
        
        return None
    
    def reject_suggestion(self, suggestion_id: str) -> Optional[Suggestion]:
        """User rejected a suggestion."""
        with self._lock:
            for sug in self._pending_suggestions:
                if sug.suggestion_id == suggestion_id:
                    sug.accepted = False
                    sug.dismissed = True
                    self.history.save_suggestion(sug)
                    
                    # Notify observers
                    for observer in self._observers:
                        try:
                            observer("suggestion_rejected", sug)
                        except Exception as e:
                            logger.error(f"Error notifying observer: {e}")
                    
                    # Remove from pending
                    self._pending_suggestions.remove(sug)
                    
                    return sug
        
        return None
    
    def get_suggestion_history(self, limit: int = 50) -> List[Dict]:
        """Get historical suggestions."""
        return self.history.get_suggestion_history(limit)
    
    def register_observer(self, callback: Callable):
        """Register for suggestion events."""
        with self._lock:
            if callback not in self._observers:
                self._observers.append(callback)
    
    def unregister_observer(self, callback: Callable):
        """Unregister suggestion observer."""
        with self._lock:
            if callback in self._observers:
                self._observers.remove(callback)


def get_proactive_assistant() -> ProactiveAssistant:
    """Get the singleton proactive assistant."""
    return ProactiveAssistant.get_instance()
