"""
User Feedback Loop System for SARA Desktop Agent.

Learns from user responses to suggestions, questions, and proactive actions.
Updates confidence and learns user preferences over time.
"""

import threading
import sqlite3
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, Optional, Callable, List, Any, Tuple
from datetime import datetime, timedelta
import logging
import json

logger = logging.getLogger(__name__)


class FeedbackType(Enum):
    """Types of feedback SARA receives."""
    ACCEPTED = "accepted"              # User accepted suggestion
    REJECTED = "rejected"              # User rejected suggestion
    PARTIAL = "partial"                # Partially followed suggestion
    IGNORED = "ignored"                # User ignored suggestion
    CORRECTED = "corrected"            # User corrected SARA's action
    ASKED_AGAIN = "asked_again"        # User asked for clarification
    DONT_ASK_AGAIN = "dont_ask_again"  # User said "don't ask this"
    ENABLED_QUIET = "enabled_quiet"    # User requested quiet mode
    DISABLED_QUIET = "disabled_quiet"  # User re-enabled normal mode
    SHUTDOWN_REQUEST = "shutdown_request"  # User asked SARA to shut down
    SUCCESS = "success"                # Action succeeded as predicted
    FAILURE = "failure"                # Action failed despite prediction


@dataclass
class UserFeedback:
    """Single piece of user feedback."""
    feedback_id: str
    action_id: str                      # Original action/suggestion ID
    action_type: str                    # Type of action (suggestion, question, etc)
    feedback_type: FeedbackType
    user_input: str                     # What user said/did
    timestamp: datetime = field(default_factory=datetime.now)
    confidence_before: float = 0.5      # SARA's confidence before feedback
    confidence_change: float = 0.0      # How much confidence changed
    notes: str = ""
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "feedback_id": self.feedback_id,
            "action_id": self.action_id,
            "action_type": self.action_type,
            "feedback_type": self.feedback_type.value,
            "user_input": self.user_input,
            "timestamp": self.timestamp.isoformat(),
            "confidence_before": self.confidence_before,
            "confidence_change": self.confidence_change,
            "notes": self.notes
        }


@dataclass
class ActionMetrics:
    """Metrics for a learned action/suggestion."""
    action_name: str
    action_type: str                    # "suggestion", "question", "warning"
    
    times_offered: int = 0              # How many times SARA offered this
    times_accepted: int = 0             # How many times user accepted
    times_rejected: int = 0             # How many times user rejected
    times_succeeded: int = 0            # How many times it succeeded
    times_failed: int = 0               # How many times it failed
    
    last_offered: Optional[datetime] = None
    last_accepted: Optional[datetime] = None
    
    current_confidence: float = 0.5     # Learned confidence score
    user_explicitly_disabled: bool = False  # User said "never ask this"
    
    @property
    def acceptance_rate(self) -> float:
        """Calculate acceptance rate."""
        if self.times_offered == 0:
            return 0.0
        return self.times_accepted / self.times_offered
    
    @property
    def success_rate(self) -> float:
        """Calculate success rate when accepted."""
        if self.times_accepted == 0:
            return 0.0
        return self.times_succeeded / self.times_accepted
    
    def update_confidence(self):
        """Recalculate confidence based on feedback."""
        if self.user_explicitly_disabled:
            self.current_confidence = 0.0
            return
        
        # Base confidence on success rate and acceptance rate
        if self.times_offered == 0:
            self.current_confidence = 0.5
        else:
            acceptance_factor = self.acceptance_rate * 0.6
            success_factor = self.success_rate * 0.4
            self.current_confidence = acceptance_factor + success_factor
        
        # Clamp to 0-1
        self.current_confidence = max(0.0, min(1.0, self.current_confidence))
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "action_name": self.action_name,
            "action_type": self.action_type,
            "times_offered": self.times_offered,
            "times_accepted": self.times_accepted,
            "times_rejected": self.times_rejected,
            "times_succeeded": self.times_succeeded,
            "times_failed": self.times_failed,
            "last_offered": self.last_offered.isoformat() if self.last_offered else None,
            "last_accepted": self.last_accepted.isoformat() if self.last_accepted else None,
            "current_confidence": self.current_confidence,
            "acceptance_rate": self.acceptance_rate,
            "success_rate": self.success_rate,
            "user_explicitly_disabled": self.user_explicitly_disabled
        }


class FeedbackHistory:
    """Persistent storage for feedback and metrics."""
    
    def __init__(self, db_path: str):
        self.db_path = db_path
        self._initialize_db()
    
    def _initialize_db(self):
        """Initialize database schema."""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS user_feedback (
                    feedback_id TEXT PRIMARY KEY,
                    action_id TEXT,
                    action_type TEXT,
                    feedback_type TEXT,
                    user_input TEXT,
                    timestamp REAL,
                    confidence_before REAL,
                    confidence_change REAL,
                    notes TEXT
                )
            ''')
            
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS action_metrics (
                    action_name TEXT PRIMARY KEY,
                    action_type TEXT,
                    times_offered INTEGER,
                    times_accepted INTEGER,
                    times_rejected INTEGER,
                    times_succeeded INTEGER,
                    times_failed INTEGER,
                    last_offered REAL,
                    last_accepted REAL,
                    current_confidence REAL,
                    user_explicitly_disabled INTEGER
                )
            ''')
            
            conn.commit()
            conn.close()
        except Exception as e:
            logger.warning(f"Failed to initialize feedback history: {e}")
    
    def save_feedback(self, feedback: UserFeedback):
        """Save user feedback to database."""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            cursor.execute('''
                INSERT INTO user_feedback
                (feedback_id, action_id, action_type, feedback_type, user_input,
                 timestamp, confidence_before, confidence_change, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''', (
                feedback.feedback_id,
                feedback.action_id,
                feedback.action_type,
                feedback.feedback_type.value,
                feedback.user_input,
                feedback.timestamp.timestamp(),
                feedback.confidence_before,
                feedback.confidence_change,
                feedback.notes
            ))
            
            conn.commit()
            conn.close()
        except Exception as e:
            logger.warning(f"Failed to save feedback: {e}")
    
    def save_metrics(self, metrics: ActionMetrics):
        """Save action metrics to database."""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            cursor.execute('''
                INSERT OR REPLACE INTO action_metrics
                (action_name, action_type, times_offered, times_accepted, times_rejected,
                 times_succeeded, times_failed, last_offered, last_accepted, 
                 current_confidence, user_explicitly_disabled)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''', (
                metrics.action_name,
                metrics.action_type,
                metrics.times_offered,
                metrics.times_accepted,
                metrics.times_rejected,
                metrics.times_succeeded,
                metrics.times_failed,
                metrics.last_offered.timestamp() if metrics.last_offered else None,
                metrics.last_accepted.timestamp() if metrics.last_accepted else None,
                metrics.current_confidence,
                int(metrics.user_explicitly_disabled)
            ))
            
            conn.commit()
            conn.close()
        except Exception as e:
            logger.warning(f"Failed to save metrics: {e}")
    
    def load_metrics(self, action_name: str) -> Optional[ActionMetrics]:
        """Load metrics for a specific action."""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            cursor.execute('SELECT * FROM action_metrics WHERE action_name = ?', (action_name,))
            row = cursor.fetchone()
            conn.close()
            
            if row:
                metrics = ActionMetrics(
                    action_name=row[0],
                    action_type=row[1],
                    times_offered=row[2],
                    times_accepted=row[3],
                    times_rejected=row[4],
                    times_succeeded=row[5],
                    times_failed=row[6],
                    last_offered=datetime.fromtimestamp(row[7]) if row[7] else None,
                    last_accepted=datetime.fromtimestamp(row[8]) if row[8] else None,
                    current_confidence=row[9],
                    user_explicitly_disabled=bool(row[10])
                )
                return metrics
        except Exception as e:
            logger.warning(f"Failed to load metrics: {e}")
        
        return None
    
    def get_feedback_history(self, limit: int = 100) -> List[Dict]:
        """Get recent feedback history."""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            cursor.execute('''
                SELECT * FROM user_feedback
                ORDER BY timestamp DESC
                LIMIT ?
            ''', (limit,))
            
            columns = [desc[0] for desc in cursor.description]
            rows = cursor.fetchall()
            conn.close()
            
            return [dict(zip(columns, row)) for row in rows]
        except Exception as e:
            logger.warning(f"Failed to retrieve feedback history: {e}")
            return []
    
    def get_all_metrics(self) -> List[Dict]:
        """Get all action metrics."""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            cursor.execute('SELECT * FROM action_metrics ORDER BY current_confidence DESC')
            
            columns = [desc[0] for desc in cursor.description]
            rows = cursor.fetchall()
            conn.close()
            
            return [dict(zip(columns, row)) for row in rows]
        except Exception as e:
            logger.warning(f"Failed to retrieve metrics: {e}")
            return []


class UserFeedbackLoop:
    """
    Learns from user responses to improve future decisions.
    
    Responsibilities:
    - Record user feedback
    - Update confidence scores
    - Track learning metrics
    - Identify patterns
    - Inform decision confidence
    """
    
    # Singleton instance
    _instance: Optional['UserFeedbackLoop'] = None
    _lock = threading.RLock()
    
    def __init__(self, db_path: Optional[str] = None):
        if db_path is None:
            from .sqlite_memory import data_root
            db_path = str(data_root() / "sara_memory.db")
        
        self.db_path = db_path
        self.history = FeedbackHistory(db_path)
        
        # In-memory metrics cache
        self._metrics_cache: Dict[str, ActionMetrics] = {}
        self._observers: List[Callable] = []
    
    @classmethod
    def get_instance(cls) -> 'UserFeedbackLoop':
        """Get or create singleton instance."""
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = UserFeedbackLoop()
        return cls._instance
    
    def record_feedback(
        self,
        action_id: str,
        action_type: str,
        feedback_type: FeedbackType,
        user_input: str,
        confidence_before: float = 0.5,
        notes: str = ""
    ) -> UserFeedback:
        """Record user feedback for an action."""
        with self._lock:
            feedback = UserFeedback(
                feedback_id=f"fb_{action_id}_{datetime.now().timestamp()}",
                action_id=action_id,
                action_type=action_type,
                feedback_type=feedback_type,
                user_input=user_input,
                confidence_before=confidence_before,
                notes=notes
            )
            
            # Save to history
            self.history.save_feedback(feedback)
            
            # Update metrics
            self._update_metrics(action_type, feedback_type, confidence_before)
            
            # Notify observers
            for observer in self._observers:
                try:
                    observer("feedback_recorded", feedback)
                except Exception as e:
                    logger.error(f"Error notifying observer: {e}")
            
            logger.info(f"Feedback recorded: {action_type} - {feedback_type.value}")
            
            return feedback
    
    def _update_metrics(self, action_type: str, feedback_type: FeedbackType, confidence_before: float):
        """Update metrics based on feedback."""
        # Load or create metrics
        metrics = self._metrics_cache.get(action_type)
        if metrics is None:
            metrics = self.history.load_metrics(action_type) or ActionMetrics(
                action_name=action_type,
                action_type="suggestion"
            )
        
        # Update based on feedback type
        metrics.times_offered += 1
        metrics.last_offered = datetime.now()
        
        if feedback_type == FeedbackType.ACCEPTED:
            metrics.times_accepted += 1
            metrics.last_accepted = datetime.now()
        elif feedback_type == FeedbackType.REJECTED:
            metrics.times_rejected += 1
        elif feedback_type == FeedbackType.SUCCESS:
            metrics.times_succeeded += 1
        elif feedback_type == FeedbackType.FAILURE:
            metrics.times_failed += 1
        elif feedback_type == FeedbackType.DONT_ASK_AGAIN:
            metrics.user_explicitly_disabled = True
        
        # Recalculate confidence
        metrics.update_confidence()
        
        # Save metrics
        self._metrics_cache[action_type] = metrics
        self.history.save_metrics(metrics)
    
    def get_action_confidence(self, action_type: str) -> float:
        """Get current confidence for an action type."""
        with self._lock:
            metrics = self._metrics_cache.get(action_type)
            if metrics is None:
                metrics = self.history.load_metrics(action_type)
            
            if metrics:
                return metrics.current_confidence
            
            return 0.5  # Default confidence
    
    def should_ask_action_again(self, action_type: str) -> bool:
        """Check if user explicitly disabled this action."""
        with self._lock:
            metrics = self._metrics_cache.get(action_type)
            if metrics is None:
                metrics = self.history.load_metrics(action_type)
            
            if metrics:
                return not metrics.user_explicitly_disabled
            
            return True  # Ask by default
    
    def get_action_metrics(self, action_type: str) -> Optional[Dict[str, Any]]:
        """Get metrics for an action."""
        metrics = self._metrics_cache.get(action_type)
        if metrics is None:
            metrics = self.history.load_metrics(action_type)
        
        if metrics:
            return metrics.to_dict()
        
        return None
    
    def get_all_metrics(self) -> List[Dict[str, Any]]:
        """Get metrics for all tracked actions."""
        all_metrics = []
        
        # Get from cache
        for metrics in self._metrics_cache.values():
            all_metrics.append(metrics.to_dict())
        
        # Get from database (in case cache is incomplete)
        db_metrics = self.history.get_all_metrics()
        for db_metric in db_metrics:
            # Check if already in list
            if not any(m["action_name"] == db_metric["action_name"] for m in all_metrics):
                all_metrics.append(db_metric)
        
        return sorted(all_metrics, key=lambda m: m.get("current_confidence", 0), reverse=True)
    
    def get_feedback_history(self, limit: int = 100) -> List[Dict]:
        """Get feedback history."""
        return self.history.get_feedback_history(limit)
    
    def register_observer(self, callback: Callable):
        """Register for feedback notifications."""
        with self._lock:
            if callback not in self._observers:
                self._observers.append(callback)
    
    def unregister_observer(self, callback: Callable):
        """Unregister feedback observer."""
        with self._lock:
            if callback in self._observers:
                self._observers.remove(callback)


def get_feedback_loop() -> UserFeedbackLoop:
    """Get the singleton user feedback loop."""
    return UserFeedbackLoop.get_instance()
