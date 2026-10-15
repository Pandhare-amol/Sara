import test from "node:test";
import assert from "node:assert/strict";
import { VoiceActivityGate } from "../src/lib/voiceActivityGate";

function constantFrame(value: number, size = 256): Float32Array {
  return new Float32Array(size).fill(value);
}

function speechFrame(amplitude = 0.12, size = 256): Float32Array {
  const frame = new Float32Array(size);
  for (let i = 0; i < size; i += 1) frame[i] = amplitude * Math.sin((2 * Math.PI * 220 * i) / 16_000);
  return frame;
}

test("adaptive voice gate turns low-level steady noise into silence", () => {
  const gate = new VoiceActivityGate();
  for (let i = 0; i < 30; i += 1) {
    const output = gate.process(constantFrame(0.004));
    assert.equal(output.speechActive, false);
    assert.equal(output.frames.length, 1);
    assert.ok(output.frames[0].every((sample) => sample === 0));
  }
});

test("voice gate confirms speech across adjacent frames and preserves onset pre-roll", () => {
  const gate = new VoiceActivityGate({ attackFrames: 2 });
  const first = speechFrame(0.10);
  const second = speechFrame(0.08);

  assert.equal(gate.process(first).speechActive, false);
  const opened = gate.process(second);
  assert.equal(opened.started, true);
  assert.equal(opened.speechActive, true);
  assert.equal(opened.frames.length, 2);
  assert.deepEqual(opened.frames[0], first);
  assert.deepEqual(opened.frames[1], second);
});

test("voice gate uses bounded silence hangover and returns to idle", () => {
  const gate = new VoiceActivityGate({ attackFrames: 1, hangoverFrames: 2 });
  assert.equal(gate.process(speechFrame()).speechActive, true);
  assert.equal(gate.process(constantFrame(0)).speechActive, true);
  assert.equal(gate.process(constantFrame(0)).speechActive, true);
  const ended = gate.process(constantFrame(0));
  assert.equal(ended.ended, true);
  assert.equal(ended.speechActive, false);
  assert.ok(ended.frames[0].every((sample) => sample === 0));
});

test("single transient clicks do not open the voice gate", () => {
  const gate = new VoiceActivityGate({ attackFrames: 2 });
  const impulse = new Float32Array(256);
  impulse[32] = 0.8;
  assert.equal(gate.process(impulse).speechActive, false);
  assert.equal(gate.process(constantFrame(0)).speechActive, false);
});
