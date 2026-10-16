import test from "node:test";
import assert from "node:assert/strict";
import { VisualSessionGate } from "../src/security/visualSessionGate";

test("only a short-lived admin-minted visual capability authorizes capture", () => {
  const gate = new VisualSessionGate();
  assert.equal(gate.enabled, false);
  assert.equal(gate.authorize("admin token"), false);
  const first = gate.grant(10);
  assert.equal(gate.authorize(first.token), true);
  assert.equal(gate.authorize(first.token.toUpperCase()), false);
  assert.equal(gate.authorize("f".repeat(64)), false);
  const second = gate.grant(10);
  assert.notEqual(first.grantId, second.grantId);
  assert.equal(gate.authorize(first.token), false, "replacing scope revokes old browser access");
  assert.equal(gate.authorize(second.token), true);
  gate.revoke();
  assert.equal(gate.authorize(second.token), false);
  assert.equal(gate.generation, null);
  assert.throws(() => gate.grant(301));
});

test("expiry does not leave an implicitly approved screen session", () => {
  const gate = new VisualSessionGate();
  const granted = gate.grant(10);
  const original = Date.now;
  Date.now = () => granted.expiresAt + 1;
  try {
    assert.equal(gate.enabled, false);
    assert.equal(gate.authorize(granted.token), false);
  } finally { Date.now = original; }
});
