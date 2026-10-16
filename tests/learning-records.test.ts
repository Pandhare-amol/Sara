import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LearningRecordStore } from "../src/cognitive/learningRecordStore";
import type { AuthoritativeTaskResult } from "../src/types/AuthoritativeTaskResult";

let tempDir = "";

before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sara-learning-records-"));
});

after(async () => {
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

function taskResult(taskId: string, overrides: Partial<AuthoritativeTaskResult> = {}): AuthoritativeTaskResult {
  return {
    taskId,
    state: "SUCCEEDED",
    success: true,
    verified: true,
    goal: "Create a project folder",
    summary: "The requested folder was created.",
    actions: [{
      tool: "createFolder",
      arguments: { path: "C:/private/user-data/project" },
      success: true,
      result: { secretPayload: "must-not-be-stored" },
    }],
    verification: {
      attempted: true,
      passed: true,
      method: "independent_filesystem_postcondition",
      checks: [{ name: "folder_exists", passed: true, evidence: "private evidence payload" }],
    },
    startedAt: "2025-01-01T00:00:00.000Z",
    completedAt: "2025-01-01T00:00:01.000Z",
    durationMs: 1000,
    metadata: { rawArguments: "must-not-be-stored" },
    ...overrides,
  };
}

test("records only minimized authoritative outcomes and requires explicit consent for feedback", async () => {
  const filePath = path.join(tempDir, "outcomes", "learning_records.json");
  const store = new LearningRecordStore(filePath);
  assert.ok(path.resolve(filePath).startsWith(path.resolve(tempDir) + path.sep));

  const result = taskResult("task-verified-1");
  const record = await store.recordTaskOutcome(result);
  assert.ok(record);
  assert.equal(record.verifiedSuccess, true);
  assert.equal(record.state, "SUCCEEDED");
  assert.deepEqual(record.tools, ["createFolder"]);
  assert.deepEqual(record.verification.checks, [{ name: "folder_exists", passed: true }]);
  assert.equal("goal" in record, false);
  assert.equal("summary" in record, false);
  assert.equal("actions" in record, false);
  assert.equal("metadata" in record, false);

  const persisted = await fs.readFile(filePath, "utf-8");
  assert.equal(persisted.includes("must-not-be-stored"), false);
  assert.equal(persisted.includes("private evidence payload"), false);
  assert.equal(persisted.includes("C:/private/user-data/project"), false);

  await assert.rejects(
    store.submitFeedback("task-verified-1", { rating: "accurate", consentToLearn: false }),
    /explicit consent/i,
  );
  await assert.rejects(
    store.submitFeedback("task-verified-1", {
      rating: "inaccurate",
      note: "password=hunter2",
      consentToLearn: true,
    }),
    /credential/i,
  );
  assert.equal((await store.listRecords())[0].feedback, undefined);

  const withFeedback = await store.submitFeedback("task-verified-1", {
    rating: "partially_accurate",
    note: "The result was correct, but I wanted a shorter summary.",
    consentToLearn: true,
  });
  assert.equal(withFeedback?.feedback?.rating, "partially_accurate");
  assert.equal(withFeedback?.feedback?.consentToLearn, true);
  assert.equal(withFeedback?.feedback?.note, "The result was correct, but I wanted a shorter summary.");

  const duplicateOutcome = await store.recordTaskOutcome(result);
  assert.equal(duplicateOutcome?.id, record.id, "replayed completion events should be idempotent");
  const duplicateFeedback = await store.submitFeedback("task-verified-1", {
    rating: "partially_accurate",
    note: "The result was correct, but I wanted a shorter summary.",
    consentToLearn: true,
  });
  assert.equal(duplicateFeedback?.id, record.id);
  await assert.rejects(
    store.submitFeedback("task-verified-1", { rating: "accurate", consentToLearn: true }),
    /cannot be overwritten/i,
  );
});

test("unverified and credential-bearing outcomes are never marked as verified learning", async () => {
  const store = new LearningRecordStore(path.join(tempDir, "filtered", "records.json"));
  const unverified = taskResult("task-unverified-1", {
    state: "FAILED",
    success: false,
    verified: false,
    goal: "password=do-not-persist",
    verification: {
      attempted: true,
      passed: false,
      method: "tool_response_validation",
      checks: [{ name: "postcondition_failed", passed: false }],
    },
  });
  const record = await store.recordTaskOutcome(unverified);
  assert.ok(record);
  assert.equal(record.verifiedSuccess, false);
  assert.equal("goal" in record, false, "task goal text must not be copied into the learning store");
  assert.equal(await store.submitFeedback("task-unverified-1", {
    rating: "accurate",
    consentToLearn: true,
  }), null, "unverified outcomes must not accept learning feedback");

  const notTerminal = taskResult("task-running-1", { state: "RUNNING" });
  assert.equal(await store.recordTaskOutcome(notTerminal), null);
});

test("record storage is serialized, bounded without deleting history, and does not overwrite corrupt files", async () => {
  const concurrentStore = new LearningRecordStore(path.join(tempDir, "concurrent", "records.json"), 20);
  const outcomes = await Promise.all(Array.from({ length: 12 }, (_, index) =>
    concurrentStore.recordTaskOutcome(taskResult(`task-concurrent-${index}`)),
  ));
  assert.equal(outcomes.filter(Boolean).length, 12);
  assert.equal((await concurrentStore.listRecords()).length, 12);

  const boundedStore = new LearningRecordStore(path.join(tempDir, "bounded", "records.json"), 1);
  await boundedStore.recordTaskOutcome(taskResult("task-capacity-1"));
  await assert.rejects(
    boundedStore.recordTaskOutcome(taskResult("task-capacity-2")),
    /capacity reached/i,
  );
  assert.deepEqual((await boundedStore.listRecords()).map((record) => record.taskId), ["task-capacity-1"]);

  const corruptPath = path.join(tempDir, "corrupt", "records.json");
  await fs.mkdir(path.dirname(corruptPath), { recursive: true });
  await fs.writeFile(corruptPath, "{invalid-json", "utf-8");
  const corruptStore = new LearningRecordStore(corruptPath);
  await assert.rejects(corruptStore.recordTaskOutcome(taskResult("task-corrupt-1")), /left untouched/i);
  assert.equal(await fs.readFile(corruptPath, "utf-8"), "{invalid-json");
});
