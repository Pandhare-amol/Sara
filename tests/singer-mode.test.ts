import test from "node:test";
import assert from "node:assert/strict";
import { songIntentAnalyzer } from "../src/agents/singer/SongIntentAnalyzer";
import { musicStyleEngine } from "../src/agents/singer/MusicStyleEngine";
import { SingerAgent } from "../src/agents/singer/SingerAgent";
import { UnavailableSingingProvider } from "../src/agents/singer/SingerProviders";

function waitForTerminal(agent: SingerAgent, taskId: string): Promise<ReturnType<SingerAgent["getTask"]>> {
  return new Promise((resolve) => {
    const unsubscribe = agent.on(({ task }) => {
      if (["READY", "FAILED", "PARTIAL_FAILURE", "CANCELLED"].includes(task.status)) {
        unsubscribe();
        resolve(task);
      }
    });
  });
}

test("song intent distinguishes singing from music discussion and playback", () => {
  assert.equal(songIntentAnalyzer.analyze("Tell me about music").intent, "NONE");
  assert.equal(songIntentAnalyzer.analyze("Play a song").intent, "PLAY_EXISTING_AUDIO");
  const intent = songIntentAnalyzer.analyze("Sing something relaxing in Marathi");
  assert.equal(intent.intent, "SING_ORIGINAL");
  assert.equal(intent.language, "mr");
  assert.equal(intent.mood, "RELAXING");
});

test("style engine creates bounded sections and calm defaults", () => {
  const plan = musicStyleEngine.createPlan({ language: "en", mood: "CALM", duration: "SHORT" });
  assert.equal(plan.tempoBpm, 68);
  assert.equal(plan.style, "PIANO");
  assert.deepEqual(plan.sections, ["Intro", "Verse 1", "Chorus", "Outro"]);
});

test("unavailable production provider fails truthfully after user lyrics validation", async () => {
  const agent = new SingerAgent(new UnavailableSingingProvider());
  const initial = agent.submit({ request: "Sing these lyrics", lyrics: "[Verse]\nKeep moving forward", conversationId: "test-conversation" });
  const final = await waitForTerminal(agent, initial.taskId);
  assert.equal(final?.status, "FAILED");
  assert.equal(final?.error?.code, "SINGER_PROVIDER_UNAVAILABLE");
  assert.match(final?.error?.message || "", /provider/i);
});
