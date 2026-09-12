# Conversation Architecture Audit

## Executive summary

The existing SARA project already contains a persistent conversation layer, task recovery, session tracking, and a desktop chat UI. The real source of truth is not a new dedicated store; it is the existing backend persistence stack in `server_state.ts` and the JSON-backed conversation files under `data/`.

The architecture is fragmented but workable:

- `src/App.tsx` renders the Quick Chat and desktop conversation panels.
- `src/components/DesktopChatPanel.tsx` manages active chat message state and send actions.
- `src/components/DesktopConversationsPanel.tsx` lists saved conversations and allows deleting them.
- `src/lib/desktopConversationStore.ts` persists desktop chat history via `/api/conversations`.
- `server_state.ts` contains the canonical SQL/JSON persistence for conversations, messages, tasks, sessions, and tool calls.
- `server_full.ts` exposes the API routes and chat generation flow.
- Conversations are stored in `data/conversations.json` and mirrored into SQLite-backed tables when available.

This means the safest extension path is to reuse those layers through a compatibility adapter instead of introducing a second competing database or a new app-wide state model.

## 1. Current conversation flow

### UI

The rendered SARA app uses the following components:

- `src/App.tsx` owns the overall app state.
- `DesktopChatPanel` is the active message UI and send form.
- `DesktopConversationsPanel` shows saved conversations and create/delete actions.
- `window.localStorage['sara.conversationId']` acts as a lightweight active conversation pointer for the UI.

### Persistence

The desktop conversation store in `src/lib/desktopConversationStore.ts` reads and writes to the backend:

- `GET /api/conversations?source=desktop`
- `POST /api/conversations` with `{ source, conversation }`
- `DELETE /api/conversations/:id`

The backend API in `server_full.ts` reads/writes the `data/conversations.json` file and keeps the data in a JSON array format.

### True backend source of truth

`server_state.ts` is the key architecture file. It contains:

- `ConversationRecord`
- `ConversationMessage`
- `TaskRecord`
- `SessionRecord`
- `ToolCallRecord`
- `loadConversations()` / `saveConversations()`
- `getConversation()` / `getOrCreateConversation()`
- `appendConversationMessage()`
- `loadTasks()` / `saveTasks()`
- `loadSessions()` / `saveSessions()`
- `upsertSession()`
- `getLastSession()`
- `getSessionRecoveryContext()`

This is the current persistent backend source of truth for conversation, task, and session recovery.

## 2. Current storage

### Files already in use

- `data/conversations.json`
- `data/tasks.json`
- `data/sessions.json`
- `data/tool_calls.json`
- `data/memories.json`
- `server_state.ts` also initializes a SQLite database at `data/data.db` when available.

### Important finding

The project already has a conversation persistence model, but it is not yet shaped as the full production conversation domain model requested in the Phase 1/2 specification. It stores records in a simplified structure and already contains task and session recovery logic, which should be extended rather than replaced.

## 3. Current context handling

The backend is already capable of:

- loading the previous session for a conversation
- loading unfinished tasks
- restoring task state from saved records
- tracking sessions and tool calls per conversation

The main weakness is that the UI does not yet restore full contextual state when an older conversation is reopened; it mostly reloads a stored message list and does not create a strong “conversation-aware” context manager.

## 4. Current Gemini session lifecycle

`server_full.ts` contains the live Gemini integration and session reconnection logic.

Observed behavior:

- session records are kept in `sessions.json` and database tables
- last session data can be recovered with `getLastSession(conversationId)`
- `getSessionRecoveryContext()` is intended to restore context after reconnect

This is the correct place to add a real context manager rather than letting Gemini state be treated as persistent conversation state.

## 5. Current memory integration

The project already has a memory system in the backend and UI.

Relevant files:

- `server_memory.ts`
- `server_full.ts` memory APIs
- `src/App.tsx` memory dashboard
- `agi/context.ts`

This is useful long-term memory infrastructure and should remain independent from ephemeral conversation context.

## 6. Current task integration

Tasks are already persistently stored in `server_state.ts` via `TaskRecord` and the `tasks` table.

This supports:

- unfinished task recovery
- task status normalization
- task checkpoint persistence
- resume work after restart

This matches the requested “task-aware restoration” model and should be extended with conversation-level task association rather than replacing it.

## 7. Current weaknesses

1. The desktop chat UI is functional but not yet a full production conversation manager.
2. The app uses a local conversation ID pointer rather than a fully user-aware multi-conversation model.
3. There is no canonical conversation repository that matches the full requested model.
4. The product-level context restore pipeline is not yet formalized as a dedicated manager.
5. Search/archive/rename/delete flows are present only in a simplified form, not as a full production conversation domain service.
6. The current conversation data is modeled as a plain JSON array; it is not yet extended with summary, context snapshots, task scope, and metadata as first-class fields.

## 8. Safe integration points

The safest architecture is:

- Keep `server_state.ts` as the durable storage source of truth.
- Keep `server_full.ts` as the API surface.
- Keep `src/App.tsx` and chat components as the UI shell.
- Add a compatibility layer and repository adapter that exposes the canonical conversation model while reading/writing the existing data.
- Treat Gemini and WebSocket state as ephemeral; conversation state remains in storage and task/session records.

## 9. Recommended compatibility direction

Use the project’s existing persisted records and add an adapter layer that maps to this canonical shape:

- conversation_id
- user_id
- title
- created_at
- updated_at
- last_message_at
- status
- model_provider
- summary
- active_context
- task_state
- memory_scope
- metadata

This can be layered over the current conversation files and session/task stores without replacing the working app.

## 10. Conclusion

The project is already closer to a production conversation system than it appears at first glance. The main issue is architectural alignment, not missing persistence infrastructure. The correct path is to extend the current backend persistence and UI, not rebuild the app or introduce duplicate storage.
