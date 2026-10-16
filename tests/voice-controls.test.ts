import test from "node:test";
import assert from "node:assert/strict";
import { AutomationOrchestrator } from "../src/core/automation/automationOrchestrator";
import { isSpeechStopCommand, liveAutomationTaskCancel } from "../src/core/automation/voiceControls";
import { LiveSpeechTurns } from "../src/core/automation/liveSpeechTurns";
import { VoicePlaybackPolicy, playbackIsStale } from "../src/lib/voicePlaybackPolicy";

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

test("speech stop is not task cancel, and stale audio stays fenced until a newer turn", () => {
  const playback = new VoicePlaybackPolicy();
  assert.equal(playback.shouldPlay(1), true);
  assert.equal(isSpeechStopCommand("Please stop speaking now!"), true);
  assert.equal(isSpeechStopCommand("cancel task SARA-AUTO-123"), false);
  assert.equal(playback.stop(), 1);
  assert.equal(playback.shouldPlay(1), false);
  assert.equal(playback.shouldInterrupt(0), false, "a late old interruption cannot stop a new turn");
  assert.equal(playback.shouldPlay(2), true);
  assert.equal(playback.shouldPlay(1), false);
  assert.equal(playbackIsStale(3.01, 1), true);
  assert.equal(playbackIsStale(0, 128), true);
  assert.equal(playbackIsStale(0.2, 2), false);
  playback.reset();
  assert.equal(playback.shouldPlay(0), true, "reconnect starts a fresh turn epoch");
});

test("late user transcription cannot re-enable PCM from a stopped response", () => {
  const server = new LiveSpeechTurns();
  const client = new VoicePlaybackPolicy();
  const first = server.audio();
  assert.deepEqual(first, { turn: 1, forward: true });
  assert.equal(client.shouldPlay(first.turn), true);
  assert.equal(client.stop(), 1);
  assert.equal(server.stopClientTurn(1), true);
  assert.equal(server.userTranscription(), 1, "user text does not open a new response");
  assert.deepEqual(server.audio(), { turn: 1, forward: false });
  assert.equal(server.complete(), 1);
  const next = server.audio();
  assert.deepEqual(next, { turn: 2, forward: true });
  assert.equal(client.shouldPlay(next.turn), true);
  assert.equal(server.stopClientTurn(1), true, "late stop only affects the old turn");
  assert.equal(server.audio().forward, true);
  assert.equal(client.shouldPlay(1), false, "late old PCM is never played after a newer answer");
  assert.equal(server.interrupt(), 2);
  assert.deepEqual(server.audio(), { turn: 3, forward: true });
  assert.equal(server.stopClientTurn(4), false, "a future stop must not be accepted");
  server.complete();
  assert.equal(server.stopForCommand(), 3, "a stop without speech must not mute the next answer");
  assert.deepEqual(server.audio(), { turn: 4, forward: true });
  assert.equal(server.stopForCommand(), 4);
  assert.deepEqual(server.audio(), { turn: 4, forward: false });
  server.complete();
  assert.deepEqual(server.audio(), { turn: 5, forward: true });
});

test("voice cancel requires a direct, unambiguous user instruction and the same conversation", async () => {
  const held = deferred<unknown>();
  const orchestrator = new AutomationOrchestrator(async () => held.promise);
  const first = orchestrator.submit({ tool: "openApplication", args: { secret: "private args" }, conversationId: "one" });
  await turn();
  assert.equal(liveAutomationTaskCancel(orchestrator, first.task_id, "two", `cancel task ${first.task_id}`).ok, false);
  assert.equal(liveAutomationTaskCancel(orchestrator, first.task_id, "one", "stop speaking").ok, false);
  assert.equal(orchestrator.getTask(first.task_id)?.status, "RUNNING");
  const second = orchestrator.submit({ tool: "saraDocumentEdit", args: { path: "file.docx" }, conversationId: "one" });
  assert.equal(liveAutomationTaskCancel(orchestrator, first.task_id, "one", "cancel that task").ok, false,
    "with two active tasks the user must name the ID");
  const accepted = liveAutomationTaskCancel(orchestrator, second.task_id, "one", `cancel task ${second.task_id}`);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.task?.status, "CANCELLED");
  assert.doesNotMatch(JSON.stringify(accepted), /private args|file.docx/);
  const inFlight = liveAutomationTaskCancel(orchestrator, first.task_id, "one", "stop the background task");
  assert.equal(inFlight.ok, true);
  assert.equal(inFlight.task?.status, "CANCELLING", "no false claim of a stopped in-flight tool");
  held.resolve({ success: true, verified: false });
  await turn(); await turn();
  assert.equal(orchestrator.getTask(first.task_id)?.status, "PAUSED");
});
