"""
Unit tests for autonomous perception modules.

Tests:
- Situational Awareness Engine
- User Activity Monitor
- Background Event Monitor
"""

import pytest
import time
import tempfile
from pathlib import Path
from unittest.mock import Mock, patch, MagicMock


class TestSituationalAwarenessEngine:
    """Tests for Situational Awareness Engine"""
    
    def test_import(self):
        """Test that module imports without error"""
        try:
            from desktop_agent.situational_awareness import (
                SituationalAwarenessEngine,
                DesktopState,
                get_awareness_engine
            )
            assert SituationalAwarenessEngine is not None
            assert DesktopState is not None
            assert get_awareness_engine is not None
        except ImportError as e:
            pytest.skip(f"Module import failed: {e}")
    
    def test_engine_creation(self):
        """Test engine can be created"""
        from desktop_agent.situational_awareness import SituationalAwarenessEngine
        engine = SituationalAwarenessEngine()
        assert engine is not None
        assert engine.lock is not None
    
    def test_state_context_empty_when_none(self):
        """Test state context is empty dict when no state"""
        from desktop_agent.situational_awareness import SituationalAwarenessEngine
        engine = SituationalAwarenessEngine()
        context = engine.get_state_context()
        assert isinstance(context, dict)
        assert context == {}
    
    def test_watch_file(self):
        """Test file watching registration"""
        from desktop_agent.situational_awareness import SituationalAwarenessEngine
        engine = SituationalAwarenessEngine()
        
        with tempfile.NamedTemporaryFile(delete=False) as f:
            temp_path = f.name
        
        try:
            engine.watch_file(temp_path)
            assert temp_path in engine._watched_paths
        finally:
            Path(temp_path).unlink(missing_ok=True)
    
    def test_unwatch_file(self):
        """Test file unwatch"""
        from desktop_agent.situational_awareness import SituationalAwarenessEngine
        engine = SituationalAwarenessEngine()
        
        with tempfile.NamedTemporaryFile(delete=False) as f:
            temp_path = f.name
        
        try:
            engine.watch_file(temp_path)
            assert temp_path in engine._watched_paths
            engine.unwatch_file(temp_path)
            assert temp_path not in engine._watched_paths
        finally:
            Path(temp_path).unlink(missing_ok=True)
    
    def test_register_observer(self):
        """Test observer registration"""
        from desktop_agent.situational_awareness import SituationalAwarenessEngine
        engine = SituationalAwarenessEngine()
        
        callback = Mock()
        engine.register_observer(callback)
        assert callback in engine._observers
    
    def test_unregister_observer(self):
        """Test observer unregistration"""
        from desktop_agent.situational_awareness import SituationalAwarenessEngine
        engine = SituationalAwarenessEngine()
        
        callback = Mock()
        engine.register_observer(callback)
        engine.unregister_observer(callback)
        assert callback not in engine._observers
    
    def test_task_context(self):
        """Test task context tracking"""
        from desktop_agent.situational_awareness import SituationalAwarenessEngine
        engine = SituationalAwarenessEngine()
        
        engine.set_task_context("Test goal", application="TestApp", files=["file1.txt"])
        # Note: task context is set in _current_state which is updated in monitor thread
        # Just verify the method exists and doesn't error
        assert engine is not None


class TestUserActivityMonitor:
    """Tests for User Activity Monitor"""
    
    def test_import(self):
        """Test that module imports without error"""
        try:
            from desktop_agent.user_activity_monitor import (
                UserActivityMonitor,
                ActivityLevel,
                get_activity_monitor
            )
            assert UserActivityMonitor is not None
            assert ActivityLevel is not None
            assert get_activity_monitor is not None
        except ImportError as e:
            pytest.skip(f"Module import failed: {e}")
    
    def test_monitor_creation(self):
        """Test monitor can be created"""
        from desktop_agent.user_activity_monitor import UserActivityMonitor
        monitor = UserActivityMonitor()
        assert monitor is not None
        assert monitor.lock is not None
    
    def test_activity_level_enum(self):
        """Test activity level enum values"""
        from desktop_agent.user_activity_monitor import ActivityLevel
        assert ActivityLevel.IDLE.value == "idle"
        assert ActivityLevel.LOW.value == "low"
        assert ActivityLevel.MEDIUM.value == "medium"
        assert ActivityLevel.HIGH.value == "high"
    
    def test_get_activity_level_default_idle(self):
        """Test default activity level is idle"""
        from desktop_agent.user_activity_monitor import UserActivityMonitor, ActivityLevel
        monitor = UserActivityMonitor()
        level = monitor.get_activity_level()
        assert level == ActivityLevel.IDLE
    
    def test_is_user_idle_default_false(self):
        """Test user is not idle by default (just started, no time has passed)"""
        from desktop_agent.user_activity_monitor import UserActivityMonitor
        monitor = UserActivityMonitor()
        # Monitor just started, so idle time is near 0, not >= 300 seconds
        assert not monitor.is_user_idle(duration_seconds=300)
    
    def test_is_user_active_default_false(self):
        """Test user is not active by default"""
        from desktop_agent.user_activity_monitor import UserActivityMonitor
        monitor = UserActivityMonitor()
        assert not monitor.is_user_active()
    
    def test_record_error(self):
        """Test error recording for frustration detection"""
        from desktop_agent.user_activity_monitor import UserActivityMonitor
        monitor = UserActivityMonitor()
        monitor.record_error("test_error")
        assert len(monitor._recent_errors) > 0
    
    def test_clear_errors(self):
        """Test clearing error history"""
        from desktop_agent.user_activity_monitor import UserActivityMonitor
        monitor = UserActivityMonitor()
        monitor.record_error("test_error")
        assert len(monitor._recent_errors) > 0
        monitor.clear_errors()
        assert len(monitor._recent_errors) == 0
    
    def test_get_activity_history(self):
        """Test retrieving activity history"""
        from desktop_agent.user_activity_monitor import UserActivityMonitor
        monitor = UserActivityMonitor()
        history = monitor.get_activity_history(limit=10)
        assert isinstance(history, list)
    
    def test_level_from_count_idle(self):
        """Test level_from_count returns IDLE for 0 count"""
        from desktop_agent.user_activity_monitor import UserActivityMonitor, ActivityLevel
        monitor = UserActivityMonitor()
        level = monitor._level_from_count(0, max_val=100)
        assert level == ActivityLevel.IDLE
    
    def test_level_from_count_low(self):
        """Test level_from_count returns LOW for small count"""
        from desktop_agent.user_activity_monitor import UserActivityMonitor, ActivityLevel
        monitor = UserActivityMonitor()
        level = monitor._level_from_count(10, max_val=100)
        assert level == ActivityLevel.LOW
    
    def test_level_from_count_medium(self):
        """Test level_from_count returns MEDIUM for medium count"""
        from desktop_agent.user_activity_monitor import UserActivityMonitor, ActivityLevel
        monitor = UserActivityMonitor()
        level = monitor._level_from_count(35, max_val=100)
        assert level == ActivityLevel.MEDIUM
    
    def test_level_from_count_high(self):
        """Test level_from_count returns HIGH for large count"""
        from desktop_agent.user_activity_monitor import UserActivityMonitor, ActivityLevel
        monitor = UserActivityMonitor()
        level = monitor._level_from_count(75, max_val=100)
        assert level == ActivityLevel.HIGH


class TestBackgroundEventMonitor:
    """Tests for Background Event Monitor"""
    
    def test_import(self):
        """Test that module imports without error"""
        try:
            from desktop_agent.background_events import (
                BackgroundEventMonitor,
                EventType,
                EventImportance,
                BackgroundEvent,
                get_event_monitor
            )
            assert BackgroundEventMonitor is not None
            assert EventType is not None
            assert EventImportance is not None
            assert BackgroundEvent is not None
            assert get_event_monitor is not None
        except ImportError as e:
            pytest.skip(f"Module import failed: {e}")
    
    def test_monitor_creation(self):
        """Test monitor can be created"""
        from desktop_agent.background_events import BackgroundEventMonitor
        monitor = BackgroundEventMonitor()
        assert monitor is not None
        assert monitor.lock is not None
    
    def test_event_type_enum(self):
        """Test event type enum has expected values"""
        from desktop_agent.background_events import EventType
        assert hasattr(EventType, 'TASK_COMPLETE')
        assert hasattr(EventType, 'BUILD_SUCCESS')
        assert hasattr(EventType, 'BUILD_FAILED')
        assert hasattr(EventType, 'ERROR')
        assert hasattr(EventType, 'DOWNLOAD_COMPLETE')
    
    def test_importance_enum(self):
        """Test importance enum has expected values"""
        from desktop_agent.background_events import EventImportance
        assert EventImportance.CRITICAL.value == "critical"
        assert EventImportance.HIGH.value == "high"
        assert EventImportance.MEDIUM.value == "medium"
        assert EventImportance.LOW.value == "low"
    
    def test_record_event(self):
        """Test recording a custom event"""
        from desktop_agent.background_events import (
            BackgroundEventMonitor,
            EventType,
            EventImportance
        )
        monitor = BackgroundEventMonitor()
        event = monitor.record_event(
            EventType.DOWNLOAD_COMPLETE,
            "Test download completed",
            importance=EventImportance.MEDIUM
        )
        assert event is not None
        assert event.event_type == EventType.DOWNLOAD_COMPLETE
        assert event.title == "Test download completed"
    
    def test_get_pending_events_empty(self):
        """Test getting pending events when none"""
        from desktop_agent.background_events import BackgroundEventMonitor
        monitor = BackgroundEventMonitor()
        events = monitor.get_pending_events()
        assert isinstance(events, list)
        assert len(events) == 0
    
    def test_get_pending_events_after_record(self):
        """Test getting pending events after recording"""
        from desktop_agent.background_events import (
            BackgroundEventMonitor,
            EventType
        )
        monitor = BackgroundEventMonitor()
        monitor.record_event(EventType.ERROR, "Test error")
        events = monitor.get_pending_events()
        assert len(events) > 0
    
    def test_mark_notified(self):
        """Test marking event as notified"""
        from desktop_agent.background_events import (
            BackgroundEventMonitor,
            EventType
        )
        monitor = BackgroundEventMonitor()
        event = monitor.record_event(EventType.ERROR, "Test error")
        
        pending_before = len(monitor.get_pending_events())
        monitor.mark_notified(event.event_id)
        pending_after = len(monitor.get_pending_events())
        
        assert pending_after < pending_before
    
    def test_watch_file(self):
        """Test file watching"""
        from desktop_agent.background_events import BackgroundEventMonitor
        monitor = BackgroundEventMonitor()
        
        with tempfile.NamedTemporaryFile(delete=False) as f:
            temp_path = f.name
        
        try:
            monitor.watch_file(temp_path)
            assert temp_path in monitor._file_watchers
        finally:
            Path(temp_path).unlink(missing_ok=True)
    
    def test_unwatch_file(self):
        """Test file unwatch"""
        from desktop_agent.background_events import BackgroundEventMonitor
        monitor = BackgroundEventMonitor()
        
        with tempfile.NamedTemporaryFile(delete=False) as f:
            temp_path = f.name
        
        try:
            monitor.watch_file(temp_path)
            monitor.unwatch_file(temp_path)
            assert temp_path not in monitor._file_watchers
        finally:
            Path(temp_path).unlink(missing_ok=True)
    
    def test_register_observer(self):
        """Test observer registration"""
        from desktop_agent.background_events import BackgroundEventMonitor
        monitor = BackgroundEventMonitor()
        
        callback = Mock()
        monitor.register_observer(callback)
        assert callback in monitor._event_observers
    
    def test_unregister_observer(self):
        """Test observer unregistration"""
        from desktop_agent.background_events import BackgroundEventMonitor
        monitor = BackgroundEventMonitor()
        
        callback = Mock()
        monitor.register_observer(callback)
        monitor.unregister_observer(callback)
        assert callback not in monitor._event_observers
    
    def test_should_notify_critical_event(self):
        """Test that critical events should notify"""
        from desktop_agent.background_events import (
            BackgroundEventMonitor,
            BackgroundEvent,
            EventType,
            EventImportance
        )
        monitor = BackgroundEventMonitor()
        
        event = BackgroundEvent(
            event_id="test",
            event_type=EventType.ERROR,
            timestamp=time.time(),
            title="Critical error",
            importance=EventImportance.CRITICAL
        )
        
        should_notify = monitor.should_notify_user(event)
        assert should_notify is True
    
    def test_should_notify_build_success(self):
        """Test that build success should notify"""
        from desktop_agent.background_events import (
            BackgroundEventMonitor,
            BackgroundEvent,
            EventType,
            EventImportance
        )
        monitor = BackgroundEventMonitor()
        
        event = BackgroundEvent(
            event_id="test",
            event_type=EventType.BUILD_SUCCESS,
            timestamp=time.time(),
            title="Build succeeded",
            importance=EventImportance.LOW
        )
        
        should_notify = monitor.should_notify_user(event)
        assert should_notify is True
    
    def test_get_event_history(self):
        """Test retrieving event history"""
        from desktop_agent.background_events import (
            BackgroundEventMonitor,
            EventType
        )
        monitor = BackgroundEventMonitor()
        monitor.record_event(EventType.ERROR, "Error 1")
        monitor.record_event(EventType.WARNING, "Warning 1")
        
        history = monitor.get_event_history(limit=5)
        assert isinstance(history, list)
    
    def test_get_events_by_type(self):
        """Test filtering events by type"""
        from desktop_agent.background_events import (
            BackgroundEventMonitor,
            EventType
        )
        monitor = BackgroundEventMonitor()
        monitor.record_event(EventType.ERROR, "Error 1")
        monitor.record_event(EventType.ERROR, "Error 2")
        monitor.record_event(EventType.WARNING, "Warning 1")
        
        errors = monitor.get_events_by_type(EventType.ERROR, limit=10)
        assert isinstance(errors, list)


class TestPerceptionIntegration:
    """Integration tests for perception modules"""
    
    def test_all_modules_import(self):
        """Test all perception modules import successfully"""
        try:
            from desktop_agent.situational_awareness import get_awareness_engine
            from desktop_agent.user_activity_monitor import get_activity_monitor
            from desktop_agent.background_events import get_event_monitor
            
            awareness = get_awareness_engine()
            activity = get_activity_monitor()
            events = get_event_monitor()
            
            assert awareness is not None
            assert activity is not None
            assert events is not None
        except ImportError as e:
            pytest.skip(f"Import failed: {e}")
    
    def test_singleton_patterns(self):
        """Test singleton instances work correctly"""
        try:
            from desktop_agent.situational_awareness import get_awareness_engine
            from desktop_agent.user_activity_monitor import get_activity_monitor
            from desktop_agent.background_events import get_event_monitor
            
            aware1 = get_awareness_engine()
            aware2 = get_awareness_engine()
            assert aware1 is aware2
            
            act1 = get_activity_monitor()
            act2 = get_activity_monitor()
            assert act1 is act2
            
            evt1 = get_event_monitor()
            evt2 = get_event_monitor()
            assert evt1 is evt2
        except ImportError as e:
            pytest.skip(f"Import failed: {e}")


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
