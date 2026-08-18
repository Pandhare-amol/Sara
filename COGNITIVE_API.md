# SARA Cognitive Architecture API Reference

Complete API documentation for SARA's cognitive system endpoints.

## Overview

The Cognitive API provides 11 RESTful endpoints that expose SARA's multi-layer memory system, planning engine, strategy selection, and learning pipeline. All endpoints run through the core cognitive integration bridge which coordinates:

1. **Memory Retrieval** - Building context from all 4 memory engines
2. **Planning** - Creating hierarchical goal decomposition
3. **Execution** - Running tasks with strategy selection
4. **Evaluation** - Post-task assessment and reward signals
5. **Consolidation** - Learning patterns and generating skills

## Base URL

All endpoints are served from the Express.js backend:

```
http://localhost:3000/cognitive/
```

## Response Format

All endpoints follow a consistent response pattern:

### Success Response
```json
{
  "ok": true,
  "data": {...},
  "timestamp": "2024-01-15T10:30:45.123Z"
}
```

### Error Response
```json
{
  "ok": false,
  "error": "Description of what went wrong",
  "timestamp": "2024-01-15T10:30:45.123Z"
}
```

## Endpoints

### 1. POST `/cognitive/plan`

Creates a hierarchical plan for a goal using memory context and prior experience.

**Request:**
```bash
curl -X POST http://localhost:3000/cognitive/plan \
  -H "Content-Type: application/json" \
  -d '{
    "goal": "Organize desktop files by category",
    "projectContext": "Home Office Setup",
    "timeConstraint": 300000,
    "requireApproval": false
  }'
```

**Request Body:**
- `goal` (string, required) - The objective to plan for
- `projectContext` (string, optional) - Associated project name
- `timeConstraint` (number, optional) - Max time in milliseconds
- `requireApproval` (boolean, optional) - Require human approval

**Response:**
```json
{
  "ok": true,
  "plan": {
    "id": "plan-xyz123",
    "goal": "Organize desktop files by category",
    "steps": [
      {
        "id": "step-1",
        "index": 0,
        "goal": "Assess current state",
        "action": "List all files on desktop",
        "tool": "listFiles",
        "estimatedDuration": 5000,
        "critical": false,
        "verifiable": true,
        "expectedOutcome": "List of 10-50 files"
      },
      {
        "id": "step-2",
        "index": 1,
        "goal": "Create category folders",
        "action": "Create Documents, Images, Code, Other folders",
        "tool": "createFolder",
        "critical": true,
        "verifiable": true
      }
    ],
    "estimatedDuration": 180000,
    "confidence": 0.82,
    "strategy": "skill-based",
    "reasoning": {
      "selectedStrategy": "skill-based",
      "whyChosen": "Prior skill with file organization at 85% success rate",
      "risks": ["User intervention might slow progress"],
      "fallbacks": ["Manual categorization by date"]
    }
  }
}
```

**Status Codes:**
- `200 OK` - Plan created successfully
- `400 Bad Request` - Missing required `goal` parameter
- `500 Internal Server Error` - Server error during planning

---

### 2. POST `/cognitive/remember`

Stores facts, preferences, instructions, or other knowledge in semantic memory.

**Request:**
```bash
curl -X POST http://localhost:3000/cognitive/remember \
  -H "Content-Type: application/json" \
  -d '{
    "category": "user_preferences",
    "content": "User prefers organizing files alphabetically",
    "type": "preference",
    "significance": 7
  }'
```

**Request Body:**
- `category` (string, required) - Memory category (general, user, system, etc.)
- `content` (string, required) - The knowledge to remember
- `type` (string, required) - fact, preference, instruction, rule, or other
- `significance` (number, optional) - Importance 1-10 (default 5)

**Response:**
```json
{
  "ok": true,
  "memory": {
    "id": "mem-abc456",
    "category": "user_preferences",
    "type": "preference",
    "content": "User prefers organizing files alphabetically",
    "confidence": 1.0,
    "significance": 7,
    "createdAt": "2024-01-15T10:30:45.123Z",
    "references": 0
  }
}
```

**Status Codes:**
- `200 OK` - Memory stored
- `400 Bad Request` - Missing required fields
- `500 Internal Server Error` - Storage error

---

### 3. GET `/cognitive/memory/stats`

Returns statistics and summaries from all four memory engines.

**Request:**
```bash
curl http://localhost:3000/cognitive/memory/stats
```

**Response:**
```json
{
  "ok": true,
  "stats": {
    "episodic": {
      "count": 24,
      "oldest": "2024-01-01T00:00:00Z",
      "newest": "2024-01-15T10:30:45Z",
      "successRate": 0.875,
      "avgLessonCount": 2.3,
      "avgConfidence": 0.81
    },
    "semantic": {
      "count": 156,
      "byCategory": {
        "general": 45,
        "user_preferences": 32,
        "instructions": 28
      },
      "byType": {
        "fact": 89,
        "preference": 42,
        "rule": 25
      },
      "avgConfidence": 0.85,
      "contradictions": 2
    },
    "procedural": {
      "count": 18,
      "byCategory": {
        "file_management": 8,
        "automation": 6,
        "web_interaction": 4
      },
      "reliableSkills": 12,
      "unreliableSkills": 2,
      "avgSuccessRate": 0.79,
      "avgConfidence": 0.72
    },
    "autobiographical": {
      "count": 12,
      "activeProjects": 3,
      "recentEvents": 8,
      "importance": "7.2/10"
    },
    "timestamp": "2024-01-15T10:30:45.123Z"
  }
}
```

**Status Codes:**
- `200 OK` - Stats retrieved
- `500 Internal Server Error` - Retrieval error

---

### 4. GET `/cognitive/preferences`

Retrieves all learned user preferences and settings.

**Request:**
```bash
curl http://localhost:3000/cognitive/preferences
```

**Response:**
```json
{
  "ok": true,
  "preferences": [
    {
      "id": "pref-001",
      "content": "Prefer dark mode applications",
      "confidence": 0.95,
      "references": 12,
      "learned": true,
      "lastUsed": "2024-01-15T09:30:00Z"
    },
    {
      "id": "pref-002",
      "content": "Work in morning hours 8am-12pm",
      "confidence": 0.87,
      "references": 8,
      "learned": true
    }
  ],
  "totalPreferences": 2
}
```

---

### 5. GET `/cognitive/strategies`

Returns strategy statistics and selection data.

**Request:**
```bash
curl http://localhost:3000/cognitive/strategies
```

**Response:**
```json
{
  "ok": true,
  "stats": {
    "total": 15,
    "avgSuccessRate": 0.78,
    "avgConfidence": 0.72,
    "totalExecutions": 127,
    "explorationRate": 0.08,
    "exploitationRate": 0.92
  },
  "strategies": [
    {
      "id": "strat-file-org",
      "name": "File Organization - Skill Based",
      "goalType": "file_management",
      "successCount": 17,
      "failureCount": 3,
      "totalExecutions": 20,
      "successRate": 0.85,
      "confidence": 0.81,
      "avgDurationMs": 45000,
      "learningProgress": "Stable"
    }
  ]
}
```

---

### 6. GET `/cognitive/project/:project`

Retrieves context and history for a specific project.

**Request:**
```bash
curl http://localhost:3000/cognitive/project/SARA
```

**Response:**
```json
{
  "ok": true,
  "project": "SARA",
  "context": {
    "isActive": true,
    "lastAccessed": "2024-01-15T10:30:00Z",
    "episodesCount": 8,
    "successRate": 0.875,
    "learningProgress": "Strong",
    "associatedSkills": ["project setup", "file management", "testing"],
    "recentInsights": ["User favors command-line tools", "Prefers TypeScript over JavaScript"],
    "nextSteps": ["Set up CI/CD", "Add documentation"]
  }
}
```

---

### 7. POST `/cognitive/memory/consolidate`

Triggers the memory consolidation process, which analyzes episodes to learn skills and preferences.

**Request:**
```bash
curl -X POST http://localhost:3000/cognitive/memory/consolidate
```

**Response:**
```json
{
  "ok": true,
  "report": {
    "timestamp": "2024-01-15T10:30:45.123Z",
    "episodesAnalyzed": 24,
    "skillsGenerated": 3,
    "preferencesExtracted": 2,
    "contradictionsDetected": 1,
    "memoryArchivals": 5,
    "duration": 234,
    "details": [
      {
        "type": "skill",
        "title": "File Organization - Hierarchical",
        "successRate": 0.88,
        "episodeCount": 6
      },
      {
        "type": "preference",
        "title": "Morning work preference",
        "significance": 8,
        "confidence": 0.92
      }
    ]
  }
}
```

---

### 8. GET `/cognitive/work-summary?days=N`

Returns a natural language summary of recent work over N days.

**Request:**
```bash
curl "http://localhost:3000/cognitive/work-summary?days=7"
```

**Query Parameters:**
- `days` (number, optional) - Number of days to summarize (default: 1)

**Response:**
```json
{
  "ok": true,
  "days": 7,
  "summary": "Over the last 7 day(s), we worked on: SARA (cognitive modules development, 8 episodes, 87.5% success rate), Home Office Setup (file organization, 5 episodes, 80% success rate). Key insights: Morning hours most productive, TypeScript workflow optimized. Learned 2 new skills. 1 knowledge contradiction detected in file organization preferences."
}
```

---

### 9. GET `/cognitive/contradictions`

Lists detected contradictions in knowledge base.

**Request:**
```bash
curl http://localhost:3000/cognitive/contradictions
```

**Response:**
```json
{
  "ok": true,
  "contradictions": [
    {
      "id": "contra-001",
      "memory1": {
        "id": "mem-abc",
        "content": "Files should be organized by date",
        "type": "preference"
      },
      "memory2": {
        "id": "mem-def",
        "content": "Files should be organized by category",
        "type": "preference"
      },
      "severity": "medium",
      "detectedAt": "2024-01-15T09:30:00Z",
      "resolution": "pending"
    }
  ]
}
```

---

### 10. GET `/cognitive/active-projects`

Lists currently active projects being worked on.

**Request:**
```bash
curl http://localhost:3000/cognitive/active-projects
```

**Response:**
```json
{
  "ok": true,
  "projects": [
    {
      "name": "SARA",
      "lastAccessed": "2024-01-15T10:30:00Z",
      "episodeCount": 8,
      "successRate": 0.875,
      "priority": "high",
      "status": "active",
      "nextMilestone": "Integration testing"
    },
    {
      "name": "Home Office Setup",
      "lastAccessed": "2024-01-14T18:00:00Z",
      "episodeCount": 5,
      "successRate": 0.80,
      "priority": "medium",
      "status": "active"
    }
  ]
}
```

---

### 11. POST `/cognitive/task/execute`

Executes a complete task through the full cognitive pipeline: planning → execution → evaluation → learning.

**Request:**
```bash
curl -X POST http://localhost:3000/cognitive/task/execute \
  -H "Content-Type: application/json" \
  -d '{
    "taskId": "task-20240115-001",
    "goal": "Organize desktop files",
    "userInput": "Please organize all files on desktop into folders by type",
    "projectContext": "Home Office Setup",
    "maxDuration": 300000
  }'
```

**Request Body:**
- `taskId` (string, optional) - Unique task identifier
- `goal` (string, required) - The task objective
- `userInput` (string, required) - User description or instruction
- `projectContext` (string, optional) - Associated project
- `maxDuration` (number, optional) - Max execution time in ms
- `requireApproval` (boolean, optional) - Need approval before execution

**Response:**
```json
{
  "ok": true,
  "result": {
    "taskId": "task-20240115-001",
    "success": true,
    "goalAchieved": true,
    "durationMs": 47250,
    "plan": {
      "id": "plan-xyz",
      "steps": [...],
      "confidence": 0.85
    },
    "evaluation": {
      "metrics": {
        "goalAchieved": true,
        "planSuccessful": true,
        "actionCount": 8,
        "successfulActions": 7,
        "userInterventions": 1,
        "errors": 0,
        "recoveredErrors": 0,
        "timeEfficiency": 1.05
      },
      "reasoning": {
        "keyInsights": ["User preferred alphabetical ordering"],
        "improvements": ["Could parallelize folder creation"],
        "failureCauses": []
      },
      "reward": 1.75,
      "confidence": 0.88
    },
    "episode": {
      "id": "ep-abc123",
      "taskId": "task-20240115-001",
      "title": "Organize desktop files",
      "context": {...},
      "outcome": {
        "success": true,
        "goalAchieved": true,
        "reward": 1.75,
        "completionTime": 47250
      },
      "lesson": {
        "keyInsights": ["User has strong preference for alphabetical"],
        "successFactors": ["Clear step planning", "Good error recovery"]
      }
    },
    "output": "Successfully organized 42 files into 5 categories"
  }
}
```

---

## Error Handling

### Common Error Responses

#### 400 Bad Request
```json
{
  "error": "Missing required parameter: goal",
  "ok": false
}
```

#### 500 Internal Server Error
```json
{
  "error": "Failed to generate plan: memory retrieval timeout",
  "ok": false
}
```

## Rate Limiting

No rate limiting is currently enforced, but endpoints may be slow during consolidation passes.

## Memory Architecture

The cognitive API coordinates four persistent memory layers:

1. **Episodic Memory** - Complete task experiences (data/episodic_memories.json)
2. **Semantic Memory** - Generalized knowledge and facts (data/semantic_memories.json)
3. **Procedural Memory** - Skills and procedures (data/procedural_memories.json)
4. **Autobiographical Memory** - Projects and milestones (data/autobiographical_memories.json)

### Request Flow

```
API Request
    ↓
CognitiveIntegrationBridge
    ↓
├─ Retrieve Context (orchestrator)
├─ Create Plan (planner)
├─ Select Strategy (strategyManager)
├─ Execute (mock or real)
├─ Evaluate (evaluator)
├─ Record Episode (episodic)
├─ Extract Preferences (semantic)
├─ Learn Skills (procedural)
└─ Record Milestone (autobiographical)
    ↓
Response to Client
```

## Testing

Run integration tests:

```bash
npm test -- cognitive.integration.test.ts
```

Manually test endpoints:

```bash
# Test planning
curl -X POST http://localhost:3000/cognitive/plan \
  -H "Content-Type: application/json" \
  -d '{"goal":"Test","projectContext":"demo"}'

# Test memory retrieval
curl http://localhost:3000/cognitive/memory/stats

# Full task execution
curl -X POST http://localhost:3000/cognitive/task/execute \
  -H "Content-Type: application/json" \
  -d '{"goal":"Test task","userInput":"Run test"}'
```

---

## Next Steps

1. **Connect to Desktop Agent** - Wire executeFn to call real Python tools
2. **Add WebSocket Support** - Real-time task progress updates
3. **Implement Approval Workflow** - Human-in-the-loop for critical tasks
4. **Add Batch Operations** - Execute multiple tasks in parallel
5. **Extend Statistics** - Add performance dashboards
