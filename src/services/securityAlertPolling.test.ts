import test from "node:test";
import assert from "node:assert/strict";
import { SecurityAlertPollingCursor } from "./securityAlertPolling";

test("security alert cursor starts with a short lookback and does not move on an empty poll", () => {
  const cursor = new SecurityAlertPollingCursor(1_000_000, 60_000);
  assert.equal(cursor.since(), 940_000);
  assert.equal(cursor.consume([]), null);
  assert.equal(cursor.since(), 940_000);
});

test("security alert cursor deduplicates events but accepts distinct alerts at the same timestamp", () => {
  const cursor = new SecurityAlertPollingCursor(1_000_000, 0);
  const first = { id: "alert-a", createdAt: 1_000_000, message: "warning A" };
  const sameTime = { id: "alert-b", createdAt: 1_000_000, message: "warning B" };

  assert.equal(cursor.consume([first])?.message, "warning A");
  assert.equal(cursor.since(), 1_000_000);
  assert.equal(cursor.consume([first]), null);
  assert.equal(cursor.consume([first, sameTime])?.message, "warning B");
});
