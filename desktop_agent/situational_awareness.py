"""
SARA Situational Awareness Engine

Maintains a unified, real-time model of the desktop environment.
Integrates perception (screen, windows, activity) into coherent situational context.

This is the foundation for autonomous decision-making.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from dataclasses import dataclass, asdict, field
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
import sqlite3

# Existing SARA integrations
try:
    import pygetwindow as gw
    import psutil
    _HAS_PSUTIL = True
except ImportError:
    _HAS_PSUTIL = False

from .sqlite_memory import data_root
from .tools_windows import get_active_window, list_windows

logger = logging.getLogger(__name__)


@dataclass
class WindowInfo:
    """Current window/application state"""
    title: str
    process_name: str
    process_id: int
    window_id: int
    is_active: bool
    bounds: Dict[str, int]  # x, y, width, height
    class_name: str = ""
    
    
@dataclass
class ApplicationInfo:
    """Running application state"""
    name: str
    process_id: int
    memory_mb: float = 0.0
    cpu_percent: float = 0.0
    is_system: bool = False


@dataclass
class DialogInfo:
    """Detected dialog/popup state"""
    title: str
    type: str  # "save", "open", "warning", "error", "question", "confirmation"
    buttons: List[str] = field(default_factory=list)
    message: str = ""
    is_blocking: bool = False


@dataclass
class TaskContext:
    """Current or recent task being performed"""
    goal: str
    started_at: float
    last_update: float
    steps_completed: List[str] = field(default_factory=list)
    current_step: Optional[str] = None
    application_context: Optional[str] = None
    files_involved: List[str] = field(default_factory=list)


@dataclass
class DesktopState:
    """Complete snapshot of desktop state"""
    timestamp: float
    
    # Window and application state
    active_window: Optional[WindowInfo] = None
    active_application: Optional[str] = None
    open_applications: List[ApplicationInfo] = field(default_factory=list)
    all_windows: List[WindowInfo] = field(default_factory=list)
    
    # Screen and UI
    screen_width: int = 1920
    screen_height: int = 1080
    connected_monitors: int = 1
    visible_dialogs: List[DialogInfo] = field(default_factory=list)
    visible_text: Dict[str, str] = field(default_factory=dict)  # region_id -> text
    ui_elements: Dict[str, Any] = field(default_factory=dict)
    
    # User interaction
    keyboard_activity_level: str = "idle"  # low, medium, high
    mouse_activity_level: str = "idle"
    last_user_activity_seconds_ago: float = 0.0
    user_is_idle: bool = False
    
    # Task and context
    current_task: Optional[TaskContext] = None
    previous_task: Optional[TaskContext] = None
    recent_commands: List[str] = field(default_factory=list)
    recent_errors: List[str] = field(default_factory=list)
    
    # File system
    watched_files_changed: List[str] = field(default_factory=list)
    important_files_open: List[str] = field(default_factory=list)
    
    # Alerts and concerns
    potentially_destructive_action: Optional[str] = None
    system_warnings: List[str] = field(default_factory=list)
    blocking_dialog: Optional[DialogInfo] = None


class SituationalAwarenessEngine:
    """
    Real-time desktop awareness system.
    
    Consolidates:
    - Window/application state (via win32gui, pygetwindow)
    - Screen content (via screen capture + OCR)
    - User activity (keyboard, mouse)
    - Background events (file changes, task completion)
    - System state (processes, resources)
    
    Maintains these observations for autonomous decision-making.
    """
    
    def __init__(self):
        self.lock = threading.RLock()
        self._current_state: Optional[DesktopState] = None
        self._previous_state: Optional[DesktopState] = None
        self._observers: List[callable] = []
        
        # State history for change detection
        self._state_history: List[DesktopState] = []
        self._max_history = 10
        
        # File watching
        self._watched_paths: Dict[str, float] = {}  # path -> last_mtime
        
        # Background thread
        self._monitor_thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self._update_interval = 1.0  # seconds between snapshots
        
        # Persistence
        self._db_path = data_root() / "sara_memory.db"
        self._ensure_state_schema()
        
    def _ensure_state_schema(self):
        """Create database tables for state history"""
        try:
            with sqlite3.connect(self._db_path) as conn:
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS desktop_state_history (
                        timestamp REAL PRIMARY KEY,
                        state_json TEXT NOT NULL,
                        changes_json TEXT
                    )
                """)
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS situational_events (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        timestamp REAL,
                        event_type TEXT,
                        description TEXT,
                        confidence REAL
                    )
                """)
                conn.commit()
        except Exception as e:
            logger.error(f"Failed to create state schema: {e}")
    
    def start(self) -> None:
        """Start continuous monitoring"""
        with self.lock:
            if self._monitor_thread and self._monitor_thread.is_alive():
                return
            
            self._stop_event.clear()
            self._monitor_thread = threading.Thread(
                target=self._monitor_loop,
                daemon=True,
                name="SARA-SituationalAwareness"
            )
            self._monitor_thread.start()
            logger.info("Situational Awareness Engine started")
    
    def stop(self) -> None:
        """Stop monitoring"""
        self._stop_event.set()
        if self._monitor_thread:
            self._monitor_thread.join(timeout=5)
        logger.info("Situational Awareness Engine stopped")
    
    def _monitor_loop(self) -> None:
        """Background thread that continuously updates state"""
        while not self._stop_event.is_set():
            try:
                self._update_state()
            except Exception as e:
                logger.error(f"Error updating desktop state: {e}", exc_info=True)
            
            self._stop_event.wait(self._update_interval)
    
    def _update_state(self) -> None:
        """Capture current desktop state"""
        with self.lock:
            old_state = self._current_state
            
            # Build new state from real observations
            new_state = DesktopState(timestamp=time.time())
            
            # Capture window/application state
            self._update_window_state(new_state)
            
            # Capture screen state
            self._update_screen_state(new_state)
            
            # Capture user activity (requires activity monitor to be integrated)
            self._update_activity_state(new_state)
            
            # Check watched files
            self._update_file_state(new_state)
            
            # Detect dialogs and alerts
            self._update_dialog_state(new_state)
            
            # Update history
            self._previous_state = old_state
            self._current_state = new_state
            self._state_history.append(new_state)
            if len(self._state_history) > self._max_history:
                self._state_history.pop(0)
            
            # Persist significant state changes
            self._persist_state_change(old_state, new_state)
            
            # Notify observers
            self._notify_observers(new_state)
    
    def _update_window_state(self, state: DesktopState) -> None:
        """Capture active window and running applications"""
        try:
            # Active window
            active_win = get_active_window()
            if active_win:
                try:
                    proc = psutil.Process(active_win.get("pid", 0))
                    state.active_window = WindowInfo(
                        title=active_win.get("title", ""),
                        process_name=active_win.get("process_name", proc.name()),
                        process_id=proc.pid,
                        window_id=active_win.get("hwnd", 0),
                        is_active=True,
                        bounds=active_win.get("rect", {"x": 0, "y": 0, "width": 0, "height": 0}),
                        class_name=active_win.get("class", "")
                    )
                    state.active_application = active_win.get("process_name", "")
                except Exception:
                    pass
            
            # All open windows
            if _HAS_PSUTIL:
                windows = list_windows()
                for win in windows[:20]:  # Limit to 20 windows
                    try:
                        proc = psutil.Process(win.get("pid", 0))
                        state.all_windows.append(WindowInfo(
                            title=win.get("title", "")[:100],  # Truncate title
                            process_name=proc.name(),
                            process_id=proc.pid,
                            window_id=win.get("hwnd", 0),
                            is_active=win.get("hwnd") == active_win.get("hwnd") if active_win else False,
                            bounds=win.get("rect", {"x": 0, "y": 0, "width": 0, "height": 0}),
                            class_name=win.get("class", "")
                        ))
                    except Exception:
                        continue
            
            # Running applications
            if _HAS_PSUTIL:
                try:
                    unique_procs = {}
                    for proc in psutil.process_iter(['name', 'pid', 'memory_info', 'cpu_percent']):
                        try:
                            name = proc.info.get('name', 'unknown')
                            if name not in unique_procs:
                                unique_procs[name] = proc
                        except Exception:
                            continue
                    
                    for name, proc in list(unique_procs.items())[:50]:  # Limit to 50
                        try:
                            state.open_applications.append(ApplicationInfo(
                                name=name,
                                process_id=proc.pid,
                                memory_mb=proc.memory_info().rss / 1024 / 1024 if proc.memory_info() else 0,
                                cpu_percent=proc.cpu_percent(interval=0.1) if hasattr(proc, 'cpu_percent') else 0
                            ))
                        except Exception:
                            continue
                except Exception:
                    pass
                    
        except Exception as e:
            logger.debug(f"Error updating window state: {e}")
    
    def _update_screen_state(self, state: DesktopState) -> None:
        """Capture screen content and UI state"""
        try:
            # Get screen dimensions
            try:
                import win32api
                screens = win32api.EnumDisplayMonitors()
                state.connected_monitors = len(screens) if screens else 1
                if screens:
                    monitor = screens[0]
                    state.screen_width = monitor[2]
                    state.screen_height = monitor[3]
            except Exception:
                pass
            
            # UI state extraction can be extended here with perception module
            # For now, leave as placeholder for future enhancement
                
        except Exception as e:
            logger.debug(f"Error updating screen state: {e}")
    
    def _update_activity_state(self, state: DesktopState) -> None:
        """Update user activity state (integrated with UserActivityMonitor)"""
        # This will be integrated with UserActivityMonitor when created
        # For now, mark as idle since we don't have activity data yet
        try:
            import time
            # Placeholder - real implementation in UserActivityMonitor
            state.keyboard_activity_level = "unknown"
            state.mouse_activity_level = "unknown"
            state.user_is_idle = False
        except Exception:
            pass
    
    def _update_file_state(self, state: DesktopState) -> None:
        """Check watched files for changes"""
        try:
            for path_str, last_mtime in list(self._watched_paths.items()):
                try:
                    path = Path(path_str)
                    if path.exists():
                        current_mtime = path.stat().st_mtime
                        if current_mtime != last_mtime:
                            state.watched_files_changed.append(path_str)
                            self._watched_paths[path_str] = current_mtime
                except Exception:
                    pass
        except Exception as e:
            logger.debug(f"Error updating file state: {e}")
    
    def _update_dialog_state(self, state: DesktopState) -> None:
        """Detect blocking dialogs and alerts"""
        try:
            # This would integrate with screen analysis
            # For now, placeholder
            pass
        except Exception as e:
            logger.debug(f"Error updating dialog state: {e}")
    
    def _persist_state_change(self, old: Optional[DesktopState], new: DesktopState) -> None:
        """Store significant state changes"""
        try:
            # Only store if there's a significant change
            if old is None or self._state_changed_significantly(old, new):
                with sqlite3.connect(self._db_path) as conn:
                    conn.execute("""
                        INSERT INTO desktop_state_history 
                        (timestamp, state_json, changes_json)
                        VALUES (?, ?, ?)
                    """, (
                        new.timestamp,
                        json.dumps(asdict(new), default=str),
                        json.dumps(self._compute_changes(old, new), default=str) if old else "{}"
                    ))
                    conn.commit()
        except Exception as e:
            logger.debug(f"Error persisting state change: {e}")
    
    def _state_changed_significantly(self, old: DesktopState, new: DesktopState) -> bool:
        """Detect if state changed in a significant way"""
        # Active window changed
        if old.active_application != new.active_application:
            return True
        # New error or warning
        if len(new.recent_errors) > len(old.recent_errors):
            return True
        # Watched file changed
        if new.watched_files_changed:
            return True
        # Dialog appeared
        if new.visible_dialogs and not old.visible_dialogs:
            return True
        return False
    
    def _compute_changes(self, old: DesktopState, new: DesktopState) -> Dict[str, Any]:
        """Compute what changed between old and new state"""
        changes = {}
        if old.active_application != new.active_application:
            changes["active_app_changed"] = {
                "from": old.active_application,
                "to": new.active_application
            }
        if old.user_is_idle != new.user_is_idle:
            changes["idle_status"] = new.user_is_idle
        if new.watched_files_changed:
            changes["files_changed"] = new.watched_files_changed
        if new.visible_dialogs and not old.visible_dialogs:
            changes["dialogs_appeared"] = [d.title for d in new.visible_dialogs]
        return changes
    
    def _notify_observers(self, state: DesktopState) -> None:
        """Notify registered observers of state change"""
        for observer in self._observers:
            try:
                observer(state)
            except Exception as e:
                logger.error(f"Observer notification failed: {e}")
    
    # ===== PUBLIC API =====
    
    def get_current_state(self) -> Optional[DesktopState]:
        """Get the current desktop state"""
        with self.lock:
            return self._current_state
    
    def get_previous_state(self) -> Optional[DesktopState]:
        """Get the previous desktop state"""
        with self.lock:
            return self._previous_state
    
    def get_state_context(self) -> Dict[str, Any]:
        """Get current state as a context dictionary (for AI use)"""
        with self.lock:
            state = self._current_state
            if not state:
                return {}
            
            return {
                "active_application": state.active_application,
                "active_window_title": state.active_window.title if state.active_window else None,
                "num_open_apps": len(state.open_applications),
                "num_open_windows": len(state.all_windows),
                "user_is_idle": state.user_is_idle,
                "last_user_activity_seconds": state.last_user_activity_seconds_ago,
                "visible_dialogs": [d.title for d in state.visible_dialogs],
                "blocking_dialog": state.blocking_dialog.title if state.blocking_dialog else None,
                "watched_files_changed": state.watched_files_changed,
                "recent_errors": state.recent_errors[-3:] if state.recent_errors else [],
                "current_task_goal": state.current_task.goal if state.current_task else None,
                "screen_width": state.screen_width,
                "screen_height": state.screen_height,
                "connected_monitors": state.connected_monitors
            }
    
    def watch_file(self, path: str) -> None:
        """Start watching a file for changes"""
        try:
            p = Path(path)
            if p.exists():
                self._watched_paths[path] = p.stat().st_mtime
        except Exception as e:
            logger.warning(f"Failed to watch file {path}: {e}")
    
    def unwatch_file(self, path: str) -> None:
        """Stop watching a file"""
        self._watched_paths.pop(path, None)
    
    def set_task_context(self, goal: str, **kwargs) -> None:
        """Set the current task being performed"""
        with self.lock:
            self._current_task = TaskContext(
                goal=goal,
                started_at=time.time(),
                last_update=time.time(),
                application_context=kwargs.get("application"),
                files_involved=kwargs.get("files", [])
            )
    
    def get_task_context(self) -> Optional[TaskContext]:
        """Get the current task context"""
        with self.lock:
            if self._current_state:
                return self._current_state.current_task
            return None
    
    def register_observer(self, callback: callable) -> None:
        """Register a callback to be notified of state changes"""
        with self.lock:
            self._observers.append(callback)
    
    def unregister_observer(self, callback: callable) -> None:
        """Unregister an observer"""
        with self.lock:
            self._observers = [c for c in self._observers if c != callback]
    
    def get_state_history(self, limit: int = 5) -> List[DesktopState]:
        """Get recent state history"""
        with self.lock:
            return self._state_history[-limit:] if self._state_history else []
    
    def close(self) -> None:
        """Cleanup and shutdown"""
        self.stop()


# Singleton instance
_awareness_engine: Optional[SituationalAwarenessEngine] = None

def get_awareness_engine() -> SituationalAwarenessEngine:
    """Get the global awareness engine (creates if needed)"""
    global _awareness_engine
    if _awareness_engine is None:
        _awareness_engine = SituationalAwarenessEngine()
    return _awareness_engine

def start_awareness_engine() -> None:
    """Start the awareness engine"""
    get_awareness_engine().start()

def stop_awareness_engine() -> None:
    """Stop the awareness engine"""
    global _awareness_engine
    if _awareness_engine:
        _awareness_engine.stop()
        _awareness_engine = None
