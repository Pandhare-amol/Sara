# SARA Continuous Online Learning

SARA now learns persistently from interactions without changing Gemini's frozen model weights. Learning is implemented as durable, selective memory and experience updates around the existing model and tool runtime.

## What Is Learned

- Every normal interaction is recorded as an episodic experience with the conversation ID, user goal, response, source, and timestamp.
- Explicit statements such as `I prefer concise answers`, `remember that ...`, `my goal is ...`, and `I am working on ...` become durable semantic memories.
- The existing Gemini `processConversationSlice` pass extracts durable facts, preferences, goals, projects, relationships, milestones, and long-term behavior from recent dialogue.
- Existing cognitive memory consolidation can later derive reusable skills, preferences, and strategies from repeated successful or failed experiences.
- Explicit feedback such as `that answer is wrong` or a corrected answer is recorded as a learning event; supplied corrections become durable behavior memories.

## Safety and Forgetting Prevention

- Learning is queued after the response so it does not block conversation.
- Duplicate memory handling remains in the existing `upsertMemory` path.
- A user can opt out per interaction with phrases such as `don't remember this`, `do not store this`, or `never save this`.
- Passwords, secrets, and highly sensitive data remain excluded by the existing semantic memory prompt and should not be explicitly provided to the memory system.
- The system records confidence and verification metadata; unverified user-provided memories are not presented as verified facts.
- Existing episodic memories are retained for retrieval and consolidation instead of overwriting older knowledge. Contradictions are tracked by the cognitive semantic memory layer.

## Runtime Surface

- Implementation: `src/services/OnlineLearningService.ts`
- Chat integration: `server_full.ts`
- Status endpoint: `GET /api/learning/status`
- Feedback endpoint: `POST /api/learning/feedback` with `{ feedback, correctedAnswer?, conversationId?, source? }`
- Telemetry state: `data/online-learning-state.json`
- Existing durable stores: `data/memories.json`, `data/sara_memory.db`, and cognitive memory files under `data/`

The telemetry file contains counters and timestamps only. It is not a second memory database.

## Important Limitation

This feature is online memory learning, not weight training. SARA does not modify Gemini model parameters locally or claim to retrain the foundation model. New knowledge is stored, retrieved selectively, consolidated into experiences and procedures, and used to improve future context and tool decisions.