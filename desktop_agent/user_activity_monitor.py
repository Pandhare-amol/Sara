"""
User Activity Monitor

Tracks real keyboard and mouse activity to understand user engagement.
Used for detecting idle periods, frustration patterns, and interaction levels.

Provides real-world activity signals for autonomous decision-making.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field
from collections import deque
from enum import Enum
from typing import Optional, List, Dict, Any
import sqlite3

from .sqlite_memory import data_root

logger = logging.getLogger(__name__)


class ActivityLevel(Enum):
    """User activity level"""
    IDLE = "idle"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


@dataclass
class ActivitySnapshot:
    """Single activity observation"""
    timestamp: float
    keyboard_events: int = 0
    mouse_events: int = 0
    mouse_distance: float = 0.0  # pixels moved
    keyboard_active: bool = False
    mouse_active: bool = False


@dataclass
class ActivityMetrics:
    """Aggregate activity metrics"""
    timestamp: float
    keyboard_activity_level: ActivityLevel = ActivityLevel.IDLE
    mouse_activity_level: ActivityLevel = ActivityLevel.IDLE
    combined_activity_level: ActivityLevel = ActivityLevel.IDLE
    idle_duration_seconds: float = 0.0
    keyboard_count_5m: int = 0
    mouse_count_5m: int = 0
    is_user_idle: bool = False
    has_user_paused: bool = False
    appears_frustrated: bool = False
    appears_focused: bool = False
    recent_error_attempts: int = 0
    activity_trend: List[ActivityLevel] = field(default_factory=list)


class UserActivityMonitor:
    """
    Monitors real user activity via keyboard and mouse input.
    
    Provides:
    - Activity level detection (idle/low/medium/high)
    - Idle duration tracking
    - Interaction pattern analysis
    - Frustration detection (rapid failed attempts)
    - Focus detection (sustained activity)
    """
    
    def __init__(self):
        self.lock = threading.RLock()
        
        # Activity tracking
        self._snapshots: deque = deque(maxlen=3600)  # 1 hour at 1/sec
        self._current_metrics: Optional[ActivityMetrics] = None
        
        # Keyboard tracking
        self._keyboard_events_5m: deque = deque(maxlen=300)  # 5 minutes
        self._last_keyboard_time = time.time()
        self._keyboard_down_times: Dict[str, float] = {}
        
        # Mouse tracking
        self._mouse_events_5m: deque = deque(maxlen=300)
        self._last_mouse_time = time.time()
        self._last_mouse_pos = (0, 0)
        self._mouse_distance_5m: deque = deque(maxlen=300)  # pixels
        
        # Monitoring state
        self._monitor_thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        
        # Frustration detection
        self._recent_errors: deque = deque(maxlen=20)
        self._rapid_clicks: deque = deque(maxlen=10)
        
        # Database
        self._db_path = data_root() / "sara_memory.db"
        self._ensure_schema()
        
        # Try to install input listeners
        self._install_listeners()
    
    def _ensure_schema(self):
        """Create database tables for activity tracking"""
        try:
            with sqlite3.connect(self._db_path) as conn:
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS user_activity_log (
                        timestamp REAL PRIMARY KEY,
                        keyboard_count INT,
                        mouse_count INT,
                        mouse_distance REAL,
                        activity_level TEXT
                    )
                """)
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS frustration_events (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        timestamp REAL,
                        indicator TEXT,
                        severity REAL
                    )
                """)
                conn.commit()
        except Exception as e:
            logger.error(f"Failed to create activity schema: {e}")
    
    def _install_listeners(self) -> None:
        """Try to install keyboard/mouse listeners"""
        try:
            from pynput import keyboard, mouse
            self._has_pynput = True
            
            # Keyboard listener
            self._keyboard_listener = keyboard.Listener(
                on_press=self._on_key_press,
                on_release=self._on_key_release
            )
            self._keyboard_listener.start()
            
            # Mouse listener
            self._mouse_listener = mouse.Listener(
                on_move=self._on_mouse_move,
                on_click=self._on_mouse_click,
                on_scroll=self._on_mouse_scroll
            )
            self._mouse_listener.start()
            
            logger.info("Installed keyboard and mouse listeners")
        except ImportError:
            logger.warning("pynput not available - activity monitoring limited")
            self._has_pynput = False
        except Exception as e:
            logger.warning(f"Failed to install listeners: {e}")
            self._has_pynput = False
    
    def _on_key_press(self, key) -> None:
        """Keyboard press event"""
        try:
            now = time.time()
            self._last_keyboard_time = now
            self._keyboard_events_5m.append(now)
            
            # Track key hold time for frustration detection
            try:
                key_name = str(key)
                self._keyboard_down_times[key_name] = now
            except Exception:
                pass
                
        except Exception as e:
            logger.debug(f"Error in key press handler: {e}")
    
    def _on_key_release(self, key) -> None:
        """Keyboard release event"""
        try:
            # Track hold duration
            try:
                key_name = str(key)
                if key_name in self._keyboard_down_times:
                    duration = time.time() - self._keyboard_down_times[key_name]
                    # Detect key mashing (very short repeated presses)
                    if duration < 0.1:
                        # Possible frustration
                        self._rapid_clicks.append(time.time())
                    del self._keyboard_down_times[key_name]
            except Exception:
                pass
        except Exception as e:
            logger.debug(f"Error in key release handler: {e}")
    
    def _on_mouse_move(self, x, y) -> None:
        """Mouse move event"""
        try:
            now = time.time()
            self._last_mouse_time = now
            
            # Calculate distance moved
            if self._last_mouse_pos:
                dx = x - self._last_mouse_pos[0]
                dy = y - self._last_mouse_pos[1]
                distance = (dx**2 + dy**2) ** 0.5
                if distance > 1:  # Only count real movement
                    self._mouse_distance_5m.append(distance)
            
            self._last_mouse_pos = (x, y)
        except Exception as e:
            logger.debug(f"Error in mouse move handler: {e}")
    
    def _on_mouse_click(self, x, y, button, pressed) -> None:
        """Mouse click event"""
        try:
            now = time.time()
            self._last_mouse_time = now
            
            if pressed:
                self._mouse_events_5m.append(now)
                # Track rapid clicking (frustration indicator)
                self._rapid_clicks.append(now)
        except Exception as e:
            logger.debug(f"Error in mouse click handler: {e}")
    
    def _on_mouse_scroll(self, x, y, dx, dy) -> None:
        """Mouse scroll event"""
        try:
            now = time.time()
            self._last_mouse_time = now
            self._mouse_events_5m.append(now)
        except Exception as e:
            logger.debug(f"Error in mouse scroll handler: {e}")
    
    def start(self) -> None:
        """Start monitoring"""
        with self.lock:
            if self._monitor_thread and self._monitor_thread.is_alive():
                return
            
            self._stop_event.clear()
            self._monitor_thread = threading.Thread(
                target=self._monitor_loop,
                daemon=True,
                name="SARA-ActivityMonitor"
            )
            self._monitor_thread.start()
            logger.info("User Activity Monitor started")
    
    def stop(self) -> None:
        """Stop monitoring"""
        self._stop_event.set()
        if self._monitor_thread:
            self._monitor_thread.join(timeout=5)
        
        # Stop listeners
        try:
            if hasattr(self, '_keyboard_listener'):
                self._keyboard_listener.stop()
            if hasattr(self, '_mouse_listener'):
                self._mouse_listener.stop()
        except Exception:
            pass
        
        logger.info("User Activity Monitor stopped")
    
    def _monitor_loop(self) -> None:
        """Background thread that computes activity metrics"""
        while not self._stop_event.is_set():
            try:
                self._update_metrics()
            except Exception as e:
                logger.error(f"Error updating metrics: {e}", exc_info=True)
            
            self._stop_event.wait(1.0)  # Update every second
    
    def _update_metrics(self) -> None:
        """Compute current activity metrics"""
        with self.lock:
            now = time.time()
            
            # Count events in last 5 minutes
            keyboard_5m = sum(1 for t in self._keyboard_events_5m if now - t < 300)
            mouse_5m = sum(1 for t in self._mouse_events_5m if now - t < 300)
            
            # Calculate activity levels
            keyboard_level = self._level_from_count(keyboard_5m, max_val=300)
            mouse_level = self._level_from_count(mouse_5m, max_val=300)
            combined_level = self._combine_levels(keyboard_level, mouse_level)
            
            # Calculate idle time
            last_activity = max(self._last_keyboard_time, self._last_mouse_time)
            idle_seconds = now - last_activity
            is_idle = idle_seconds > 300  # 5 minutes
            
            # Detect frustration
            appears_frustrated = self._detect_frustration()
            
            # Detect focus
            appears_focused = combined_level in (ActivityLevel.HIGH, ActivityLevel.MEDIUM) and not is_idle
            
            # Detect pause (momentary inactivity during work)
            has_paused = 30 < idle_seconds < 300
            
            # Create metrics object
            metrics = ActivityMetrics(
                timestamp=now,
                keyboard_activity_level=keyboard_level,
                mouse_activity_level=mouse_level,
                combined_activity_level=combined_level,
                idle_duration_seconds=idle_seconds,
                keyboard_count_5m=keyboard_5m,
                mouse_count_5m=mouse_5m,
                is_user_idle=is_idle,
                has_user_paused=has_paused,
                appears_frustrated=appears_frustrated,
                appears_focused=appears_focused,
                recent_error_attempts=len(self._recent_errors)
            )
            
            # Track trend
            if self._current_metrics:
                prev_level = self._current_metrics.combined_activity_level
                trend = self._current_metrics.activity_trend
                if len(trend) > 0:
                    metrics.activity_trend = list(trend)
                metrics.activity_trend.append(prev_level)
                if len(metrics.activity_trend) > 10:
                    metrics.activity_trend = metrics.activity_trend[-10:]
            
            self._current_metrics = metrics
            
            # Create snapshot
            snapshot = ActivitySnapshot(
                timestamp=now,
                keyboard_events=keyboard_5m,
                mouse_events=mouse_5m,
                mouse_distance=sum(self._mouse_distance_5m),
                keyboard_active=idle_seconds < 5,
                mouse_active=idle_seconds < 5
            )
            self._snapshots.append(snapshot)
            
            # Persist to database
            self._persist_metrics(metrics)
    
    def _level_from_count(self, count: int, max_val: int) -> ActivityLevel:
        """Convert event count to activity level"""
        ratio = count / max_val if max_val > 0 else 0
        if ratio == 0:
            return ActivityLevel.IDLE
        elif ratio < 0.2:
            return ActivityLevel.LOW
        elif ratio < 0.5:
            return ActivityLevel.MEDIUM
        else:
            return ActivityLevel.HIGH
    
    def _combine_levels(self, kb: ActivityLevel, mouse: ActivityLevel) -> ActivityLevel:
        """Combine keyboard and mouse levels"""
        if kb == ActivityLevel.HIGH or mouse == ActivityLevel.HIGH:
            return ActivityLevel.HIGH
        elif kb == ActivityLevel.MEDIUM or mouse == ActivityLevel.MEDIUM:
            return ActivityLevel.MEDIUM
        elif kb == ActivityLevel.LOW or mouse == ActivityLevel.LOW:
            return ActivityLevel.LOW
        else:
            return ActivityLevel.IDLE
    
    def _detect_frustration(self) -> bool:
        """Detect signs of user frustration"""
        now = time.time()
        
        # Rapid clicking pattern (many clicks in short time)
        recent_clicks = [t for t in self._rapid_clicks if now - t < 5]
        if len(recent_clicks) > 5:
            return True
        
        # Rapid key mashing (detected in key handlers)
        if self._current_metrics and self._current_metrics.keyboard_count_5m > 100:
            # Very high keyboard activity
            if hasattr(self, '_last_keyboard_time'):
                recent_keys = sum(1 for t in self._keyboard_events_5m if now - t < 10)
                if recent_keys > 50:  # Mashing keys
                    return True
        
        # Recent errors being repeated
        if len(self._recent_errors) > 3:
            return True
        
        return False
    
    def _persist_metrics(self, metrics: ActivityMetrics) -> None:
        """Store metrics to database"""
        try:
            with sqlite3.connect(self._db_path) as conn:
                conn.execute("""
                    INSERT OR REPLACE INTO user_activity_log
                    (timestamp, keyboard_count, mouse_count, mouse_distance, activity_level)
                    VALUES (?, ?, ?, ?, ?)
                """, (
                    metrics.timestamp,
                    metrics.keyboard_count_5m,
                    metrics.mouse_count_5m,
                    sum(self._mouse_distance_5m),
                    metrics.combined_activity_level.value
                ))
                
                if metrics.appears_frustrated:
                    conn.execute("""
                        INSERT INTO frustration_events
                        (timestamp, indicator, severity)
                        VALUES (?, ?, ?)
                    """, (
                        metrics.timestamp,
                        "rapid_activity" if metrics.keyboard_count_5m > 100 else "repeated_errors",
                        0.7 if metrics.appears_frustrated else 0.3
                    ))
                
                conn.commit()
        except Exception as e:
            logger.debug(f"Error persisting metrics: {e}")
    
    # ===== PUBLIC API =====
    
    def get_current_activity(self) -> Optional[ActivityMetrics]:
        """Get current activity metrics"""
        with self.lock:
            return self._current_metrics
    
    def get_activity_level(self) -> ActivityLevel:
        """Get combined activity level"""
        with self.lock:
            if self._current_metrics:
                return self._current_metrics.combined_activity_level
            return ActivityLevel.IDLE
    
    def get_idle_duration(self) -> float:
        """Get seconds since last user activity"""
        with self.lock:
            if self._current_metrics:
                return self._current_metrics.idle_duration_seconds
            return time.time() - self._last_keyboard_time
    
    def is_user_idle(self, duration_seconds: float = 300) -> bool:
        """Check if user has been idle for at least duration_seconds"""
        with self.lock:
            if self._current_metrics:
                return self._current_metrics.idle_duration_seconds >= duration_seconds
            return time.time() - max(self._last_keyboard_time, self._last_mouse_time) >= duration_seconds
    
    def is_user_active(self) -> bool:
        """Check if user is currently active"""
        level = self.get_activity_level()
        return level in (ActivityLevel.HIGH, ActivityLevel.MEDIUM, ActivityLevel.LOW)
    
    def record_error(self, error_type: str) -> None:
        """Record that user encountered an error (for frustration detection)"""
        self._recent_errors.append((time.time(), error_type))
    
    def clear_errors(self) -> None:
        """Clear error history"""
        self._recent_errors.clear()
    
    def get_activity_history(self, limit: int = 60) -> List[ActivitySnapshot]:
        """Get recent activity history (last N seconds)"""
        with self.lock:
            return list(self._snapshots)[-limit:] if self._snapshots else []
    
    def close(self) -> None:
        """Cleanup and shutdown"""
        self.stop()


# Singleton instance
_activity_monitor: Optional[UserActivityMonitor] = None

def get_activity_monitor() -> UserActivityMonitor:
    """Get the global activity monitor (creates if needed)"""
    global _activity_monitor
    if _activity_monitor is None:
        _activity_monitor = UserActivityMonitor()
    return _activity_monitor

def start_activity_monitor() -> None:
    """Start the activity monitor"""
    get_activity_monitor().start()

def stop_activity_monitor() -> None:
    """Stop the activity monitor"""
    global _activity_monitor
    if _activity_monitor:
        _activity_monitor.stop()
        _activity_monitor = None
