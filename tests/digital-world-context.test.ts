import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DigitalWorldContextStore } from "../src/cognitive/digitalWorldContext.ts";
import { ContextManager } from "../src/core/context/ContextManager.ts";

test("digital world context persists bounded observations", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sara-world-"));
  const filePath = path.join(directory, "world.json");
  const store = new DigitalWorldContextStore(filePath);

  store.update({ activeApplication: "Code", activeProject: "SARA", unfinishedWork: ["Wire observer"] });
  for (let index = 0; index < 105; index += 1) {
    store.recordObservation({ source: "test", kind: "system", summary: `event-${index}` });
  }

  const restored = new DigitalWorldContextStore(filePath).getSnapshot();
  assert.equal(restored.activeProject, "SARA");
  assert.equal(restored.recentObservations.length, 100);
  assert.equal(restored.recentObservations[0].summary, "event-5");
});

test("context manager exposes the latest digital world snapshot", () => {
  const context = new ContextManager().build({
    userInput: "What am I working on?",
    digitalWorld: {
      observedAt: new Date().toISOString(),
      activeApplication: "Code",
      activeProject: "SARA",
      applications: [],
      browserTabs: [],
      unfinishedWork: ["Wire observer"],
      attentionItems: [],
    },
  });

  assert.equal(context.included.digitalWorld, true);
  assert.match(context.text, /DIGITAL WORLD/);
  assert.match(context.text, /SARA/);
});