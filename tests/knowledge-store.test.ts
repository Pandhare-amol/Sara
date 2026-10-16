import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeStore } from "../src/core/research/knowledgeStore";
import type { SourceRecord } from "../src/core/research/researchEngine";

const source: SourceRecord = { id: "source1", url: "https://docs.example.com/guide", title: "Guide",
  retrievedAt: new Date().toISOString(), contentHash: "a".repeat(64), status: "retrieved_unverified", sourceType: "web_document",
  passages: ["The documented setup requires a configured endpoint and a supported runtime."] };
const proposal = { name: "Install guide", description: "A procedure for a compatible, approved runtime",
  intendedUse: "Check configuration only", kind: "skill", platform: "linux", dependencies: ["example-pkg"],
  requiredPermissions: ["read_public_web"], procedure: ["Review the configuration file without executing commands."],
  expectedResults: ["Supported runtime is reported."], failureHandling: "Stop and request review.",
  expiresInDays: 30 };
const evidence = { source: "isolated_sandbox", command: "pytest -q", exitCode: 0,
  completedAt: new Date().toISOString(), artifactHash: "f".repeat(64), environment: "isolated-test", reviewed: true } as const;

test("proposed knowledge is unverified; only independently evidenced and reviewed versions become eligible", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sara-knowledge-test-"));
  try {
    const file = path.join(dir, "knowledge.json"); const store = new KnowledgeStore(file);
    const first = store.propose(proposal, [source]);
    assert.equal(first.status, "pending_review"); assert.equal(first.confidence, "unverified");
    assert.equal(store.search("guide", { platform: "linux", dependencies: ["example-pkg"], permissions: ["read_public_web"] }).length, 0);
    const approved = store.review(first.id);
    assert.equal(approved.status, "supported"); assert.equal(approved.version, 2);
    assert.equal(store.search("guide", { platform: "linux", dependencies: ["example-pkg"], permissions: ["read_public_web"] }).length, 0);
    assert.throws(() => store.review(first.id, { ...evidence, exitCode: 1 }), /invalid/);
    const tested = store.review(first.id, evidence);
    assert.equal(tested.status, "verified"); assert.equal(tested.version, 3);
    assert.equal(store.search("guide", { platform: "windows", dependencies: ["example-pkg"], permissions: ["read_public_web"] }).length, 0);
    assert.equal(store.search("guide", { platform: "linux", dependencies: [], permissions: ["read_public_web"] }).length, 0);
    assert.equal(store.search("guide", { platform: "linux", dependencies: ["example-pkg"], permissions: [] }).length, 0);
    assert.equal(store.search("guide", { platform: "linux", dependencies: ["example-pkg"], permissions: ["read_public_web"] })[0].reuse, "manual_review_required");
    const revised = store.propose({ ...proposal, id: first.id, description: "Corrected setup details" }, [source]);
    assert.equal(revised.version, 4); assert.equal(revised.status, "pending_review");
    assert.equal(store.search("guide", { platform: "linux", dependencies: ["example-pkg"], permissions: ["read_public_web"] }).length, 0);
    assert.equal(store.history(first.id).length, 4);
    const restored = store.rollback(first.id, 2);
    assert.equal(restored.version, 5); assert.equal(restored.status, "pending_review");
    assert.equal(restored.verification, undefined);
    assert.equal(store.search("guide", { platform: "linux", dependencies: ["example-pkg"], permissions: ["read_public_web"] }).length, 0);
    assert.equal(new KnowledgeStore(file).history(first.id).length, 5, "versions survive restart");
    assert.equal(store.delete(first.id), true); assert.deepEqual(new KnowledgeStore(file).list(), []);
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("screenshots, injected source text and forged AI claims never become a verified skill", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sara-knowledge-invalid-"));
  try {
    const store = new KnowledgeStore(path.join(dir, "knowledge.json"));
    assert.throws(() => store.propose({ ...proposal, name: "Unsafe", description: "password=abc" }, [source]), /secret/i);
    assert.throws(() => store.propose(proposal, [{ ...source, status: "verified" } as any]), /retrieved/);
    assert.throws(() => store.propose({ ...proposal, dependencies: ["npm install; rm -rf /" ] }, [source]), /Dependencies/);
    const saved = store.propose(proposal, [source]);
    assert.equal(saved.evidence[0].text, source.passages[0]);
    assert.equal(saved.sourceUrls[0], source.url);
    assert.throws(() => store.review(saved.id, { ...evidence, reviewed: false } as any), /invalid/);
    store.expire(saved.id);
    assert.equal(store.get(saved.id)?.status, "outdated");
    assert.throws(() => store.review(saved.id), /outdated/);
    assert.throws(() => store.rollback(saved.id, 1), /current source evidence/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
