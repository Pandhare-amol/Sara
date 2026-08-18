"""
Background Event Monitor

Detects and tracks significant background events:
- Task completion
- Application crashes
- Build/compile status
- Download completion
- File changes
- System notifications
- Errors and warnings

These events trigger proactive SARA behavior.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from enum import Enum
from typing import Optional, List, Dict, Any, Callable
from collections import deque
import sqlite3
from pathlib import Path

from .sqlite_memory import data_root

logger = logging.getLogger(__name__)


class EventType(Enum):
    """Types of background events"""
    TASK_COMPLETE = "task_complete"
    TASK_FAILED = "task_failed"
    BUILD_SUCCESS = "build_success"
    BUILD_FAILED = "build_failed"
    TEST_PASSED = "test_passed"
    TEST_FAILED = "test_failed"
    APPLICATION_CRASH = "application_crash"
    APPLICATION_HANG = "application_hang"
    DOWNLOAD_COMPLETE = "download_complete"
    UPLOAD_COMPLETE = "upload_complete"
    FILE_CHANGED = "file_changed"
    FILE_CREATED = "file_created"
    FILE_DELETED = "file_deleted"
    DIRECTORY_CREATED = "directory_created"
    NOTIFICATION = "notification"
    WARNING = "warning"
    ERROR = "error"
    SECURITY_WARNING = "security_warning"
    DIALOG_APPEARED = "dialog_appeared"
    DIALOG_CLOSED = "dialog_closed"
    SAVE_DIALOG = "save_dialog"
    DELETE_CONFIRMATION = "delete_confirmation"
    NETWORK_CONNECTED = "network_connected"
    NETWORK_DISCONNECTED = "network_disconnected"
    LOW_DISK_SPACE = "low_disk_space"
    LOW_MEMORY = "low_memory"
    PROCESS_FINISHED = "process_finished"
    BACKUP_COMPLETE = "backup_complete"
    SYNC_COMPLETE = "sync_complete"


class EventImportance(Enum):
    """How important is this event to notify about"""
    CRITICAL = "critical"  # Requires immediate attention
    HIGH = "high"  # Should be mentioned soon
    MEDIUM = "medium"  # Can wait for natural conversation point
    LOW = "low"  # Nice to know but not urgent


@dataclass
class BackgroundEvent:
    """A significant background event"""
    event_id: str
    event_type: EventType
    timestamp: float
    title: str
    description: str = ""
    importance: EventImportance = EventImportance.MEDIUM
    metadata: Dict[str, Any] | None = None
    has_been_notified: bool = False
    notification_timestamp: Optional[float] = None
    
    # Context
    related_application: Optional[str] = None
    related_files: List[str] | None = None
    exit_code: Optional[int] = None
    error_message: Optional[str] = None


class BackgroundEventMonitor:
    """
    Monitors for significant background events.
    
    Provides:
    - Event detection and tracking
    - Importance assessment
    - Notification state tracking
    - Event history and persistence
    - Filtering and querying
    """
    
    def __init__(self):
        self.lock = threading.RLock()
        
        # Event tracking
        self._events: deque = deque(maxlen=1000)  # Keep last 1000 events
        self._pending_events: List[BackgroundEvent] = []  # Events not yet notified
        self._notified_events: deque = deque(maxlen=500)
        
        # Observers
        self._event_observers: List[Callable[[BackgroundEvent], None]] = []
        
        # Database
        self._db_path = data_root() / "sara_memory.db"
        self._ensure_schema()
        
        # Background thread for event polling
        self._monitor_thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        
        # Event history
        self._last_check_time = time.time()
        
        # Built-in monitors
        self._file_watchers: Dict[str, float] = {}  # path -> last_mtime
        self._watched_processes: Dict[int, str] = {}  # pid -> name
    
    def _ensure_schema(self):
        """Create database tables for event tracking"""
        try:
            with sqlite3.connect(self._db_path) as conn:
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS background_events (
                        event_id TEXT PRIMARY KEY,
                        event_type TEXT,
                        timestamp REAL,
                        title TEXT,
                        description TEXT,
                        importance TEXT,
                        metadata TEXT,
                        application TEXT,
                        has_notified BOOLEAN,
                        notification_time REAL
                    )
                """)
                conn.commit()
        except Exception as e:
            logger.error(f"Failed to create events schema: {e}")
    
    def start(self) -> None:
        """Start monitoring"""
        with self.lock:
            if self._monitor_thread and self._monitor_thread.is_alive():
                return
            
            self._stop_event.clear()
            self._monitor_thread = threading.Thread(
                target=self._monitor_loop,
                daemon=True,
                name="SARA-EventMonitor"
            )
            self._monitor_thread.start()
            logger.info("Background Event Monitor started")
    
    def stop(self) -> None:
        """Stop monitoring"""
        self._stop_event.set()
        if self._monitor_thread:
            self._monitor_thread.join(timeout=5)
        logger.info("Background Event Monitor stopped")
    
    def _monitor_loop(self) -> None:
        """Background monitoring loop"""
        while not self._stop_event.is_set():
            try:
                # Check for file changes
                self._check_file_changes()
                
                # Check for process completion
                self._check_process_completion()
                
                # Check for system events (requires integration)
                self._check_system_events()
                
            except Exception as e:
                logger.error(f"Error in monitor loop: {e}", exc_info=True)
            
            self._stop_event.wait(5.0)  # Check every 5 seconds
    
    def _check_file_changes(self) -> None:
        """Check watched files for changes"""
        try:
            current_time = time.time()
            for path_str, last_mtime in list(self._file_watchers.items()):
                try:
                    path = Path(path_str)
                    if path.exists():
                        current_mtime = path.stat().st_mtime
                        if current_mtime != last_mtime:
                            # File changed
                            event = BackgroundEvent(
                                event_id=f"file_change_{int(current_time*1000)}",
                                event_type=EventType.FILE_CHANGED,
                                timestamp=current_time,
                                title=f"File changed: {path.name}",
                                description=f"File was modified: {path_str}",
                                importance=EventImportance.LOW,
                                related_files=[path_str],
                                metadata={"path": path_str}
                            )
                            self._record_event(event)
                            self._file_watchers[path_str] = current_mtime
                    else:
                        # File deleted
                        event = BackgroundEvent(
                            event_id=f"file_deleted_{int(current_time*1000)}",
                            event_type=EventType.FILE_DELETED,
                            timestamp=current_time,
                            title=f"File deleted: {path.name}",
                            description=f"File was deleted: {path_str}",
                            importance=EventImportance.HIGH,
                            related_files=[path_str],
                            metadata={"path": path_str}
                        )
                        self._record_event(event)
                        del self._file_watchers[path_str]
                except Exception as e:
                    logger.debug(f"Error checking file {path_str}: {e}")
        except Exception as e:
            logger.debug(f"Error in file change detection: {e}")
    
    def _check_process_completion(self) -> None:
        """Check if watched processes have completed"""
        try:
            import psutil
            current_time = time.time()
            
            for pid, proc_name in list(self._watched_processes.items()):
                try:
                    proc = psutil.Process(pid)
                    # Process still running
                    if proc.is_running():
                        continue
                    
                    # Process completed
                    try:
                        exit_code = proc.returncode if hasattr(proc, 'returncode') else None
                    except Exception:
                        exit_code = None
                    
                    event_type = EventType.PROCESS_FINISHED
                    title = f"Process completed: {proc_name}"
                    importance = EventImportance.MEDIUM
                    
                    # Classify by process name
                    if "build" in proc_name.lower() or "compile" in proc_name.lower():
                        event_type = EventType.BUILD_SUCCESS if exit_code == 0 else EventType.BUILD_FAILED
                        title = f"Build {'succeeded' if exit_code == 0 else 'failed'}"
                        importance = EventImportance.HIGH
                    elif "test" in proc_name.lower():
                        event_type = EventType.TEST_PASSED if exit_code == 0 else EventType.TEST_FAILED
                        title = f"Tests {'passed' if exit_code == 0 else 'failed'}"
                        importance = EventImportance.HIGH
                    elif "download" in proc_name.lower():
                        event_type = EventType.DOWNLOAD_COMPLETE
                        title = "Download completed"
                        importance = EventImportance.MEDIUM
                    
                    event = BackgroundEvent(
                        event_id=f"process_complete_{int(current_time*1000)}",
                        event_type=event_type,
                        timestamp=current_time,
                        title=title,
                        description=f"Process {proc_name} (PID {pid}) has completed",
                        importance=importance,
                        exit_code=exit_code,
                        metadata={"process_name": proc_name, "pid": pid, "exit_code": exit_code}
                    )
                    self._record_event(event)
                    del self._watched_processes[pid]
                    
                except psutil.NoSuchProcess:
                    # Process doesn't exist anymore
                    event = BackgroundEvent(
                        event_id=f"process_ended_{int(current_time*1000)}",
                        event_type=EventType.PROCESS_FINISHED,
                        timestamp=current_time,
                        title=f"Process ended: {proc_name}",
                        description=f"Process {proc_name} (PID {pid}) has ended",
                        importance=EventImportance.LOW,
                        metadata={"process_name": proc_name, "pid": pid}
                    )
                    self._record_event(event)
                    del self._watched_processes[pid]
                    
                except Exception as e:
                    logger.debug(f"Error checking process {pid}: {e}")
        except Exception as e:
            logger.debug(f"Error in process completion detection: {e}")
    
    def _check_system_events(self) -> None:
        """Check for system-level events"""
        try:
            import psutil
            import shutil
            current_time = time.time()
            
            # Check disk space
            try:
                disk = shutil.disk_usage("/")
                percent_free = (disk.free / disk.total) * 100
                if percent_free < 10:
                    event = BackgroundEvent(
                        event_id=f"low_disk_{int(current_time)}",
                        event_type=EventType.LOW_DISK_SPACE,
                        timestamp=current_time,
                        title=f"Low disk space: {percent_free:.1f}% free",
                        description=f"Disk space is running low. Only {disk.free / (1024**3):.1f} GB available.",
                        importance=EventImportance.HIGH,
                        metadata={"percent_free": percent_free, "free_bytes": disk.free}
                    )
                    self._record_event(event)
            except Exception:
                pass
            
            # Check memory
            try:
                mem = psutil.virtual_memory()
                if mem.percent > 90:
                    event = BackgroundEvent(
                        event_id=f"low_mem_{int(current_time)}",
                        event_type=EventType.LOW_MEMORY,
                        timestamp=current_time,
                        title=f"High memory usage: {mem.percent:.1f}%",
                        description=f"System memory is nearly full ({mem.available / (1024**3):.1f} GB available)",
                        importance=EventImportance.HIGH,
                        metadata={"percent": mem.percent, "available": mem.available}
                    )
                    self._record_event(event)
            except Exception:
                pass
                
        except Exception as e:
            logger.debug(f"Error checking system events: {e}")
    
    def _record_event(self, event: BackgroundEvent) -> None:
        """Record an event"""
        with self.lock:
            # Check for duplicates (same event type within 10 seconds)
            recent_events = [e for e in self._events if 
                           e.event_type == event.event_type and 
                           time.time() - e.timestamp < 10]
            if recent_events and recent_events[-1].title == event.title:
                # Duplicate, skip
                return
            
            self._events.append(event)
            self._pending_events.append(event)
            
            # Persist to database
            self._persist_event(event)
            
            # Notify observers
            self._notify_observers(event)
    
    def _persist_event(self, event: BackgroundEvent) -> None:
        """Store event to database"""
        try:
            import json
            with sqlite3.connect(self._db_path) as conn:
                conn.execute("""
                    INSERT OR REPLACE INTO background_events
                    (event_id, event_type, timestamp, title, description, 
                     importance, metadata, application, has_notified, notification_time)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    event.event_id,
                    event.event_type.value,
                    event.timestamp,
                    event.title,
                    event.description,
                    event.importance.value,
                    json.dumps(event.metadata or {}),
                    event.related_application,
                    event.has_been_notified,
                    event.notification_timestamp
                ))
                conn.commit()
        except Exception as e:
            logger.debug(f"Error persisting event: {e}")
    
    def _notify_observers(self, event: BackgroundEvent) -> None:
        """Notify registered observers"""
        for observer in self._event_observers:
            try:
                observer(event)
            except Exception as e:
                logger.error(f"Observer error: {e}")
    
    # ===== PUBLIC API =====
    
    def record_event(self, event_type: EventType, title: str, 
                    importance: EventImportance = EventImportance.MEDIUM,
                    **kwargs) -> BackgroundEvent:
        """Record a custom event"""
        event = BackgroundEvent(
            event_id=f"custom_{int(time.time()*1000)}_{id(kwargs)}",
            event_type=event_type,
            timestamp=time.time(),
            title=title,
            description=kwargs.get("description", ""),
            importance=importance,
            metadata=kwargs.get("metadata"),
            related_application=kwargs.get("application"),
            related_files=kwargs.get("files"),
            exit_code=kwargs.get("exit_code"),
            error_message=kwargs.get("error")
        )
        self._record_event(event)
        return event
    
    def get_pending_events(self) -> List[BackgroundEvent]:
        """Get events that haven't been notified yet"""
        with self.lock:
            return list(self._pending_events)
    
    def mark_notified(self, event_id: str) -> None:
        """Mark an event as notified"""
        with self.lock:
            for i, event in enumerate(self._pending_events):
                if event.event_id == event_id:
                    event.has_been_notified = True
                    event.notification_timestamp = time.time()
                    self._pending_events.pop(i)
                    self._notified_events.append(event)
                    self._persist_event(event)
                    break
    
    def watch_file(self, path: str) -> None:
        """Start watching a file for changes"""
        try:
            p = Path(path)
            if p.exists():
                self._file_watchers[path] = p.stat().st_mtime
        except Exception as e:
            logger.warning(f"Failed to watch file {path}: {e}")
    
    def unwatch_file(self, path: str) -> None:
        """Stop watching a file"""
        self._file_watchers.pop(path, None)
    
    def watch_process(self, pid: int, name: str) -> None:
        """Start watching a process for completion"""
        try:
            import psutil
            # Verify process exists
            proc = psutil.Process(pid)
            self._watched_processes[pid] = name
        except Exception as e:
            logger.warning(f"Failed to watch process {pid}: {e}")
    
    def get_event_history(self, limit: int = 20) -> List[BackgroundEvent]:
        """Get recent event history"""
        with self.lock:
            return list(self._events)[-limit:] if self._events else []
    
    def get_events_by_type(self, event_type: EventType, limit: int = 10) -> List[BackgroundEvent]:
        """Get events of a specific type"""
        with self.lock:
            return [e for e in list(self._events)[-limit*3:] if e.event_type == event_type][-limit:]
    
    def register_observer(self, callback: Callable[[BackgroundEvent], None]) -> None:
        """Register callback for new events"""
        self._event_observers.append(callback)
    
    def unregister_observer(self, callback: Callable[[BackgroundEvent], None]) -> None:
        """Unregister observer"""
        self._event_observers = [c for c in self._event_observers if c != callback]
    
    def should_notify_user(self, event: BackgroundEvent) -> bool:
        """Determine if user should be notified about this event"""
        # Critical and high importance events should be notified
        if event.importance in (EventImportance.CRITICAL, EventImportance.HIGH):
            return True
        
        # Success events can be announced naturally
        if event.event_type in (EventType.BUILD_SUCCESS, EventType.TEST_PASSED, 
                               EventType.DOWNLOAD_COMPLETE, EventType.SYNC_COMPLETE):
            return True
        
        # Errors should be noted
        if event.event_type in (EventType.ERROR, EventType.WARNING, 
                               EventType.BUILD_FAILED, EventType.TEST_FAILED):
            return True
        
        return False
    
    def close(self) -> None:
        """Cleanup and shutdown"""
        self.stop()


# Singleton instance
_event_monitor: Optional[BackgroundEventMonitor] = None

def get_event_monitor() -> BackgroundEventMonitor:
    """Get the global event monitor (creates if needed)"""
    global _event_monitor
    if _event_monitor is None:
        _event_monitor = BackgroundEventMonitor()
    return _event_monitor

def start_event_monitor() -> None:
    """Start the event monitor"""
    get_event_monitor().start()

def stop_event_monitor() -> None:
    """Stop the event monitor"""
    global _event_monitor
    if _event_monitor:
        _event_monitor.stop()
        _event_monitor = None
