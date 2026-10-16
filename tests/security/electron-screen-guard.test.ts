import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { canChooseScreen } = require("../../electron/screenPermission.cjs") as {
  canChooseScreen: (request: Record<string, unknown>, expected: string, protectedMode: boolean) => boolean;
};
const origin = "http://127.0.0.1:3000";
const chosen = { securityOrigin: `${origin}/`, userGesture: true, videoRequested: true, audioRequested: false };

test("Electron requires a trusted app-origin user gesture and never silently picks a source", () => {
  assert.equal(canChooseScreen(chosen, origin, false), true);
  assert.equal(canChooseScreen(chosen, origin, true), false);
  assert.equal(canChooseScreen({ ...chosen, userGesture: false }, origin, false), false);
  assert.equal(canChooseScreen({ ...chosen, securityOrigin: "https://other.invalid" }, origin, false), false);
  assert.equal(canChooseScreen({ ...chosen, audioRequested: true }, origin, false), false);
  assert.equal(canChooseScreen({ ...chosen, videoRequested: false }, origin, false), false);
  assert.equal(canChooseScreen({ ...chosen, securityOrigin: "invalid" }, origin, false), false);
});
