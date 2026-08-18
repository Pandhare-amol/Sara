# SARA Autonomous Desktop AGI Upgrade - Implementation Plan

**Status**: Phase 1 Planning & Architecture
**Date**: 2026-08-18
**Objective**: Transform SARA from command-driven assistant into real-world autonomous desktop AGI

## Executive Summary

This upgrade extends the existing SARA system (already containing cognitive modules, memory systems, and desktop automation) with autonomous perception, proactive reasoning, human-like interaction, and self-awareness capabilities.

All existing functionality, UI, APIs, and tools are preserved. The upgrade focuses on backend intelligence, real-world observability, and autonomous decision-making.

---

## Phase Overview

### ✅ PHASE 0: Foundation (Already Complete)
- Cognitive modules (working memory, episodic, semantic, procedural, autobiographical)
- Memory consolidation and learning
- Planning engine and strategy manager
- Desktop agent tool integration
- RAG system and reinforcement learning
- Verification engine with real-world state checking

### Phase 1: Autonomous Perception (THIS PHASE)
- Situational Awareness Engine
- Screen State Monitor
- User Activity Monitor
- Background Event Monitor

### Phase 2: Autonomous Reasoning
- Autonomous Decision Engine
- Conversation Manager
- Proactive Assistant
- Privacy Boundary & Memory Management

### Phase 3: Autonomous Interaction
- Personality Manager
- Emotional State Model
- Quiet Mode Manager
- Self-Shutdown Manager

### Phase 4: Advanced Features
- Human Workflow Learning
- Context Retriever enhancements
- Error Recovery System
- Learning Feedback Loop

### Phase 5: Integration & Testing
- End-to-end system testing
- Safety validation
- Performance optimization
- Production readiness

---

## Phase 1: Autonomous Perception Implementation

### 1.1 Situational Awareness Engine

**Purpose**: Maintain real-time structured representation of desktop state

**Location**: `desktop_agent/situational_awareness.py`

**Key Responsibilities**:
- Track active application, window, and screen state
- Monitor file system changes (watched directories)
- Track user interaction activity
- Maintain task and conversation context
- Detect important events (errors, notifications, dialogs)
- Persist state for context retention

**Data Structure**:
```python
@dataclass
class DesktopState:
    timestamp: float
    active_window: Optional[WindowInfo]
    active_application: Optional[str]
    open_applications: List[ApplicationInfo]
    visible_text: Dict[str, str]  # region -> text
    visible_dialogs: List[DialogInfo]
    recent_errors: List[ErrorInfo]
    keyboard_activity: ActivityLevel
    mouse_activity: ActivityLevel
    current_screen: int
    connected_monitors: int
    current_task: Optional[TaskContext]
    previous_task: Optional[TaskContext]
    user_interaction_timeout: bool
    important_files_open: List[str]
    potentially_destructive_action: Optional[str]
    system_warnings: List[str]
```

**Key Methods**:
- `snapshot()` - Capture current state
- `detect_changes()` - Compare with previous state
- `get_context()` - Return relevant context dict
- `watch_file_pattern(pattern)` - Start watching files
- `record_event(event_type, data)` - Record significant events

---

### 1.2 Screen State Monitor

**Purpose**: Track visual desktop content with real-world observation

**Location**: `desktop_agent/screen_monitor.py`

**Key Responsibilities**:
- Capture screen regions on demand
- Extract text via OCR
- Detect UI elements (buttons, dialogs, menus)
- Identify warning/error messages
- Track screen changes between snapshots
- Use accessibility APIs when available

**Key Methods**:
- `capture_region(x, y, width, height)` - Capture screen area
- `extract_text(region)` - OCR on region
- `detect_dialogs()` - Find dialog boxes
- `detect_warnings()` - Find warning messages
- `find_ui_element(description)` - Locate button/field
- `has_screen_changed()` - Detect visual change

---

### 1.3 User Activity Monitor

**Purpose**: Track real user interaction patterns

**Location**: `desktop_agent/user_activity_monitor.py`

**Key Responsibilities**:
- Monitor keyboard activity
- Monitor mouse activity
- Track typing patterns
- Detect idle periods
- Recognize user presence
- Calculate activity level and trends

**Data Structure**:
```python
@dataclass
class UserActivity:
    last_keyboard_time: float
    last_mouse_time: float
    keyboard_count_5m: int
    mouse_count_5m: int
    idle_seconds: float
    activity_level: str  # "high", "medium", "low", "idle"
    appears_frustrated: bool
    appears_focused: bool
    recent_errors_encountered: int
```

**Key Methods**:
- `get_current_activity()` - Current activity level
- `get_idle_duration()` - Seconds since last activity
- `has_user_paused(duration_ms)` - Check if paused
- `get_activity_trend()` - Recent activity pattern

---

### 1.4 Background Event Monitor

**Purpose**: Detect and track significant background events

**Location**: `desktop_agent/background_events.py`

**Key Responsibilities**:
- Monitor task completion
- Watch for application crashes
- Detect build/compile completion
- Track download completion
- Monitor file changes
- Detect notifications and system messages

**Event Types**:
```python
class EventType(Enum):
    TASK_COMPLETE = "task_complete"
    BUILD_SUCCESS = "build_success"
    BUILD_FAILED = "build_failed"
    TEST_FAILED = "test_failed"
    APPLICATION_CRASH = "application_crash"
    DOWNLOAD_COMPLETE = "download_complete"
    FILE_CHANGED = "file_changed"
    NOTIFICATION = "notification"
    WARNING = "warning"
    ERROR = "error"
    DIALOG_APPEARED = "dialog_appeared"
```

**Key Methods**:
- `register_watch(watch_type, condition)` - Register background watch
- `get_pending_events()` - Get new events since last check
- `should_notify_user(event)` - Determine notification importance
- `mark_event_notified(event)` - Record notification sent

---

## Implementation Priority

### Week 1 (NOW)
- [ ] Situational Awareness Engine core structure
- [ ] User Activity Monitor (keyboard/mouse hooks)
- [ ] Screen State Monitor (basic screenshot + OCR)
- [ ] Integration with existing desktop_agent
- [ ] Unit tests for each component

### Week 2
- [ ] Autonomous Decision Engine
- [ ] Conversation Manager
- [ ] Proactive Assistant
- [ ] Privacy Boundary implementation

### Week 3
- [ ] Personality Manager
- [ ] Emotional State Model
- [ ] Quiet Mode Manager
- [ ] Self-Shutdown handler

### Week 4
- [ ] Integration testing
- [ ] Performance optimization
- [ ] Safety validation
- [ ] Production testing

---

## Integration with Existing Systems

### Connection to Desktop Agent
```
SituationalAwarenessEngine
    ├── reads from: WindowInfo (via win32gui)
    ├── reads from: File system events
    ├── reads from: Active window/application
    └── updates: Desktop state snapshot
         ├── used by: Autonomous Decision Engine
         ├── used by: Proactive Assistant
         ├── used by: Conversation Manager
         └── stored in: Working Memory
```

### Connection to Memory & Cognitive Systems
```
SituationalAwareness + Background Events
    ├── input to: Autonomous Decision Engine
    ├── context for: Planning Engine
    ├── context for: Task Evaluator
    ├── learning input to: Memory Consolidator
    └── input to: RAG retrieval
```

### Connection to UI
```
Autonomous Decision Engine
    ├── output: Proactive suggestions (via websocket)
    ├── output: Conversation initiation (via UI)
    ├── output: Status updates (via UI)
    └── receives: User responses (via websocket)
```

---

## Real-World Behavior Requirements

All perception must be based on actual system state:

- ✅ Real keyboard/mouse hooks (not simulated)
- ✅ Real window/process detection (via win32gui, psutil)
- ✅ Real screen capture and OCR (via PyAutoGUI, Tesseract/EasyOCR)
- ✅ Real file system monitoring (via watchdog)
- ✅ Real application state checking (via accessibility APIs where available)
- ✅ Real task monitoring (via process inspection)
- ❌ NO fake activity generation
- ❌ NO simulated state
- ❌ NO hard-coded demonstrations

---

## Safety Guardrails

1. **No Privacy Violation**
   - Screen capture only on-demand or with explicit permission
   - OCR results never stored in logs unnecessarily
   - Activity monitoring respects user privacy settings

2. **No Performance Impact**
   - Event-driven monitoring (not continuous polling)
   - Bounded capture frequency (max 1 per second)
   - Efficient screen region analysis
   - Cached state to avoid redundant checks

3. **No Unsolicited Action**
   - All autonomous decisions must pass through decision engine
   - User authorization preserved
   - Confirmation required for high-impact actions
   - Decisions are logged and auditable

4. **No Fake Behavior**
   - All observations must come from real sensors
   - All state must be verified
   - Uncertain observations marked as such
   - Confidence thresholds applied before action

---

## Testing Strategy

### Unit Tests
- Each module tested in isolation
- Mock dependencies where appropriate
- Real system state for integration tests

### Integration Tests
- Perception components integrated with desktop_agent
- Decision engine receiving real state
- Full pipeline from observation to action

### Safety Tests
- Privacy boundary enforcement
- User authorization respected
- High-risk actions require confirmation
- No unexpected side effects

### Performance Tests
- CPU/memory impact under load
- Screenshot frequency limits
- OCR performance on large screens
- Event queue depth bounded

---

## Success Criteria

By end of Phase 1:
- ✅ Real-time desktop state tracking working
- ✅ Screen understanding implemented (text + UI detection)
- ✅ User activity monitoring operational
- ✅ Background events detected and queued
- ✅ Integration with existing systems verified
- ✅ All tests passing
- ✅ No UI changes, no existing functionality broken
- ✅ Performance acceptable

---

## Files to Create/Modify

### New Files
- `desktop_agent/situational_awareness.py` - Core awareness engine
- `desktop_agent/screen_monitor.py` - Screen capture and OCR
- `desktop_agent/user_activity_monitor.py` - Activity tracking
- `desktop_agent/background_events.py` - Event detection
- `desktop_agent/window_monitor.py` - Window/application tracking
- `tests/test_situational_awareness.py` - Unit tests
- `tests/test_screen_monitor.py` - Screen tests
- `tests/test_user_activity.py` - Activity tests

### Modified Files
- `desktop_agent/main.py` - Add perception module startup
- `desktop_agent/platform_core.py` - Integrate awareness engine
- `server.ts` - Add awareness endpoints
- `src/cognitive/orchestrator.ts` - Use awareness in planning

---

## Next Steps

1. **Now**: Review this plan with stakeholder
2. **Day 1**: Implement Situational Awareness Engine core
3. **Day 2**: Implement User Activity Monitor
4. **Day 3**: Implement Screen State Monitor
5. **Day 4**: Integrate with desktop_agent
6. **Day 5**: Unit and integration testing
7. **Week 2**: Autonomous Decision Engine
8. **Week 3+**: Remaining phases

---

## Key Principle

> **Real-world behavior emerges from real observations of real state.**

Every capability is grounded in actual system instrumentation, not simulated or fake behavior.
