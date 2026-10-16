import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeStore } from "../src/core/research/knowledgeStore";
import { RefreshScheduler } from "../src/core/research/refreshScheduler";
import type { ResearchJobManager, ResearchJob, SourceRecord } from "../src/core/research/researchEngine";

const record: SourceRecord = { id: "first", url: "https://docs.example.com/guide", title: "Guide",
  retrievedAt: new Date().toISOString(), contentHash: "a".repeat(64), status: "retrieved_unverified",
  sourceType: "web_document", passages: ["The documented platform is Linux and version two is required."] };

test("a revised knowledge version invalidates its prior source-refresh consent", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sara-refresh-version-"));
  try {
    const store = new KnowledgeStore(path.join(dir, "knowledge.json"));
    const item = store.propose({ name: "Versioned guide", kind: "topic", platform: "linux", expiresInDays: 30,
      description: "Source-linked guide", intendedUse: "Reference only" }, [record]);
    let submitted = 0;
    const jobs = { submit() { submitted++; throw new Error("Should not refresh a changed version"); } } as unknown as ResearchJobManager;
    const scheduler = new RefreshScheduler(path.join(dir, "refresh.json"), store, jobs);
    const plan = scheduler.configure(item, { intervalHours: 6, quietStart: "23:00", quietEnd: "06:00", timeZone: "UTC" });
    store.review(item.id);
    await scheduler.trigger(plan.id, new Date("2026-10-16T12:00:00Z"));
    assert.equal(scheduler.list()[0].enabled, false);
    assert.equal(submitted, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("refresh is opt-in, honors quiet hours and marks changed sources outdated without auto-promoting skills", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sara-refresh-test-"));
  try {
    const store = new KnowledgeStore(path.join(dir, "knowledge.json"));
    const item = store.propose({ name: "Platform guide", kind: "topic", platform: "linux", expiresInDays: 30,
      description: "Reviewed requirements for a platform", intendedUse: "Reference only" }, [record]);
    let submitted = 0; let latest: ResearchJob | undefined;
    const jobs = {
      submit(question: string, urls: string[]) {
        submitted++; assert.deepEqual(urls, [record.url]);
        latest = { id: String(submitted), question, urls, status: "QUEUED", sources: [],
          failures: [], findingsStatus: "unresolved" }; return latest;
      }, get(id: string) { return id === latest?.id ? latest : undefined; }, cancel() { return undefined; },
    } as unknown as ResearchJobManager;
    const refresh = new RefreshScheduler(path.join(dir, "plans.json"), store, jobs);
    assert.deepEqual(refresh.list(), []);
    const plan = refresh.configure(item, { intervalHours: 6, timeZone: "UTC", quietStart: "23:00", quietEnd: "06:00" });
    await refresh.trigger(plan.id, new Date("2026-10-16T23:20:00Z"));
    assert.equal(submitted, 0);
    await refresh.trigger(plan.id, new Date("2026-10-16T12:00:00Z"));
    assert.equal(submitted, 1);
    latest!.status = "COMPLETED"; latest!.sources = [{ ...record, contentHash: "b".repeat(64) }];
    await refresh.tick(new Date("2026-10-16T12:02:00Z"));
    assert.equal(refresh.list()[0].lastResult, "changed");
    assert.equal(refresh.list()[0].enabled, false);
    assert.equal(store.get(item.id)?.status, "outdated");
    assert.equal(store.get(item.id)?.confidence, "unverified");
    assert.equal(new RefreshScheduler(path.join(dir, "plans.json"), store, jobs).list()[0].enabled, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
