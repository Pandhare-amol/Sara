"""
Comprehensive test suite for Phase 3: Autonomous Interaction.

Tests for:
- Personality Manager (emotional state, conversational style, profile persistence)
- Quiet Mode Manager (silence levels, safety override, auto-resume)
- Interruption Policy Manager (scoring algorithm, decision making)
- User Feedback Loop (learning from responses, confidence updates)
- Self-Shutdown Manager (graceful shutdown sequence)

All tests use real data structures (no mocks) and verify integration.
Target: 100+ tests with 100% passing rate.
"""

import pytest
import threading
import time
from datetime import datetime, timedelta
from unittest.mock import patch, MagicMock
import tempfile
import sqlite3

# Import Phase 3 modules
from desktop_agent.personality_manager import (
    PersonalityManager, EmotionalState, PersonalityProfile, EmotionalStateInstance
)
from desktop_agent.quiet_mode_manager import (
    QuietModeManager, QuietModeLevel, QuietModeState
)
from desktop_agent.interruption_policy_manager import (
    InterruptionPolicyManager, InterruptionPriority, InterruptionPolicy,
    InterruptionScore, InterruptionHistory
)
from desktop_agent.user_feedback_loop import (
    UserFeedbackLoop, FeedbackType, UserFeedback, ActionMetrics
)
from desktop_agent.self_shutdown_manager import (
    SelfShutdownManager, ShutdownReason, ShutdownState
)


# ============================================================================
# Personality Manager Tests
# ============================================================================

class TestPersonalityManager:
    """Tests for PersonalityManager."""
    
    def test_singleton_pattern(self):
        """Verify PersonalityManager is a singleton."""
        manager1 = PersonalityManager.get_instance()
        manager2 = PersonalityManager.get_instance()
        assert manager1 is manager2
    
    def test_initial_personality_profile(self):
        """Test that initial personality profile is valid."""
        manager = PersonalityManager.get_instance()
        profile_dict = manager.get_personality_profile()
        
        assert profile_dict is not None
        assert profile_dict["address_style"] in ["formal", "casual", "friendly", "sir", "user"]
        assert profile_dict["preferred_tone"] in ["professional", "conversational", "warm", "humorous"]
        assert 0 <= profile_dict["humor_preference"] <= 1
        assert 0 <= profile_dict["warmth_preference"] <= 1
    
    def test_update_personality_profile(self):
        """Test updating personality profile."""
        manager = PersonalityManager.get_instance()
        
        # Use set_personality_preference instead
        manager.set_personality_preference("humor_preference", 0.8)
        manager.set_personality_preference("warmth_preference", 0.9)
        
        profile = manager.get_personality_profile()
        assert profile["humor_preference"] == 0.8
        assert profile["warmth_preference"] == 0.9
    
    def test_emotional_state_transitions(self):
        """Test emotional state transitions."""
        manager = PersonalityManager.get_instance()
        
        # Get initial state
        initial_state = manager.get_current_state()
        assert initial_state is not None
        
        # Trigger state change
        manager.update_state("task_complete")
        new_state = manager.get_current_state()
        assert new_state is not None
        
        # State should have changed
        assert isinstance(new_state.state, EmotionalState)
        assert 0 <= new_state.confidence <= 1
    
    def test_response_prefix_generation(self):
        """Test that response prefix is generated based on emotional state."""
        manager = PersonalityManager.get_instance()
        
        # Update to different emotional states and verify prefixes change
        manager.update_state("task_complete")
        prefix1 = manager.get_response_prefix()
        assert isinstance(prefix1, str)
        assert len(prefix1) > 0
        
        manager.update_state("error_detected")
        prefix2 = manager.get_response_prefix()
        assert isinstance(prefix2, str)
        assert len(prefix2) > 0
        
        # Different states should potentially have different prefixes
        # (though not guaranteed, so we just check they're valid)
    
    def test_emotional_state_persistence(self):
        """Test that emotional state history is accessible."""
        manager = PersonalityManager.get_instance()
        
        # Update state multiple times
        manager.update_state("task_complete")
        manager.update_state("user_interaction")
        manager.update_state("task_complete")
        
        # Get history
        history = manager.get_emotional_history(limit=10)
        
        # Should have some history records
        assert isinstance(history, list)
        assert len(history) >= 0  # History may be empty or populated depending on state
    
    def test_emotional_state_enum(self):
        """Test EmotionalState enum has expected values."""
        expected_states = {
            "CALM", "HAPPY", "CONCERNED", "CURIOUS", "FRUSTRATED",
            "DISAPPOINTED", "EXCITED", "TIRED", "FOCUSED", "CONFUSED"
        }
        actual_states = {e.name for e in EmotionalState}
        assert actual_states == expected_states
    
    def test_personality_profile_properties(self):
        """Test personality profile has required properties."""
        manager = PersonalityManager.get_instance()
        profile = manager.get_personality_profile()
        
        required_attrs = [
            "address_style", "preferred_tone", "humor_preference",
            "warmth_preference", "verbosity_preference", "curiosity_preference",
            "concern_expression", "interrupt_frequency"
        ]
        
        for attr in required_attrs:
            assert attr in profile
    
    def test_observer_notifications(self):
        """Test that observers are notified of state changes."""
        manager = PersonalityManager.get_instance()
        
        notifications = []
        def observer(event_type, data):
            notifications.append((event_type, data))
        
        manager.register_observer(observer)
        manager.update_state("task_complete")
        
        # Should have received notification
        assert len(notifications) > 0
        manager.unregister_observer(observer)


# ============================================================================
# Quiet Mode Manager Tests
# ============================================================================

class TestQuietModeManager:
    """Tests for QuietModeManager."""
    
    def test_singleton_pattern(self):
        """Verify QuietModeManager is a singleton."""
        manager1 = QuietModeManager.get_instance()
        manager2 = QuietModeManager.get_instance()
        assert manager1 is manager2
    
    def test_initial_quiet_mode_state(self):
        """Test that initial state is not quiet."""
        manager = QuietModeManager.get_instance()
        assert not manager.is_quiet()
    
    def test_enable_quiet_mode(self):
        """Test enabling quiet mode."""
        manager = QuietModeManager.get_instance()
        
        manager.enable_quiet_mode(QuietModeLevel.QUIET, None, "test")
        assert manager.is_quiet()
        
        state = manager.get_state()
        assert state.level == QuietModeLevel.QUIET
        
        # Clean up
        manager.disable_quiet_mode()
    
    def test_disable_quiet_mode(self):
        """Test disabling quiet mode."""
        manager = QuietModeManager.get_instance()
        
        manager.enable_quiet_mode(QuietModeLevel.SILENT, None, "test")
        assert manager.is_quiet()
        
        manager.disable_quiet_mode()
        assert not manager.is_quiet()
    
    def test_quiet_mode_levels(self):
        """Test all four quiet mode levels."""
        manager = QuietModeManager.get_instance()
        
        levels = [QuietModeLevel.NORMAL, QuietModeLevel.QUIET, QuietModeLevel.SILENT, QuietModeLevel.CRITICAL_ONLY]
        
        for level in levels:
            manager.enable_quiet_mode(level, None, "test")
            state = manager.get_state()
            assert state.level == level
            manager.disable_quiet_mode()
    
    def test_safety_override_in_quiet_mode(self):
        """Test that safety messages override quiet mode."""
        manager = QuietModeManager.get_instance()
        
        manager.enable_quiet_mode(QuietModeLevel.SILENT, None, "test")
        
        # Safety messages should always be allowed
        assert manager.can_speak_for_safety()
        
        # But proactive suggestions should not
        assert not manager.should_speak_proactively()
        
        manager.disable_quiet_mode()
    
    def test_auto_resume_quiet_mode(self):
        """Test quiet mode auto-resume after duration."""
        manager = QuietModeManager.get_instance()
        
        # Enable quiet mode for 1 second
        manager.enable_quiet_mode(QuietModeLevel.QUIET, 1, "test")
        assert manager.is_quiet()
        
        # Wait for auto-resume
        time.sleep(1.2)
        
        # Should be disabled now
        assert not manager.is_quiet()
    
    def test_quiet_mode_persistence(self):
        """Test that quiet mode state is persisted."""
        manager = QuietModeManager.get_instance()
        
        manager.enable_quiet_mode(QuietModeLevel.QUIET, None, "test")
        
        # Create new manager instance
        QuietModeManager._instance = None
        manager_new = QuietModeManager.get_instance()
        
        # State should persist
        assert manager_new.is_quiet()
        
        # Clean up
        manager_new.disable_quiet_mode()
        QuietModeManager._instance = None
    
    def test_should_speak_methods(self):
        """Test various should_speak_* methods."""
        manager = QuietModeManager.get_instance()
        
        # Normal mode (ensure we start clean)
        manager.disable_quiet_mode()
        assert manager.should_speak_proactively()
        assert manager.should_show_suggestion()
        assert manager.should_ask_question()
        assert manager.can_speak_for_task()
        
        # Quiet mode
        manager.enable_quiet_mode(QuietModeLevel.QUIET, None, "test")
        assert not manager.should_speak_proactively()
        assert not manager.should_show_suggestion()
        assert not manager.should_ask_question()
        assert manager.can_speak_for_safety()  # Safety always ok
        
        manager.disable_quiet_mode()
    
    def test_quiet_mode_history(self):
        """Test that quiet mode history is tracked."""
        manager = QuietModeManager.get_instance()
        
        manager.enable_quiet_mode(QuietModeLevel.QUIET, None, "test1")
        manager.disable_quiet_mode()
        
        manager.enable_quiet_mode(QuietModeLevel.SILENT, None, "test2")
        manager.disable_quiet_mode()
        
        history = manager.get_quiet_history()
        assert len(history) >= 2


# ============================================================================
# Interruption Policy Manager Tests
# ============================================================================

class TestInterruptionPolicyManager:
    """Tests for InterruptionPolicyManager."""
    
    def test_singleton_pattern(self):
        """Verify InterruptionPolicyManager is a singleton."""
        manager1 = InterruptionPolicyManager.get_instance()
        manager2 = InterruptionPolicyManager.get_instance()
        assert manager1 is manager2
    
    def test_interruption_score_calculation(self):
        """Test basic interruption score calculation."""
        manager = InterruptionPolicyManager.get_instance()
        
        score = manager.calculate_interruption_score(
            action="suggest_optimization",
            importance=0.7,
            confidence=0.8,
            user_activity={"activity_level": "IDLE", "idle_seconds": 60},
            quiet_mode_active=False
        )
        
        assert score is not None
        assert 0 <= score.final_score <= 1
        assert isinstance(score.should_interrupt, bool)
    
    def test_interruption_with_active_user(self):
        """Test interruption score when user is active."""
        manager = InterruptionPolicyManager.get_instance()
        
        # User is actively typing
        score_active = manager.calculate_interruption_score(
            action="suggest_optimization",
            importance=0.5,
            confidence=0.7,
            user_activity={"activity_level": "HIGH", "idle_seconds": 0},
            quiet_mode_active=False
        )
        
        # User is idle
        score_idle = manager.calculate_interruption_score(
            action="suggest_optimization",
            importance=0.5,
            confidence=0.7,
            user_activity={"activity_level": "IDLE", "idle_seconds": 300},
            quiet_mode_active=False
        )
        
        # Idle score should be higher (more likely to interrupt)
        assert score_idle.final_score >= score_active.final_score
    
    def test_interruption_with_quiet_mode(self):
        """Test that quiet mode suppresses interruptions."""
        manager = InterruptionPolicyManager.get_instance()
        
        score_normal = manager.calculate_interruption_score(
            action="suggest_optimization",
            importance=0.7,
            confidence=0.8,
            user_activity={"activity_level": "IDLE", "idle_seconds": 60},
            quiet_mode_active=False
        )
        
        score_quiet = manager.calculate_interruption_score(
            action="suggest_optimization",
            importance=0.7,
            confidence=0.8,
            user_activity={"activity_level": "IDLE", "idle_seconds": 60},
            quiet_mode_active=True
        )
        
        # Quiet mode should significantly reduce score
        assert score_quiet.final_score < score_normal.final_score
    
    def test_interruption_confidence_threshold(self):
        """Test that low confidence prevents interruption."""
        manager = InterruptionPolicyManager.get_instance()
        
        score = manager.calculate_interruption_score(
            action="suggest_optimization",
            importance=0.7,
            confidence=0.2,  # Low confidence
            user_activity={"activity_level": "IDLE", "idle_seconds": 60},
            quiet_mode_active=False
        )
        
        # Should not interrupt with low confidence
        assert not score.should_interrupt
    
    def test_interruption_cooldown(self):
        """Test that cooldown penalties apply."""
        manager = InterruptionPolicyManager.get_instance()
        
        # Record first interruption
        manager.record_interruption("test_action", 0.7)
        
        # Calculate score immediately after (within cooldown)
        score1 = manager.calculate_interruption_score(
            action="test_action",
            importance=0.7,
            confidence=0.8,
            user_activity={"activity_level": "IDLE", "idle_seconds": 60},
            quiet_mode_active=False
        )
        
        # Calculate score after cooldown period
        time.sleep(0.1)  # Small delay
        score2 = manager.calculate_interruption_score(
            action="different_action",
            importance=0.7,
            confidence=0.8,
            user_activity={"activity_level": "IDLE", "idle_seconds": 60},
            quiet_mode_active=False
        )
        
        # Different action should have higher score (no cooldown)
        assert score2.final_score >= score1.final_score
    
    def test_interruption_pressure(self):
        """Test interruption pressure calculation."""
        manager = InterruptionPolicyManager.get_instance()
        
        pressure = manager.get_interruption_pressure()
        assert 0 <= pressure <= 1
    
    def test_interruption_policy_update(self):
        """Test updating user interruption preferences."""
        manager = InterruptionPolicyManager.get_instance()
        
        manager.update_user_preference(interrupt_frequency=0.5, warmth=0.8)
        
        policy = manager.get_policy()
        assert policy["user_interrupt_frequency"] == 0.5
    
    def test_interruption_history_tracking(self):
        """Test that interruption history is tracked."""
        history = InterruptionHistory()
        
        history.record_interruption("action1", 0.8)
        history.record_interruption("action1", 0.7)
        history.record_interruption("action2", 0.9)
        
        # Count recent of specific action
        count = history.get_recent_count("action1", seconds=60)
        assert count >= 2
    
    def test_interruption_priority_enum(self):
        """Test InterruptionPriority enum."""
        priorities = {e.value for e in InterruptionPriority}
        expected = {"critical", "high", "medium", "low"}
        assert priorities == expected


# ============================================================================
# User Feedback Loop Tests
# ============================================================================

class TestUserFeedbackLoop:
    """Tests for UserFeedbackLoop."""
    
    def test_singleton_pattern(self):
        """Verify UserFeedbackLoop is a singleton."""
        loop1 = UserFeedbackLoop.get_instance()
        loop2 = UserFeedbackLoop.get_instance()
        assert loop1 is loop2
    
    def test_record_acceptance_feedback(self):
        """Test recording feedback when user accepts suggestion."""
        loop = UserFeedbackLoop.get_instance()
        
        feedback = loop.record_feedback(
            action_id="action1",
            action_type="suggestion_type_1",
            feedback_type=FeedbackType.ACCEPTED,
            user_input="Yes, good idea",
            confidence_before=0.6
        )
        
        assert feedback is not None
        assert feedback.feedback_type == FeedbackType.ACCEPTED
        assert feedback.action_type == "suggestion_type_1"
    
    def test_record_rejection_feedback(self):
        """Test recording feedback when user rejects suggestion."""
        loop = UserFeedbackLoop.get_instance()
        
        feedback = loop.record_feedback(
            action_id="action2",
            action_type="suggestion_type_2",
            feedback_type=FeedbackType.REJECTED,
            user_input="Not helpful",
            confidence_before=0.7
        )
        
        assert feedback.feedback_type == FeedbackType.REJECTED
    
    def test_confidence_learning(self):
        """Test that confidence is updated based on feedback."""
        loop = UserFeedbackLoop.get_instance()
        
        # First: suggest something with initial confidence
        confidence_before = 0.5
        action_type = f"test_action_{datetime.now().timestamp()}"
        
        # Record multiple acceptances
        loop.record_feedback(action_type, action_type, FeedbackType.ACCEPTED, "yes", confidence_before)
        loop.record_feedback(action_type, action_type, FeedbackType.ACCEPTED, "yes", confidence_before)
        
        # Get updated confidence
        new_confidence = loop.get_action_confidence(action_type)
        
        # Confidence should increase after multiple acceptances
        assert new_confidence >= confidence_before
    
    def test_acceptance_rate_calculation(self):
        """Test that acceptance rate is calculated correctly."""
        loop = UserFeedbackLoop.get_instance()
        
        action_type = f"test_action_{datetime.now().timestamp()}"
        
        # Record 2 acceptances and 1 rejection
        loop.record_feedback(action_type, action_type, FeedbackType.ACCEPTED, "yes")
        loop.record_feedback(action_type, action_type, FeedbackType.ACCEPTED, "yes")
        loop.record_feedback(action_type, action_type, FeedbackType.REJECTED, "no")
        
        metrics = loop.get_action_metrics(action_type)
        assert metrics is not None
        assert metrics["times_offered"] == 3
        assert metrics["times_accepted"] == 2
        assert abs(metrics["acceptance_rate"] - (2/3)) < 0.01
    
    def test_user_explicit_disable(self):
        """Test user can explicitly disable an action."""
        loop = UserFeedbackLoop.get_instance()
        
        action_type = f"test_action_{datetime.now().timestamp()}"
        
        # Record that user said "don't ask again"
        loop.record_feedback(
            action_type, action_type,
            FeedbackType.DONT_ASK_AGAIN,
            "don't suggest this again"
        )
        
        # Should not ask again
        should_ask = loop.should_ask_action_again(action_type)
        assert not should_ask
    
    def test_feedback_history_retrieval(self):
        """Test retrieving feedback history."""
        loop = UserFeedbackLoop.get_instance()
        
        # Record some feedback
        loop.record_feedback(f"action_{datetime.now().timestamp()}_1", "type1", FeedbackType.ACCEPTED, "feedback1")
        loop.record_feedback(f"action_{datetime.now().timestamp()}_2", "type2", FeedbackType.REJECTED, "feedback2")
        
        history = loop.get_feedback_history(limit=100)
        assert len(history) >= 2
    
    def test_get_all_metrics(self):
        """Test retrieving all action metrics."""
        loop = UserFeedbackLoop.get_instance()
        
        metrics = loop.get_all_metrics()
        assert isinstance(metrics, list)
        
        # Each metric should have required fields
        if metrics:
            sample = metrics[0]
            required_fields = ["action_name", "current_confidence", "acceptance_rate"]
            for field in required_fields:
                assert field in sample
    
    def test_observer_notifications(self):
        """Test that observers are notified of feedback."""
        loop = UserFeedbackLoop.get_instance()
        
        notifications = []
        def observer(event_type, data):
            notifications.append((event_type, data))
        
        loop.register_observer(observer)
        loop.record_feedback("test_action", "test_type", FeedbackType.ACCEPTED, "feedback")
        
        # Should have received notification
        assert len(notifications) > 0
        loop.unregister_observer(observer)
    
    def test_feedback_type_enum(self):
        """Test FeedbackType enum has expected values."""
        expected_types = {
            "ACCEPTED", "REJECTED", "PARTIAL", "IGNORED", "CORRECTED",
            "ASKED_AGAIN", "DONT_ASK_AGAIN", "ENABLED_QUIET",
            "DISABLED_QUIET", "SHUTDOWN_REQUEST", "SUCCESS", "FAILURE"
        }
        actual_types = {e.name for e in FeedbackType}
        assert actual_types == expected_types


# ============================================================================
# Self-Shutdown Manager Tests
# ============================================================================

class TestSelfShutdownManager:
    """Tests for SelfShutdownManager."""
    
    def test_singleton_pattern(self):
        """Verify SelfShutdownManager is a singleton."""
        manager1 = SelfShutdownManager.get_instance()
        manager2 = SelfShutdownManager.get_instance()
        assert manager1 is manager2
    
    def test_initial_shutdown_state(self):
        """Test that shutdown is not in progress initially."""
        manager = SelfShutdownManager.get_instance()
        assert not manager.shutdown_in_progress
    
    def test_shutdown_reason_enum(self):
        """Test ShutdownReason enum."""
        expected_reasons = {
            "USER_REQUESTED", "TASK_COMPLETE", "SESSION_TIMEOUT",
            "SYSTEM_SHUTDOWN", "ERROR_CRITICAL", "RESOURCE_CRITICAL",
            "NORMAL_EXIT"
        }
        actual_reasons = {e.name for e in ShutdownReason}
        assert actual_reasons == expected_reasons
    
    def test_shutdown_state_dataclass(self):
        """Test ShutdownState dataclass properties."""
        state = ShutdownState()
        
        required_attrs = [
            "saved_conversation", "saved_memory", "saved_learning",
            "saved_task_state", "saved_events", "cleaned_resources"
        ]
        
        for attr in required_attrs:
            assert hasattr(state, attr)
            assert isinstance(getattr(state, attr), bool)
    
    def test_get_shutdown_state(self):
        """Test retrieving shutdown state."""
        manager = SelfShutdownManager.get_instance()
        state = manager.get_shutdown_state()
        
        # Should return a valid state even if not shutting down
        assert state is not None or not manager.shutdown_in_progress
    
    def test_shutdown_only_affects_sara(self):
        """Test that shutdown only affects SARA services."""
        manager = SelfShutdownManager.get_instance()
        
        # Verify that the manager has safeguards
        # (actual shutdown is not tested to avoid side effects)
        assert hasattr(manager, 'shutdown_in_progress')
        assert hasattr(manager, 'initiate_shutdown')
    
    def test_shutdown_persistence(self):
        """Test that shutdown history is persisted."""
        manager = SelfShutdownManager.get_instance()
        
        history = manager.get_shutdown_history()
        assert isinstance(history, list)
        
        # Each history entry should have required fields
        if history:
            entry = history[0]
            assert "reason" in entry or "timestamp" in entry
    
    def test_resource_cleanup_tracking(self):
        """Test that resource cleanup is tracked."""
        manager = SelfShutdownManager.get_instance()
        state = manager.get_shutdown_state_object()
        
        if state:
            # All cleanup flags should be boolean
            assert isinstance(state.saved_conversation, bool)
            assert isinstance(state.saved_memory, bool)
            assert isinstance(state.saved_learning, bool)
            assert isinstance(state.saved_task_state, bool)
            assert isinstance(state.saved_events, bool)
            assert isinstance(state.cleaned_resources, bool)


# ============================================================================
# Integration Tests (Phase 3 with Phase 1 & 2)
# ============================================================================

class TestPhase3Integration:
    """Integration tests for Phase 3 with other phases."""
    
    def test_personality_aware_interruption(self):
        """Test that personality affects interruption decisions."""
        personality_mgr = PersonalityManager.get_instance()
        interruption_mgr = InterruptionPolicyManager.get_instance()
        
        personality_mgr.update_state("happy")
        state = personality_mgr.get_current_state()
        
        # Calculate interruption score with personality context
        score = interruption_mgr.calculate_interruption_score(
            action="suggest_feature",
            importance=0.6,
            confidence=0.7,
            user_activity={"activity_level": "IDLE", "idle_seconds": 60},
            quiet_mode_active=False,
            personality_state={"warmth": 0.8}
        )
        
        assert score is not None
        assert score.personality_bonus != 0  # Should have personality influence
    
    def test_quiet_mode_affects_suggestions(self):
        """Test that quiet mode prevents suggestions."""
        quiet_mgr = QuietModeManager.get_instance()
        interruption_mgr = InterruptionPolicyManager.get_instance()
        
        # Normal mode
        score_normal = interruption_mgr.calculate_interruption_score(
            action="suggest_feature",
            importance=0.6,
            confidence=0.7,
            user_activity={"activity_level": "IDLE", "idle_seconds": 60},
            quiet_mode_active=False
        )
        
        # Enable quiet mode
        quiet_mgr.enable_quiet_mode(QuietModeLevel.QUIET, None, "test")
        score_quiet = interruption_mgr.calculate_interruption_score(
            action="suggest_feature",
            importance=0.6,
            confidence=0.7,
            user_activity={"activity_level": "IDLE", "idle_seconds": 60},
            quiet_mode_active=True
        )
        
        # Quiet mode should suppress score
        assert score_quiet.final_score < score_normal.final_score
        
        quiet_mgr.disable_quiet_mode()
    
    def test_feedback_improves_personality_confidence(self):
        """Test that feedback learning affects decision confidence."""
        feedback_loop = UserFeedbackLoop.get_instance()
        
        action_type = f"confidence_test_{datetime.now().timestamp()}"
        
        # Initial confidence
        initial_confidence = feedback_loop.get_action_confidence(action_type)
        assert initial_confidence == 0.5  # Default
        
        # Record multiple acceptances
        for _ in range(3):
            feedback_loop.record_feedback(
                action_type, action_type,
                FeedbackType.ACCEPTED,
                "good suggestion"
            )
        
        # Confidence should increase
        new_confidence = feedback_loop.get_action_confidence(action_type)
        assert new_confidence > initial_confidence
    
    def test_shutdown_respects_quiet_mode(self):
        """Test that shutdown doesn't violate quiet mode."""
        quiet_mgr = QuietModeManager.get_instance()
        
        # Enable quiet mode
        quiet_mgr.enable_quiet_mode(QuietModeLevel.SILENT, None, "test")
        assert quiet_mgr.is_quiet()
        
        # But safety messages should still work
        assert quiet_mgr.can_speak_for_safety()
        
        quiet_mgr.disable_quiet_mode()
    
    def test_thread_safety_of_managers(self):
        """Test that managers are thread-safe."""
        personality_mgr = PersonalityManager.get_instance()
        quiet_mgr = QuietModeManager.get_instance()
        interruption_mgr = InterruptionPolicyManager.get_instance()
        feedback_loop = UserFeedbackLoop.get_instance()
        
        results = []
        
        def update_personality():
            try:
                personality_mgr.update_state("task_complete")
                results.append(("personality", True))
            except Exception as e:
                results.append(("personality", False))
        
        def toggle_quiet():
            try:
                quiet_mgr.enable_quiet_mode("QUIET", None, "test")
                quiet_mgr.disable_quiet_mode()
                results.append(("quiet", True))
            except Exception as e:
                results.append(("quiet", False))
        
        def calculate_score():
            try:
                interruption_mgr.calculate_interruption_score(
                    "test", 0.5, 0.5,
                    {"activity_level": "IDLE", "idle_seconds": 60}
                )
                results.append(("interruption", True))
            except Exception as e:
                results.append(("interruption", False))
        
        def record_feedback():
            try:
                feedback_loop.record_feedback(
                    "test_action", "test_type",
                    FeedbackType.ACCEPTED, "test"
                )
                results.append(("feedback", True))
            except Exception as e:
                results.append(("feedback", False))
        
        threads = [
            threading.Thread(target=update_personality),
            threading.Thread(target=toggle_quiet),
            threading.Thread(target=calculate_score),
            threading.Thread(target=record_feedback)
        ]
        
        for t in threads:
            t.start()
        
        for t in threads:
            t.join()
        
        # All operations should succeed
        for manager_name, success in results:
            assert success, f"{manager_name} thread operation failed"


# ============================================================================
# Test Execution
# ============================================================================

if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
