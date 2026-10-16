import test from "node:test";
import assert from "node:assert/strict";
import { CollaborationCoordinator } from "../src/core/intelligence/collaboration";
import type { TextModelRouter } from "../src/core/models/textModelRouter";

function fixture(primary: string, reviewer: string, fail = false) {
  const calls: string[] = [];
  const models = {
    status(role: string) { return { provider: role === "verification" ? reviewer : primary, model: "fixture",
      configured: true }; },
    async generate(req: { role: string }) {
      calls.push(req.role);
      if (fail && req.role === "verification") throw new Error("provider unavailable");
      return { provider: req.role === "verification" ? reviewer : primary, model: "fixture",
        text: req.role === "verification" ? "The claim about 7% is unsupported" : "Try 5%",
        durationMs: 5 };
    },
  } as unknown as TextModelRouter;
  return { calls, coordinator: new CollaborationCoordinator(models) };
}

test("one opinion by default, two only with consent and a distinct provider; disagreement is not verification", async () => {
  const one = fixture("openai", "anthropic");
  const answer = await one.coordinator.consult({ question: "Summarize this idea", purpose: "summarization", allowSecondOpinion: false });
  assert.equal(answer.status, "proposal"); assert.equal(answer.independentReview, false);
  assert.deepEqual(one.calls, ["summarization"]);
  const two = fixture("openai", "anthropic");
  const review = await two.coordinator.consult({ question: "Compare two approaches", purpose: "reasoning", allowSecondOpinion: true });
  assert.deepEqual(two.calls, ["reasoning", "verification"]);
  assert.equal(review.status, "disputed"); assert.equal(review.independentReview, true);
  assert.equal(review.proposals.length, 2);
});

test("high-impact single-provider and failed independent review never appear independently checked", async () => {
  const same = fixture("gemini", "gemini");
  const answer = await same.coordinator.consult({ question: "Deploy security fix", purpose: "coding", allowSecondOpinion: true });
  assert.equal(answer.status, "insufficient_evidence"); assert.equal(answer.independentReview, false);
  assert.deepEqual(same.calls, ["coding"]);
  const failed = fixture("openai", "anthropic", true);
  const report = await failed.coordinator.consult({ question: "Legal claim", purpose: "research", allowSecondOpinion: true });
  assert.equal(report.proposals.length, 1); assert.equal(report.status, "insufficient_evidence");
  assert.match(report.warnings.join(" "), /failed/);
});
