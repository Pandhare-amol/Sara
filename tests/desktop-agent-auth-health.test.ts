import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { isPortHealthy } from "../startup/processGuard.ts";

const TOKEN = "process-guard-test-agent-token-0123456789abcdef";

test("process health adoption can require the authenticated agent protocol and token", async () => {
  const server = http.createServer((req, res) => {
    if (req.url !== "/auth/check" || req.headers["x-sara-agent-token"] !== TOKEN) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ detail: "unauthorized" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      service: "sara-desktop-agent",
      agent_auth_required: true,
      agent_auth_protocol_version: 1,
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    const options = {
      path: "/auth/check",
      headers: { "X-SARA-Agent-Token": TOKEN },
      requiredProtocol: { field: "agent_auth_protocol_version", version: 1 },
    };
    assert.equal((await isPortHealthy(port, options.path, options.headers, options.requiredProtocol)).healthy, true);
    assert.equal((await isPortHealthy(port, options.path, { "X-SARA-Agent-Token": "wrong-token" }, options.requiredProtocol)).healthy, false);
    assert.equal((await isPortHealthy(port, options.path, options.headers, { field: "agent_auth_protocol_version", version: 2 })).healthy, false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
