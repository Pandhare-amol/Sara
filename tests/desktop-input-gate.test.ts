import test from "node:test";
import assert from "node:assert/strict";
import { DesktopInputGate, requiresDesktopInput } from "../src/core/automation/desktopInputGate";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const turn = () => new Promise<void>((done) => setImmediate(done));

test("direct voice, browser, and automation GUI input share a serial bounded gate", async () => {
  const gate = new DesktopInputGate(1, 2_000);
  const held = deferred<string>();
  const calls: string[] = [];
  const first = gate.run(async () => { calls.push("first"); return held.promise; });
  const second = gate.run(async () => { calls.push("second"); return "done"; });
  await turn();
  assert.deepEqual(calls, ["first"]);
  assert.equal(gate.status.waiting, 1);
  await assert.rejects(gate.run(async () => "third"), /busy/i);
  held.resolve("verified");
  assert.equal(await first, "verified");
  assert.equal(await second, "done");
  assert.deepEqual(calls, ["first", "second"]);
  await turn(); // the gate releases its lock in the promise's finally callback
  assert.equal(gate.status.active, false);
});

test("transport uncertainty quarantines GUI input and refuses waiting actions without dispatch", async () => {
  const gate = new DesktopInputGate();
  const held = deferred<string>();
  let dispatched = 0;
  const first = gate.run(async () => { dispatched++; return held.promise; });
  const second = gate.run(async () => { dispatched++; return "second"; });
  await turn();
  gate.markUncertain();
  await assert.rejects(second, /verify the external state/i);
  await assert.rejects(gate.run(async () => { dispatched++; return "third"; }), /uncertain/i);
  held.resolve("outcome unknown");
  assert.equal(await first, "outcome unknown");
  assert.equal(dispatched, 1);
  assert.equal(gate.status.uncertain, true);
});

test("only reviewed status and emergency controls bypass GUI serialization", () => {
  for (const name of ["saraTaskStatus", "saraTaskCancel", "saraAgentEmergencyStop", "systemInfo", "saraSocialPlanResponse"]) {
    assert.equal(requiresDesktopInput(name), false, name);
  }
  for (const name of ["desktopBrowserWorkflow", "desktopBrowserClick", "openApplication", "saraDocumentEdit", "hardwareKeyboardPress", "unknownAgentTool"]) {
    assert.equal(requiresDesktopInput(name), true, name);
  }
});
