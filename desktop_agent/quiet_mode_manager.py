"""
Quiet Mode Manager for SARA Desktop Agent.

Manages SARA's quiet mode to respect user requests for silence and minimal
interruptions. Safety-critical alerts are never suppressed.
"""

import threading
import sqlite3
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, Optional, Callable, List, Any
from datetime import datetime, timedelta
import logging

logger = logging.getLogger(__name__)


class QuietModeLevel(Enum):
    """Different levels of quiet mode."""
    NORMAL = "normal"              # Full autonomous behavior
    QUIET = "quiet"                # No proactive suggestions or interruptions
    SILENT = "silent"              # No suggestions, minimal responses
    CRITICAL_ONLY = "critical_only"  # Only safety alerts, no other messages


@dataclass
class QuietModeState:
    """Current quiet mode state."""
    level: QuietModeLevel
    enabled_at: datetime = field(default_factory=datetime.now)
    duration: Optional[float] = None       # seconds, None = indefinite
    reason: Optional[str] = None           # Why user requested quiet mode
    auto_resume_at: Optional[datetime] = None
    
    def is_active(self) -> bool:
        """Check if quiet mode is currently active."""
        if self.level == QuietModeLevel.NORMAL:
            return False
        
        if self.auto_resume_at:
            return datetime.now() < self.auto_resume_at
        
        return True
    
    def time_remaining(self) -> Optional[float]:
        """Get seconds remaining in quiet mode."""
        if not self.auto_resume_at:
            return None
        
        remaining = (self.auto_resume_at - datetime.now()).total_seconds()
        return max(0.0, remaining)


class QuietModeHistory:
    """Persistent storage for quiet mode state."""
    
    def __init__(self, db_path: str):
        self.db_path = db_path
        self._initialize_db()
    
    def _initialize_db(self):
        """Initialize database schema."""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS quiet_mode_state (
                    state_id TEXT PRIMARY KEY,
                    level TEXT,
                    enabled_at REAL,
                    duration REAL,
                    reason TEXT,
                    auto_resume_at REAL
                )
            ''')
            
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS quiet_mode_history (
                    history_id TEXT PRIMARY KEY,
                    level TEXT,
                    enabled_at REAL,
                    disabled_at REAL,
                    duration_seconds REAL,
                    reason TEXT
                )
            ''')
            
            conn.commit()
            conn.close()
        except Exception as e:
            logger.warning(f"Failed to initialize quiet mode history: {e}")
    
    def save_state(self, state: QuietModeState):
        """Save current quiet mode state."""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            cursor.execute('''
                INSERT OR REPLACE INTO quiet_mode_state
                (state_id, level, enabled_at, duration, reason, auto_resume_at)
                VALUES (?, ?, ?, ?, ?, ?)
            ''', (
                "current_quiet_mode",
                state.level.value,
                state.enabled_at.timestamp(),
                state.duration,
                state.reason,
                state.auto_resume_at.timestamp() if state.auto_resume_at else None
            ))
            
            conn.commit()
            conn.close()
        except Exception as e:
            logger.warning(f"Failed to save quiet mode state: {e}")
    
    def load_state(self) -> Optional[QuietModeState]:
        """Load current quiet mode state from database."""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            cursor.execute('''
                SELECT level, enabled_at, duration, reason, auto_resume_at
                FROM quiet_mode_state
                WHERE state_id = ?
            ''', ("current_quiet_mode",))
            
            row = cursor.fetchone()
            conn.close()
            
            if row:
                level, enabled_at, duration, reason, auto_resume_at = row
                return QuietModeState(
                    level=QuietModeLevel(level),
                    enabled_at=datetime.fromtimestamp(enabled_at),
                    duration=duration,
                    reason=reason,
                    auto_resume_at=datetime.fromtimestamp(auto_resume_at) if auto_resume_at else None
                )
        except Exception as e:
            logger.warning(f"Failed to load quiet mode state: {e}")
        
        return None
    
    def record_quiet_session(self, enabled_at: datetime, disabled_at: datetime, reason: str):
        """Record a quiet mode session in history."""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            duration = (disabled_at - enabled_at).total_seconds()
            history_id = f"quiet_{enabled_at.timestamp()}_{disabled_at.timestamp()}"
            
            cursor.execute('''
                INSERT INTO quiet_mode_history
                (history_id, level, enabled_at, disabled_at, duration_seconds, reason)
                VALUES (?, ?, ?, ?, ?, ?)
            ''', (
                history_id,
                QuietModeLevel.QUIET.value,
                enabled_at.timestamp(),
                disabled_at.timestamp(),
                duration,
                reason
            ))
            
            conn.commit()
            conn.close()
        except Exception as e:
            logger.warning(f"Failed to record quiet mode session: {e}")
    
    def get_quiet_history(self, limit: int = 50) -> List[Dict]:
        """Get quiet mode history."""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            cursor.execute('''
                SELECT * FROM quiet_mode_history
                ORDER BY enabled_at DESC
                LIMIT ?
            ''', (limit,))
            
            columns = [desc[0] for desc in cursor.description]
            rows = cursor.fetchall()
            conn.close()
            
            return [dict(zip(columns, row)) for row in rows]
        except Exception as e:
            logger.warning(f"Failed to retrieve quiet mode history: {e}")
            return []


class QuietModeManager:
    """
    Manages SARA's quiet mode.
    
    Allows user to request silence while preserving:
    - Safety-critical alerts
    - Task execution where already authorized
    - Background perception where required
    - Logging and learning
    - Critical error detection
    """
    
    # Singleton instance
    _instance: Optional['QuietModeManager'] = None
    _lock = threading.RLock()
    
    def __init__(self, db_path: Optional[str] = None):
        if db_path is None:
            from .sqlite_memory import data_root
            db_path = str(data_root() / "sara_memory.db")
        
        self.db_path = db_path
        self.history = QuietModeHistory(db_path)
        
        # Load or create default state
        self._state = self.history.load_state() or QuietModeState(
            level=QuietModeLevel.NORMAL
        )
        
        self._observers: List[Callable] = []
    
    @classmethod
    def get_instance(cls) -> 'QuietModeManager':
        """Get or create singleton instance."""
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = QuietModeManager()
        return cls._instance
    
    def enable_quiet_mode(
        self,
        level: QuietModeLevel = QuietModeLevel.QUIET,
        duration_seconds: Optional[float] = None,
        reason: Optional[str] = None
    ):
        """Enable quiet mode."""
        with self._lock:
            # Convert string to enum if needed
            if isinstance(level, str):
                level_str = level.upper()
                if level_str == "NORMAL":
                    level = QuietModeLevel.NORMAL
                elif level_str == "QUIET":
                    level = QuietModeLevel.QUIET
                elif level_str == "SILENT":
                    level = QuietModeLevel.SILENT
                elif level_str == "CRITICAL_ONLY":
                    level = QuietModeLevel.CRITICAL_ONLY
                else:
                    logger.warning(f"Invalid quiet mode level: {level}, using QUIET")
                    level = QuietModeLevel.QUIET
            
            # Calculate auto-resume time
            auto_resume_at = None
            if duration_seconds:
                auto_resume_at = datetime.now() + timedelta(seconds=duration_seconds)
            
            # Create new state
            self._state = QuietModeState(
                level=level,
                enabled_at=datetime.now(),
                duration=duration_seconds,
                reason=reason or "User requested quiet mode",
                auto_resume_at=auto_resume_at
            )
            
            # Persist
            self.history.save_state(self._state)
            
            # Notify observers
            for observer in self._observers:
                try:
                    observer("quiet_mode_enabled", self._state)
                except Exception as e:
                    logger.error(f"Error notifying observer: {e}")
            
            logger.info(f"Quiet mode enabled: {level.value} (reason: {self._state.reason})")
    
    def disable_quiet_mode(self):
        """Disable quiet mode and return to normal."""
        with self._lock:
            if self._state.level != QuietModeLevel.NORMAL:
                # Record session
                self.history.record_quiet_session(
                    self._state.enabled_at,
                    datetime.now(),
                    self._state.reason or "Unknown"
                )
                
                # Reset to normal
                self._state = QuietModeState(level=QuietModeLevel.NORMAL)
                self.history.save_state(self._state)
                
                # Notify observers
                for observer in self._observers:
                    try:
                        observer("quiet_mode_disabled", self._state)
                    except Exception as e:
                        logger.error(f"Error notifying observer: {e}")
                
                logger.info("Quiet mode disabled, returning to normal")
    
    def get_state(self) -> QuietModeState:
        """Get current quiet mode state."""
        with self._lock:
            # Check if auto-resume time has passed
            if self._state.auto_resume_at and datetime.now() >= self._state.auto_resume_at:
                self.disable_quiet_mode()
            
            return self._state
    
    def is_quiet(self) -> bool:
        """Check if quiet mode is active."""
        state = self.get_state()
        return state.is_active()
    
    def should_speak_proactively(self) -> bool:
        """Determine if SARA should speak proactively."""
        state = self.get_state()
        
        if state.level == QuietModeLevel.NORMAL:
            return True
        
        if state.level in [QuietModeLevel.QUIET, QuietModeLevel.SILENT]:
            return False
        
        if state.level == QuietModeLevel.CRITICAL_ONLY:
            return False
        
        return True
    
    def should_show_suggestion(self) -> bool:
        """Determine if SARA should show suggestions."""
        state = self.get_state()
        return state.level == QuietModeLevel.NORMAL
    
    def should_ask_question(self) -> bool:
        """Determine if SARA should ask clarifying questions."""
        state = self.get_state()
        return state.level == QuietModeLevel.NORMAL
    
    def should_respond_minimally(self) -> bool:
        """Check if responses should be minimal."""
        state = self.get_state()
        return state.level in [QuietModeLevel.SILENT, QuietModeLevel.CRITICAL_ONLY]
    
    def can_speak_for_safety(self) -> bool:
        """Check if SARA can speak about safety-critical issues."""
        # Always allow safety-critical alerts
        return True
    
    def can_speak_for_task(self) -> bool:
        """Check if SARA can speak about task execution."""
        state = self.get_state()
        
        if state.level == QuietModeLevel.NORMAL:
            return True
        
        if state.level == QuietModeLevel.QUIET:
            return True  # Continue task execution
        
        return state.level != QuietModeLevel.SILENT
    
    def check_and_resume(self):
        """Automatically resume from quiet mode if duration expired."""
        with self._lock:
            if self._state.auto_resume_at and datetime.now() >= self._state.auto_resume_at:
                self.disable_quiet_mode()
    
    def register_observer(self, callback: Callable):
        """Register for quiet mode change notifications."""
        with self._lock:
            if callback not in self._observers:
                self._observers.append(callback)
    
    def unregister_observer(self, callback: Callable):
        """Unregister quiet mode observer."""
        with self._lock:
            if callback in self._observers:
                self._observers.remove(callback)
    
    def get_quiet_history(self, limit: int = 50) -> List[Dict]:
        """Get quiet mode history."""
        return self.history.get_quiet_history(limit)
    
    def get_state_dict(self) -> Dict[str, Any]:
        """Get current state as dict."""
        state = self.get_state()
        return {
            "level": state.level.value,
            "is_active": state.is_active(),
            "enabled_at": state.enabled_at.isoformat(),
            "duration": state.duration,
            "reason": state.reason,
            "time_remaining": state.time_remaining(),
            "auto_resume_at": state.auto_resume_at.isoformat() if state.auto_resume_at else None
        }


def get_quiet_mode_manager() -> QuietModeManager:
    """Get the singleton quiet mode manager."""
    return QuietModeManager.get_instance()
