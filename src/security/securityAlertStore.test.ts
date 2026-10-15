import test from "node:test";
import assert from "node:assert/strict";
import { handleSecurityAlertsRequest, SecurityAlertStore } from "./securityAlertStore";

function mockResponse() {
  const state: { statusCode: number; body?: unknown } = { statusCode: 200 };
  const response = {
    status(code: number) { state.statusCode = code; return response; },
    json(body: unknown) { state.body = body; return body; },
  };
  return { state, response };
}

test("security alert store bounds retained events and returns alerts inclusively by time", () => {
  const store = new SecurityAlertStore(2);
  store.add({ createdAt: 100, severity: "WARNING", message: "first", attempts: 3 });
  store.add({ createdAt: 200, severity: "WARNING", message: "second", attempts: 4 });
  store.add({ createdAt: 300, severity: "WARNING", message: "third", attempts: 5 });
  assert.equal(store.list().length, 2);
  assert.deepEqual(store.since(300).map((alert) => alert.message), ["third"]);
  assert.match(store.list()[0].id, /^[\da-f-]{36}$/i);
});

test("security alert route rejects non-loopback requests", () => {
  const store = new SecurityAlertStore();
  store.add({ createdAt: 100, severity: "WARNING", message: "attempt warning", attempts: 4 });
  const { state, response } = mockResponse();
  handleSecurityAlertsRequest({ socket: { remoteAddress: "192.168.1.5" } as any, query: { since: "0" } } as any, response as any, store);
  assert.equal(state.statusCode, 403);
  assert.deepEqual(state.body, { ok: false, error: "Security alerts are available only on this computer." });
});

test("security alert route returns bounded local alerts since the requested timestamp", () => {
  const store = new SecurityAlertStore();
  store.add({ createdAt: 100, severity: "WARNING", message: "older", attempts: 3 });
  store.add({ createdAt: 200, severity: "WARNING", message: "newer", attempts: 5 });
  const { state, response } = mockResponse();
  handleSecurityAlertsRequest({ socket: { remoteAddress: "::ffff:127.0.0.1" } as any, query: { since: "200" } } as any, response as any, store);
  assert.equal(state.statusCode, 200);
  assert.deepEqual(state.body, { ok: true, alerts: store.since(200) });
});
