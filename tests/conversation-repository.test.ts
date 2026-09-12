import test from "node:test";
import assert from "node:assert/strict";

import {
  createConversationRepository,
  type ConversationMessage,
} from "../src/lib/conversationRepository";

const repo = createConversationRepository({
  baseUrl: "http://localhost:3000",
  fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/conversations") && (!init || init.method === "GET")) {
      return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (url.endsWith("/api/conversations") && init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}"));
      return new Response(JSON.stringify({ ok: true, conversation: body.conversation }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.includes("/api/conversations/search")) {
      return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (url.includes("/api/conversations/")) {
      if (init?.method === "PATCH") {
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (init?.method === "DELETE") {
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  },
});

test("repository can create, list, append and search conversations", async () => {
  const created = await repo.createConversation({ title: "AI Resume Analyzer" });
  assert.ok(created.id);
  assert.equal(created.title, "AI Resume Analyzer");

  const listing = await repo.listConversations();
  assert.ok(Array.isArray(listing));

  const msg: ConversationMessage = {
    message_id: "m-1",
    conversation_id: created.id,
    role: "user",
    content: "Help me build my AI resume analyzer.",
    timestamp: new Date().toISOString(),
    attachments: [],
    tool_calls: [],
    tool_results: [],
    metadata: {},
    correlation_id: "corr-1",
    parent_message_id: null,
  };

  await repo.appendMessage(created.id, msg);

  const messages = await repo.getMessages(created.id);
  assert.ok(messages.some((entry) => entry.content.includes("AI resume analyzer")));

  const search = await repo.searchConversations("resume");
  assert.ok(Array.isArray(search));

  const updated = await repo.updateConversation(created.id, { title: "Resume Analyzer" });
  assert.equal(updated.title, "Resume Analyzer");
});

test("repository restores saved conversation context and task state", async () => {
  const created = await repo.createConversation({
    title: "AI Resume Analyzer",
    summary: "Resume analyzer project",
    task_state: { current_objective: "Build resume analyzer", status: "in_progress" },
    active_context: { objective: "Build resume analyzer", project: "resume-analyzer" },
  });

  const restored = await repo.restoreContextSnapshot(created.conversation_id);
  assert.ok(restored);
  assert.equal(restored?.objective, "Build resume analyzer");

  const updatedSummary = await repo.updateConversationSummary(created.conversation_id, "Current objective: build AI resume analyzer");
  assert.match(updatedSummary.summary, /resume analyzer/i);
});
