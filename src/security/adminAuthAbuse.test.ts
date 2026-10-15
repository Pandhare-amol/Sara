import test from "node:test";
import assert from "node:assert/strict";
import { AdminAuthAbuseTracker } from "./adminAuthAbuse";

test("admin auth abuse tracker warns and recommends a single lock per active failure window", () => {
  const tracker = new AdminAuthAbuseTracker(3, 5, 60_000);
  assert.deepEqual(tracker.record("127.0.0.1", 1000), { attempts: 1, warn: false, shouldLock: false });
  assert.equal(tracker.record("127.0.0.1", 2000).warn, false);
  assert.equal(tracker.record("127.0.0.1", 3000).warn, true);
  assert.equal(tracker.record("127.0.0.1", 4000).warn, false);
  assert.equal(tracker.record("127.0.0.1", 5000).shouldLock, true);
  assert.equal(tracker.record("127.0.0.1", 6000).shouldLock, false);
});

test("warning and lock state reset after the failure window expires", () => {
  const tracker = new AdminAuthAbuseTracker(2, 3, 100);
  tracker.record("local", 1000);
  assert.equal(tracker.record("local", 1050).warn, true);
  assert.equal(tracker.record("local", 1060).shouldLock, true);

  assert.deepEqual(tracker.record("local", 1200), { attempts: 1, warn: false, shouldLock: false });
  assert.equal(tracker.record("local", 1210).warn, true);
  assert.equal(tracker.record("local", 1220).shouldLock, true);
});

test("inactive sources are pruned and the source map has a bounded size", () => {
  const tracker = new AdminAuthAbuseTracker(3, 5, 100, 2);
  tracker.record("old", 1000);
  assert.equal(tracker.trackedSourceCount, 1);
  tracker.record("active", 1050);
  assert.equal(tracker.trackedSourceCount, 2);
  tracker.record("new", 1200);
  assert.equal(tracker.trackedSourceCount, 1, "stale sources are removed before new attempts are stored");
  tracker.record("second", 1210);
  tracker.record("third", 1220);
  assert.equal(tracker.trackedSourceCount, 2, "unique sources cannot grow the tracker beyond its configured limit");
});

test("successful admin authentication clears that source's failure history", () => {
  const tracker = new AdminAuthAbuseTracker(2, 3, 100);
  tracker.record("local", 1000);
  tracker.record("local", 1050);
  tracker.clear("local");
  assert.deepEqual(tracker.record("local", 1060), { attempts: 1, warn: false, shouldLock: false });
});
