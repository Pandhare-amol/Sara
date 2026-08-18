"""
Interruption Policy Manager for SARA Desktop Agent.

Determines when SARA should speak proactively vs when to wait.
Calculates interruption score based on multiple factors.

Core principle: Valuable intervention > Frequent intervention
"""

import threading
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, Optional, Callable, List, Any
from datetime import datetime, timedelta
import logging

logger = logging.getLogger(__name__)


class InterruptionPriority(Enum):
    """Priority levels for proactive messages."""
    CRITICAL = "critical"    # Safety issue, interrupt immediately
    HIGH = "high"             # Important, interrupt if possible
    MEDIUM = "medium"         # Should mention when appropriate
    LOW = "low"              # Nice to have, only if not busy


@dataclass
class InterruptionPolicy:
    """Policy for determining interruption appropriateness."""
    # Minimum importance threshold
    min_importance_when_focused: float = 0.8
    min_importance_when_busy: float = 0.6
    min_importance_when_idle: float = 0.3
    
    # Minimum confidence threshold
    min_confidence: float = 0.5
    
    # Cooldown between suggestions (seconds)
    suggestion_cooldown: float = 30.0
    warning_cooldown: float = 5.0
    
    # Maximum suggestions per session
    max_suggestions_per_hour: int = 10
    max_warnings_per_hour: int = 20
    
    # Activity thresholds
    typing_activity_threshold: int = 50  # keystrokes/min to be "typing"
    mouse_activity_threshold: int = 30   # clicks/min to be "clicking"
    
    # Don't interrupt if user active within X seconds
    active_recency_threshold: float = 5.0
    
    # User preference multipliers
    user_interrupt_frequency: float = 1.0  # 0-2, user preference
    user_warmth_preference: float = 1.0    # 0-2, affects tone


@dataclass
class InterruptionScore:
    """Score for a potential interruption."""
    action: str                           # What action is being considered
    base_importance: float                # 0-1, inherent importance
    base_confidence: float                # 0-1, confidence in recommendation
    user_activity_penalty: float = 0.0    # Reduced score if user active
    quiet_mode_penalty: float = 0.0       # Reduced by quiet mode
    cooldown_penalty: float = 0.0         # Reduced if recent similar message
    user_fatigue_penalty: float = 0.0     # Reduced if many recent interruptions
    personality_bonus: float = 0.0        # Bonus from personality warmth
    
    final_score: float = 0.0              # Computed final score (0-1)
    should_interrupt: bool = False        # Decision: interrupt or wait
    reasoning: str = ""                   # Why this decision was made
    
    def compute_final_score(self, policy: InterruptionPolicy) -> float:
        """Compute final interruption score."""
        # Start with base importance and confidence
        score = (self.base_importance * 0.7 + self.base_confidence * 0.3)
        
        # Apply penalties
        score *= (1.0 - self.user_activity_penalty)
        score *= (1.0 - self.quiet_mode_penalty)
        score *= (1.0 - self.cooldown_penalty)
        score *= (1.0 - self.user_fatigue_penalty)
        
        # Apply bonuses
        score *= (1.0 + self.personality_bonus)
        
        # Apply user preference multiplier
        score *= policy.user_interrupt_frequency
        
        # Clamp to 0-1
        self.final_score = max(0.0, min(1.0, score))
        return self.final_score


class InterruptionHistory:
    """Track recent interruptions for cooldown/fatigue."""
    
    def __init__(self, max_history: int = 100):
        self.max_history = max_history
        self._history: List[Dict[str, Any]] = []
        self._lock = threading.RLock()
    
    def record_interruption(self, action: str, importance: float):
        """Record an interruption."""
        with self._lock:
            self._history.append({
                "action": action,
                "importance": importance,
                "timestamp": datetime.now()
            })
            
            # Keep only recent history
            if len(self._history) > self.max_history:
                self._history = self._history[-self.max_history:]
    
    def get_recent_count(self, action_type: str, seconds: int = 60) -> int:
        """Get count of similar interruptions in recent time."""
        with self._lock:
            cutoff = datetime.now() - timedelta(seconds=seconds)
            return len([
                h for h in self._history
                if action_type in h.get("action", "") and h["timestamp"] > cutoff
            ])
    
    def get_total_count(self, seconds: int = 3600) -> int:
        """Get total interruption count in time window."""
        with self._lock:
            cutoff = datetime.now() - timedelta(seconds=seconds)
            return len([h for h in self._history if h["timestamp"] > cutoff])
    
    def get_last_interruption(self, action_type: str) -> Optional[datetime]:
        """Get timestamp of last similar interruption."""
        with self._lock:
            matching = [h for h in self._history if action_type in h.get("action", "")]
            if matching:
                return matching[-1]["timestamp"]
        return None


class InterruptionPolicyManager:
    """
    Manages interruption policy and calculates interruption appropriateness.
    
    Decides when SARA should speak proactively vs when to wait.
    """
    
    # Singleton instance
    _instance: Optional['InterruptionPolicyManager'] = None
    _lock = threading.RLock()
    
    def __init__(self):
        self.policy = InterruptionPolicy()
        self.history = InterruptionHistory()
        self._observers: List[Callable] = []
    
    @classmethod
    def get_instance(cls) -> 'InterruptionPolicyManager':
        """Get or create singleton instance."""
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = InterruptionPolicyManager()
        return cls._instance
    
    def calculate_interruption_score(
        self,
        action: str,
        importance: float,
        confidence: float,
        user_activity: Dict[str, Any],
        quiet_mode_active: bool = False,
        personality_state: Optional[Dict[str, Any]] = None
    ) -> InterruptionScore:
        """
        Calculate whether an interruption is appropriate.
        
        Args:
            action: What SARA wants to do (e.g., "suggest_build", "warn_deletion")
            importance: 0-1 importance of this action
            confidence: 0-1 confidence in the recommendation
            user_activity: User activity metrics (idle_seconds, typing, clicking, focused)
            quiet_mode_active: Whether quiet mode is enabled
            personality_state: Current personality/emotional state
        
        Returns: InterruptionScore with decision and reasoning
        """
        score = InterruptionScore(
            action=action,
            base_importance=importance,
            base_confidence=confidence
        )
        
        # Check minimum confidence
        if confidence < self.policy.min_confidence:
            score.should_interrupt = False
            score.reasoning = f"Low confidence ({confidence:.2f}) below threshold ({self.policy.min_confidence})"
            return score
        
        # Calculate activity penalty
        activity_level = user_activity.get("activity_level", "IDLE")
        idle_seconds = user_activity.get("idle_seconds", 0)
        is_typing = user_activity.get("is_typing", False)
        is_clicking = user_activity.get("is_clicking", False)
        is_focused = user_activity.get("is_focused", False)
        
        if activity_level == "HIGH" or (idle_seconds < self.policy.active_recency_threshold):
            # User is very active right now
            score.user_activity_penalty = 0.4
            min_importance = self.policy.min_importance_when_focused
        elif activity_level == "MEDIUM" or is_typing or is_clicking:
            # User is somewhat active
            score.user_activity_penalty = 0.25
            min_importance = self.policy.min_importance_when_busy
        else:
            # User is idle
            score.user_activity_penalty = 0.0
            min_importance = self.policy.min_importance_when_idle
        
        # Apply quiet mode penalty
        if quiet_mode_active:
            score.quiet_mode_penalty = 1.0  # Don't interrupt in quiet mode
        
        # Apply cooldown penalty
        last_interruption = self.history.get_last_interruption(action)
        if last_interruption:
            elapsed = (datetime.now() - last_interruption).total_seconds()
            if elapsed < self.policy.suggestion_cooldown:
                # Recent similar interruption, reduce score
                penalty = (self.policy.suggestion_cooldown - elapsed) / self.policy.suggestion_cooldown
                score.cooldown_penalty = penalty * 0.5
        
        # Apply user fatigue penalty
        recent_interruptions = self.history.get_total_count(seconds=3600)
        if recent_interruptions > self.policy.max_suggestions_per_hour:
            # Too many interruptions already
            over_limit = recent_interruptions - self.policy.max_suggestions_per_hour
            score.user_fatigue_penalty = min(0.8, over_limit * 0.05)
        
        # Apply personality bonus
        if personality_state:
            warmth = personality_state.get("warmth", 0.5)
            score.personality_bonus = (warmth - 0.5) * 0.1  # -0.05 to +0.05
        
        # Compute final score
        final_score = score.compute_final_score(self.policy)
        
        # Make decision
        if final_score >= min_importance:
            score.should_interrupt = True
            score.reasoning = f"Score {final_score:.2f} >= threshold {min_importance:.2f}"
        else:
            score.should_interrupt = False
            score.reasoning = f"Score {final_score:.2f} below threshold {min_importance:.2f} (activity={activity_level}, quiet={quiet_mode_active})"
        
        return score
    
    def should_interrupt(self, score: InterruptionScore) -> bool:
        """Determine if interruption should happen."""
        return score.should_interrupt
    
    def record_interruption(self, action: str, importance: float):
        """Record that an interruption occurred."""
        self.history.record_interruption(action, importance)
        
        # Notify observers
        for observer in self._observers:
            try:
                observer("interruption_recorded", {"action": action, "importance": importance})
            except Exception as e:
                logger.error(f"Error notifying observer: {e}")
    
    def get_interruption_pressure(self) -> float:
        """
        Calculate how much SARA wants to speak right now.
        
        0.0 = completely silent, 1.0 = constantly chatting
        """
        recent_count = self.history.get_total_count(seconds=3600)
        return min(1.0, recent_count / self.policy.max_suggestions_per_hour)
    
    def update_user_preference(self, interrupt_frequency: float, warmth: float):
        """Allow user to adjust interruption preferences."""
        self.policy.user_interrupt_frequency = max(0.0, min(2.0, interrupt_frequency))
        self.policy.user_warmth_preference = max(0.0, min(2.0, warmth))
        logger.info(f"Updated interruption policy: frequency={interrupt_frequency}, warmth={warmth}")
    
    def get_policy(self) -> Dict[str, Any]:
        """Get current interruption policy."""
        return {
            "min_importance_focused": self.policy.min_importance_when_focused,
            "min_importance_busy": self.policy.min_importance_when_busy,
            "min_importance_idle": self.policy.min_importance_when_idle,
            "min_confidence": self.policy.min_confidence,
            "suggestion_cooldown": self.policy.suggestion_cooldown,
            "max_suggestions_per_hour": self.policy.max_suggestions_per_hour,
            "user_interrupt_frequency": self.policy.user_interrupt_frequency
        }
    
    def register_observer(self, callback: Callable):
        """Register for interruption notifications."""
        with self._lock:
            if callback not in self._observers:
                self._observers.append(callback)
    
    def unregister_observer(self, callback: Callable):
        """Unregister interruption observer."""
        with self._lock:
            if callback in self._observers:
                self._observers.remove(callback)
    
    def get_interruption_statistics(self) -> Dict[str, Any]:
        """Get interruption statistics."""
        return {
            "total_last_hour": self.history.get_total_count(3600),
            "interruption_pressure": self.get_interruption_pressure(),
            "policy": self.get_policy()
        }


def get_interruption_manager() -> InterruptionPolicyManager:
    """Get the singleton interruption policy manager."""
    return InterruptionPolicyManager.get_instance()
