import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// server_state captures its data directory when imported; never touch the
// installation's actual conversations or the repository's tracked runtime data.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sara-continuity-"));
process.env.SARA_DATA_DIR = dir;
const store = await import("../server_state");

const message = (id: string, role: string, text: string, timestamp: string) => ({ id, role, text, timestamp });

test("voice reconnect preserves desktop text and loads a small recent context from the same conversation", async () => {
  try {
    await store.initSqlBridge(); // reproduce an existing SQLite index without this conversation
    const file = path.join(dir, "conversations.json");
    const conversations = [
      { id: "desktop-project", title: "SARA report", summary: "A report about SARA AI",
        activeContext: { objective: "Draft SARA project report" }, taskState: { status: "new" },
        createdAt: "2026-10-16T10:00:00.000Z", updatedAt: "2026-10-16T10:01:00.000Z",
        messages: [message("text-1", "user", "Create a SARA project report in Word", "2026-10-16T10:00:00.000Z"),
          message("text-2", "assistant", "I will draft the report and save a file.", "2026-10-16T10:01:00.000Z")] },
      { id: "unrelated", title: "Another user's work", createdAt: "2026-10-16T09:00:00.000Z", updatedAt: "2026-10-16T09:00:00.000Z",
        messages: [message("private-1", "user", "UNRELATED-PRIVATE-MESSAGE", "2026-10-16T09:00:00.000Z")] },
    ];
    fs.writeFileSync(file, JSON.stringify(conversations));

    const resumed = await store.getOrCreateConversation("desktop-project");
    assert.equal(resumed.id, "desktop-project");
    assert.equal(resumed.summary, "A report about SARA AI");
    assert.equal(resumed.messages[0]?.content, "Create a SARA project report in Word");
    assert.equal((JSON.parse(fs.readFileSync(file, "utf-8")) as any[]).length, 2,
      "Voice connection must not replace the desktop conversation store.");

    await store.appendConversationMessage({ id: "voice-1", conversationId: "desktop-project", role: "user",
      content: "Set the report font size to 14", timestamp: "2026-10-16T10:02:00.000Z" });
    const again = await store.getRecentConversationMessages("desktop-project", 10);
    assert.deepEqual(again.map((item) => item.content), [
      "Create a SARA project report in Word", "I will draft the report and save a file.", "Set the report font size to 14",
    ]);
    const saved = JSON.parse(fs.readFileSync(file, "utf-8")) as any[];
    assert.equal(saved.find((item) => item.id === "desktop-project")?.messages.length, 3);
    assert.equal(saved.find((item) => item.id === "unrelated")?.messages[0].text, "UNRELATED-PRIVATE-MESSAGE");
    assert.equal(await store.getConversation("' OR 1=1 --"), null,
      "Untrusted conversation IDs must not be interpolated into SQL queries.");

    // A corrupt snapshot must not be replaced with an empty list when voice
    // writes the next turn. Leave every original byte intact for recovery.
    fs.writeFileSync(file, '{"unfinished":');
    await assert.rejects(() => store.appendConversationMessage({ id: "voice-2", conversationId: "desktop-project",
      role: "assistant", content: "I saved the report", timestamp: "2026-10-16T10:03:00.000Z" }));
    assert.equal(fs.readFileSync(file, "utf-8"), '{"unfinished":');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
