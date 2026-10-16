import test from "node:test";
import assert from "node:assert/strict";
import { scheduleMemoryExtraction } from "../src/core/memory/scheduleExtraction";
import { applyInferredMemoryTransactions, type StoredMemory } from "../server_memory";

function gate() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("optional memory extraction starts after the reply path and does not hold it open", async () => {
  const pending = gate();
  const events: string[] = [];
  scheduleMemoryExtraction(async () => { events.push("extracting"); await pending.promise; events.push("saved"); });
  events.push("reply sent");
  assert.deepEqual(events, ["reply sent"]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["reply sent", "extracting"]);
  pending.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["reply sent", "extracting", "saved"]);
});

test("failed best-effort extraction is handled and cannot retroactively fail chat", async () => {
  const pending = gate();
  let errors = 0;
  scheduleMemoryExtraction(() => pending.promise, () => { errors++; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  pending.reject(new Error("fake provider unavailable"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(errors, 1);
});

test("a late inferred-memory plan uses the latest snapshot and cannot resurrect a deleted item or overwrite a correction", () => {
  const approved: StoredMemory = {
    id: "approved", category: "preference", text: "I now prefer jasmine",
    createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-16T00:00:00.000Z",
    source: "user_provided", approvedByUser: true,
  };
  // The model formed an older plan while an inferred item was still present.
  // Its target was subsequently deleted; the explicit correction was approved.
  const latest = [approved];
  const updated = applyInferredMemoryTransactions(latest, [
    { action: "REMOVE", id: "approved", category: "preference", text: "" },
    { action: "UPDATE", id: "deleted", category: "preference", text: "stale guess" },
    { action: "ADD", id: "", category: "preference", text: "unconfirmed guess" },
  ]);
  assert.equal(latest.length, 1);
  assert.deepEqual(updated[0], approved);
  assert.equal(updated.some((memory) => memory.id === "deleted"), false);
  assert.equal(updated[1].text, "unconfirmed guess");
  assert.notEqual(updated[1].approvedByUser, true);
});
