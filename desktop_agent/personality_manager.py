"""
Personality & Emotional State Manager for SARA Desktop Agent.

Manages SARA's internal emotional and personality state to make interactions
feel natural and consistent. This is a behavioral state system (not claiming
real consciousness), used to control conversational style and decision-making.

CRITICAL: Emotional state MUST NEVER override safety, privacy, or authorization.
"""

import threading
import sqlite3
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional, Callable, Any
from datetime import datetime, timedelta
import logging
import json

logger = logging.getLogger(__name__)


class EmotionalState(Enum):
    """Simulated emotional/behavioral states for SARA."""
    CALM = "calm"              # Neutral, collected
    HAPPY = "happy"            # Task completion, user success
    CONCERNED = "concerned"    # Potential problems, warnings
    CURIOUS = "curious"        # New information, questions
    FRUSTRATED = "frustrated"  # Task failure, repeated issues
    DISAPPOINTED = "disappointed"  # User rejection, failed attempts
    EXCITED = "excited"        # Important discovery, success
    TIRED = "tired"            # Long operations, fatigue simulation
    FOCUSED = "focused"        # Active task, concentration
    CONFUSED = "confused"      # Ambiguous input, unclear situation


class PersonalityTrait(Enum):
    """Personality dimensions that affect conversational style."""
    FORMALITY = "formality"        # 0=casual, 1=formal
    WARMTH = "warmth"              # 0=cold, 1=warm
    HUMOR = "humor"                # 0=none, 1=humorous
    CONFIDENCE = "confidence"      # 0=hesitant, 1=confident
    CURIOSITY = "curiosity"        # 0=passive, 1=curious
    CONCERN = "concern"            # 0=indifferent, 1=concerned
    VERBOSITY = "verbosity"        # 0=terse, 1=verbose
    FORMALITY_LEVEL = "formality_level"  # "sir/ma'am", "user", "first_name"


@dataclass
class PersonalityProfile:
    """User's personality preferences for SARA."""
    name: str = "SARA"
    address_style: str = "sir"              # "sir", "ma'am", "user", or name
    preferred_tone: str = "professional"    # "casual", "professional", "formal"
    humor_preference: float = 0.5           # 0-1, how much humor
    warmth_preference: float = 0.6          # 0-1, how warm to be
    verbosity_preference: float = 0.4       # 0-1, how verbose
    curiosity_preference: float = 0.5       # 0-1, ask questions
    concern_expression: float = 0.7         # 0-1, express concern about issues
    interrupt_frequency: float = 0.3        # 0-1, how often to proactively speak
    created_at: datetime = field(default_factory=datetime.now)
    updated_at: datetime = field(default_factory=datetime.now)
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "address_style": self.address_style,
            "preferred_tone": self.preferred_tone,
            "humor_preference": self.humor_preference,
            "warmth_preference": self.warmth_preference,
            "verbosity_preference": self.verbosity_preference,
            "curiosity_preference": self.curiosity_preference,
            "concern_expression": self.concern_expression,
            "interrupt_frequency": self.interrupt_frequency,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat()
        }
    
    @classmethod
    def from_dict(cls, data: Dict) -> 'PersonalityProfile':
        return cls(
            name=data.get("name", "SARA"),
            address_style=data.get("address_style", "sir"),
            preferred_tone=data.get("preferred_tone", "professional"),
            humor_preference=data.get("humor_preference", 0.5),
            warmth_preference=data.get("warmth_preference", 0.6),
            verbosity_preference=data.get("verbosity_preference", 0.4),
            curiosity_preference=data.get("curiosity_preference", 0.5),
            concern_expression=data.get("concern_expression", 0.7),
            interrupt_frequency=data.get("interrupt_frequency", 0.3),
            created_at=datetime.fromisoformat(data.get("created_at", datetime.now().isoformat())),
            updated_at=datetime.fromisoformat(data.get("updated_at", datetime.now().isoformat()))
        )


@dataclass
class EmotionalStateInstance:
    """Current emotional state snapshot."""
    state: EmotionalState
    confidence: float                    # 0-1, how certain we are
    trigger: str                         # What caused this state
    timestamp: datetime = field(default_factory=datetime.now)
    previous_state: Optional[EmotionalState] = None
    
    def is_strong(self) -> bool:
        """Check if this state is strong enough to affect behavior."""
        return self.confidence > 0.6
    
    def is_recent(self, seconds: int = 60) -> bool:
        """Check if this state is recent."""
        elapsed = (datetime.now() - self.timestamp).total_seconds()
        return elapsed < seconds


class PersonalityHistory:
    """Persistent storage for personality and emotional state."""
    
    def __init__(self, db_path: str):
        self.db_path = db_path
        self._initialize_db()
    
    def _initialize_db(self):
        """Initialize database schema."""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS personality_profile (
                    profile_id TEXT PRIMARY KEY,
                    name TEXT,
                    address_style TEXT,
                    preferred_tone TEXT,
                    humor_preference REAL,
                    warmth_preference REAL,
                    verbosity_preference REAL,
                    curiosity_preference REAL,
                    concern_expression REAL,
                    interrupt_frequency REAL,
                    created_at REAL,
                    updated_at REAL
                )
            ''')
            
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS emotional_state_history (
                    state_id TEXT PRIMARY KEY,
                    state TEXT,
                    confidence REAL,
                    trigger TEXT,
                    timestamp REAL,
                    previous_state TEXT
                )
            ''')
            
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS state_transitions (
                    transition_id TEXT PRIMARY KEY,
                    from_state TEXT,
                    to_state TEXT,
                    trigger TEXT,
                    timestamp REAL,
                    confidence REAL
                )
            ''')
            
            conn.commit()
            conn.close()
        except Exception as e:
            logger.warning(f"Failed to initialize personality history: {e}")
    
    def save_profile(self, profile: PersonalityProfile):
        """Save personality profile to database."""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            cursor.execute('''
                INSERT OR REPLACE INTO personality_profile
                (profile_id, name, address_style, preferred_tone, humor_preference,
                 warmth_preference, verbosity_preference, curiosity_preference,
                 concern_expression, interrupt_frequency, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''', (
                "default_profile",
                profile.name,
                profile.address_style,
                profile.preferred_tone,
                profile.humor_preference,
                profile.warmth_preference,
                profile.verbosity_preference,
                profile.curiosity_preference,
                profile.concern_expression,
                profile.interrupt_frequency,
                profile.created_at.timestamp(),
                profile.updated_at.timestamp()
            ))
            
            conn.commit()
            conn.close()
        except Exception as e:
            logger.warning(f"Failed to save personality profile: {e}")
    
    def load_profile(self) -> Optional[PersonalityProfile]:
        """Load personality profile from database."""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            cursor.execute('SELECT * FROM personality_profile WHERE profile_id = ?', ("default_profile",))
            row = cursor.fetchone()
            conn.close()
            
            if row:
                return PersonalityProfile(
                    name=row[1],
                    address_style=row[2],
                    preferred_tone=row[3],
                    humor_preference=row[4],
                    warmth_preference=row[5],
                    verbosity_preference=row[6],
                    curiosity_preference=row[7],
                    concern_expression=row[8],
                    interrupt_frequency=row[9],
                    created_at=datetime.fromtimestamp(row[10]),
                    updated_at=datetime.fromtimestamp(row[11])
                )
        except Exception as e:
            logger.warning(f"Failed to load personality profile: {e}")
        
        return None
    
    def save_emotional_state(self, state_instance: EmotionalStateInstance):
        """Save emotional state to history."""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            state_id = f"state_{state_instance.timestamp.timestamp()}_{state_instance.state.value}"
            
            cursor.execute('''
                INSERT INTO emotional_state_history
                (state_id, state, confidence, trigger, timestamp, previous_state)
                VALUES (?, ?, ?, ?, ?, ?)
            ''', (
                state_id,
                state_instance.state.value,
                state_instance.confidence,
                state_instance.trigger,
                state_instance.timestamp.timestamp(),
                state_instance.previous_state.value if state_instance.previous_state else None
            ))
            
            conn.commit()
            conn.close()
        except Exception as e:
            logger.warning(f"Failed to save emotional state: {e}")
    
    def get_emotional_history(self, limit: int = 50) -> List[Dict]:
        """Get emotional state history."""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            cursor.execute('''
                SELECT * FROM emotional_state_history
                ORDER BY timestamp DESC
                LIMIT ?
            ''', (limit,))
            
            columns = [desc[0] for desc in cursor.description]
            rows = cursor.fetchall()
            conn.close()
            
            return [dict(zip(columns, row)) for row in rows]
        except Exception as e:
            logger.warning(f"Failed to retrieve emotional history: {e}")
            return []


class PersonalityManager:
    """
    Manages SARA's personality and emotional state.
    
    This is a behavioral state system used to:
    - Control conversational tone
    - Make interactions feel natural
    - Express concern/excitement appropriately
    - Maintain consistent behavior across sessions
    
    CRITICAL: Emotional state MUST NEVER override safety, privacy, or authorization.
    """
    
    # Singleton instance
    _instance: Optional['PersonalityManager'] = None
    _lock = threading.RLock()
    
    def __init__(self, db_path: Optional[str] = None):
        if db_path is None:
            from .sqlite_memory import data_root
            db_path = str(data_root() / "sara_memory.db")
        
        self.db_path = db_path
        self.history = PersonalityHistory(db_path)
        
        # Load or create personality profile
        self.profile = self.history.load_profile() or PersonalityProfile()
        
        # Current emotional state
        self._current_state = EmotionalStateInstance(
            state=EmotionalState.CALM,
            confidence=1.0,
            trigger="initialization"
        )
        
        # State transition rules
        self._transition_rules: Dict[str, Dict] = {}
        self._observers: List[Callable] = []
        
        self._initialize_transitions()
    
    @classmethod
    def get_instance(cls) -> 'PersonalityManager':
        """Get or create singleton instance."""
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = PersonalityManager()
        return cls._instance
    
    def _initialize_transitions(self):
        """Define how emotional states transition."""
        # Simplified state machine
        self._transition_rules = {
            "task_complete": {
                "default": EmotionalState.HAPPY,
                "confidence": 0.8
            },
            "task_failed": {
                "default": EmotionalState.FRUSTRATED,
                "confidence": 0.8
            },
            "user_request": {
                "default": EmotionalState.FOCUSED,
                "confidence": 0.7
            },
            "problem_detected": {
                "default": EmotionalState.CONCERNED,
                "confidence": 0.7
            },
            "new_discovery": {
                "default": EmotionalState.EXCITED,
                "confidence": 0.6
            },
            "ambiguous_input": {
                "default": EmotionalState.CONFUSED,
                "confidence": 0.6
            },
            "repeated_failure": {
                "default": EmotionalState.FRUSTRATED,
                "confidence": 0.9
            },
            "user_rejection": {
                "default": EmotionalState.DISAPPOINTED,
                "confidence": 0.7
            },
            "long_operation": {
                "default": EmotionalState.TIRED,
                "confidence": 0.5
            }
        }
    
    def update_state(self, trigger: str, new_state: Optional[EmotionalState] = None):
        """Update emotional state based on trigger."""
        with self._lock:
            # Determine new state
            if new_state is None:
                rule = self._transition_rules.get(trigger, {})
                new_state = rule.get("default", EmotionalState.CALM)
                confidence = rule.get("confidence", 0.5)
            else:
                confidence = 0.7
            
            # Create state instance
            old_state = self._current_state.state
            self._current_state = EmotionalStateInstance(
                state=new_state,
                confidence=confidence,
                trigger=trigger,
                previous_state=old_state
            )
            
            # Persist to history
            self.history.save_emotional_state(self._current_state)
            
            # Notify observers
            for observer in self._observers:
                try:
                    observer("state_changed", self._current_state)
                except Exception as e:
                    logger.error(f"Error notifying observer: {e}")
            
            logger.info(f"Emotional state changed to {new_state.value} (confidence: {confidence:.2f})")
    
    def get_current_state(self) -> EmotionalStateInstance:
        """Get current emotional state."""
        with self._lock:
            return self._current_state
    
    def get_conversation_style(self) -> Dict[str, Any]:
        """Get conversational style based on personality and emotional state."""
        with self._lock:
            state = self._current_state
            profile = self.profile
            
            # Adjust style based on emotional state
            warmth_mod = 0.0
            if state.state == EmotionalState.HAPPY:
                warmth_mod = 0.2
            elif state.state == EmotionalState.FRUSTRATED:
                warmth_mod = -0.1
            elif state.state == EmotionalState.CONCERNED:
                warmth_mod = 0.15
            elif state.state == EmotionalState.EXCITED:
                warmth_mod = 0.25
            
            return {
                "address_style": profile.address_style,
                "tone": profile.preferred_tone,
                "warmth": min(1.0, max(0.0, profile.warmth_preference + warmth_mod)),
                "humor": profile.humor_preference if state.is_strong() else 0.0,
                "confidence": profile.humor_preference,
                "curiosity": profile.curiosity_preference,
                "concern": profile.concern_expression if state.state in [
                    EmotionalState.CONCERNED,
                    EmotionalState.FRUSTRATED
                ] else profile.concern_expression * 0.5,
                "verbosity": profile.verbosity_preference,
                "emotional_state": state.state.value,
                "state_strength": state.confidence
            }
    
    def get_response_prefix(self) -> str:
        """Get appropriate response prefix based on emotional state and personality."""
        with self._lock:
            profile = self.profile
            state = self._current_state
            
            # Build prefix
            address = {
                "sir": "Sir, ",
                "ma'am": "Ma'am, ",
                "user": "",
                "formal": f"{profile.name}, "
            }.get(profile.address_style, "Sir, ")
            
            # Add emotional expression based on state
            emotion_prefix = {
                EmotionalState.HAPPY: "Nice, sir. ",
                EmotionalState.CONCERNED: "Heads up—",
                EmotionalState.FRUSTRATED: "I'm having trouble with this one. ",
                EmotionalState.EXCITED: "Interesting! ",
                EmotionalState.CONFUSED: "I'm not entirely sure, but ",
                EmotionalState.DISAPPOINTED: "That didn't go as planned. ",
                EmotionalState.TIRED: "After that long run, ",
                EmotionalState.FOCUSED: "On it—"
            }.get(state.state, "")
            
            return address + emotion_prefix if state.is_strong() and emotion_prefix else address
    
    def set_personality_preference(self, trait: str, value: float):
        """Allow user to adjust personality preferences."""
        with self._lock:
            if hasattr(self.profile, trait):
                # Clamp to 0-1
                value = max(0.0, min(1.0, value))
                setattr(self.profile, trait, value)
                self.profile.updated_at = datetime.now()
                self.history.save_profile(self.profile)
                logger.info(f"Updated personality trait {trait} to {value}")
    
    def get_personality_profile(self) -> Dict[str, Any]:
        """Get current personality profile."""
        return self.profile.to_dict()
    
    def register_observer(self, callback: Callable):
        """Register for state change notifications."""
        with self._lock:
            if callback not in self._observers:
                self._observers.append(callback)
    
    def unregister_observer(self, callback: Callable):
        """Unregister state observer."""
        with self._lock:
            if callback in self._observers:
                self._observers.remove(callback)
    
    def get_emotional_history(self, limit: int = 50) -> List[Dict]:
        """Get emotional state history."""
        return self.history.get_emotional_history(limit)


def get_personality_manager() -> PersonalityManager:
    """Get the singleton personality manager."""
    return PersonalityManager.get_instance()
