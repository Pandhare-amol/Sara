import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { KnowledgeStore } from "../src/core/research/knowledgeStore";
import { ArtifactStore } from "../src/core/studio/artifactStore";
import { SkillVerificationService } from "../src/core/intelligence/skillVerification";
import type { SandboxVerifier, SandboxResult } from "../src/core/intelligence/sandboxVerifier";
import type { SourceRecord } from "../src/core/research/researchEngine";

const image = `sara-reviewed-tests@sha256:${"b".repeat(64)}`;
const env = { SARA_ENABLE_DOCKER_SANDBOX: "true", SARA_SANDBOX_IMAGE: image };
const tests = "import unittest\nimport candidate\nclass Verify(unittest.TestCase):\n def test_result(self): self.assertEqual(candidate.answer(), 2)\n";
const source: SourceRecord = { id: "source", url: "https://docs.example.org/guide", title: "Guide",
  retrievedAt: new Date().toISOString(), contentHash: "a".repeat(64), passages: ["Source instructions were retrieved but are not verified executable code."],
  status: "retrieved_unverified", sourceType: "web_document" };
function setup(dir: string) {
  const knowledge = new KnowledgeStore(path.join(dir, "knowledge.json"));
  const skill = knowledge.propose({ kind: "skill", name: "Answer helper", description: "A tested helper in a fixed environment",
    intendedUse: "Only when runtime and permissions are checked", platform: "linux", dependencies: [],
    requiredPermissions: [], procedure: ["Compute the bounded result."], expectedResults: ["Returns two."], expiresInDays: 30 }, [source]);
  const supported = knowledge.review(skill.id);
  const artifacts = new ArtifactStore(path.join(dir, "studio"));
  const candidate = artifacts.save({ kind: "code", format: "py", prompt: "Write an answer function",
    provider: "fixture", model: "fixture", bytes: Buffer.from("def answer(): return 2\n") });
  return { knowledge, supported, artifacts, candidate };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 40; i++) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
  throw new Error("Isolated verification fixture did not finish.");
}
const fakeVerifier: Pick<SandboxVerifier, "status" | "run"> = {
  status: () => ({ configured: true, experimental: true, imageDigestConfigured: true, note: "fixture only" }),
  run: async (code: string, testSource: string) => ({ status: "PASSED", exitCode: 0,
    evidence: { source: "isolated_sandbox", command: "python3 -I unittest", exitCode: 0,
      artifactHash: createHash("sha256").update(code).update("\0").update(testSource).digest("hex"),
      environment: image, completedAt: new Date().toISOString(), reviewed: false }, durationMs: 10,
  } as SandboxResult),
};

test("a fixture sandbox pass is NOT a verified skill until separate intact-source human review", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sara-skill-verification-"));
  try {
    const { knowledge, supported, artifacts, candidate } = setup(dir);
    const file = path.join(dir, "tests.json");
    const service = new SkillVerificationService(file, knowledge, artifacts, fakeVerifier, env);
    const started = service.start(supported.id, candidate.id, tests);
    assert.equal(started.status, "RUNNING");
    assert.equal(knowledge.search("Answer helper", { platform: "linux", dependencies: [], permissions: [] }).length, 0);
    await until(() => service.get(started.id)?.status === "PASSED_AWAITING_REVIEW");
    assert.equal(service.list()[0].status, "PASSED_AWAITING_REVIEW");
    assert.equal("testSource" in service.list()[0], false, "list never discloses test code");
    assert.equal(knowledge.get(supported.id)?.status, "supported", "a passing test alone cannot promote a skill");
    assert.throws(() => service.review("forged"), /Only an intact/);
    assert.equal(service.review(started.id).skillVersion, 3);
    assert.equal(knowledge.get(supported.id)?.status, "verified");
    assert.equal(knowledge.search("Answer helper", { platform: "windows", dependencies: [], permissions: [] }).length, 0);
    assert.equal(knowledge.search("Answer helper", { platform: "linux", dependencies: [], permissions: [] })[0].reuse, "manual_review_required");
    assert.throws(() => service.review(started.id), /Only an intact/);
    assert.equal(new SkillVerificationService(file, knowledge, artifacts, fakeVerifier, env).get(started.id)?.status, "REVIEWED");
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("disabled Docker, failed evidence and changed source prevent promotion", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sara-skill-fail-"));
  try {
    const { knowledge, supported, artifacts, candidate } = setup(dir);
    const file = path.join(dir, "tests.json");
    const disabled = new SkillVerificationService(file, knowledge, artifacts,
      { status: () => ({ configured: false, experimental: true, imageDigestConfigured: false, note: "off" }),
        run: async () => { throw new Error("Docker must not be called"); } }, { SARA_ENABLE_DOCKER_SANDBOX: "false" });
    assert.throws(() => disabled.start(supported.id, candidate.id, tests), /not configured/);
    assert.equal(knowledge.get(supported.id)?.status, "supported");
    const forged: Pick<SandboxVerifier, "status" | "run"> = { ...fakeVerifier,
      run: async () => ({ status: "PASSED", exitCode: 0, evidence: { source: "isolated_sandbox", command: "forged",
        exitCode: 0, completedAt: new Date().toISOString(), reviewed: false, artifactHash: "f".repeat(64), environment: image } }) };
    const service = new SkillVerificationService(file, knowledge, artifacts, forged, env);
    const attempted = service.start(supported.id, candidate.id, tests);
    await until(() => service.get(attempted.id)?.status === "FAILED");
    assert.throws(() => service.review(attempted.id), /Only an intact/);
    const good = new SkillVerificationService(path.join(dir, "other.json"), knowledge, artifacts, fakeVerifier, env);
    const second = good.start(supported.id, candidate.id, tests);
    await until(() => good.get(second.id)?.status === "PASSED_AWAITING_REVIEW");
    knowledge.expire(supported.id);
    assert.throws(() => good.review(second.id), /changed/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("cancellation retains uncertainty and never promotes even if the test resolves after stop", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sara-skill-cancel-"));
  try {
    const { knowledge, supported, artifacts, candidate } = setup(dir);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const verifier = { ...fakeVerifier, run: async (code: string, testSource: string) => {
      await held; return fakeVerifier.run(code, testSource);
    } };
    const service = new SkillVerificationService(path.join(dir, "tests.json"), knowledge, artifacts, verifier, env);
    const job = service.start(supported.id, candidate.id, tests);
    assert.equal(service.cancel(job.id)?.status, "CANCEL_REQUESTED");
    release(); await until(() => service.get(job.id)?.status === "CANCELLED");
    assert.throws(() => service.review(job.id), /Only an intact/);
    assert.equal(knowledge.get(supported.id)?.status, "supported");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
