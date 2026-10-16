import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");

test("Electron pins its backend to loopback, owns a configurable distinct port, and refuses occupied ports", () => {
  const electron = read("electron/main.cjs");
  const server = read("server_full.ts");
  assert.match(electron, /SARA_ELECTRON_PORT \|\| 3000/);
  assert.match(electron, /SERVER_ORIGIN = `http:\/\/localhost:\$\{SERVER_PORT\}`/);
  assert.doesNotMatch(electron, /SERVER_ORIGIN = `http:\/\/127\.0\.0\.1:/);
  assert.match(electron, /PORT: String\(SERVER_PORT\)/);
  assert.match(electron, /SARA_BIND_HOST: '127\.0\.0\.1'/);
  assert.match(electron, /isPortAvailable\(SERVER_PORT\)/);
  assert.match(electron, /SARA did not stop the existing process/);
  assert.match(electron, /\/api\/config/);
  assert.match(server, /SARA_BROWSER_AGENT_PORT \|\| 3001/);
  assert.match(server, /BROWSER_AGENT_PORT === PORT/);
  assert.match(server, /EADDRINUSE/);
});

test("browser and mobile companion services use distinct loopback ports without wildcard CORS", () => {
  const browser = read("local-agent.js");
  const mobile = read("mobile_server.ts");
  assert.match(browser, /const HOST = "127\.0\.0\.1"/);
  assert.match(browser, /const PORT = Number\(process\.env\.SARA_BROWSER_AGENT_PORT \|\| 3001\)/);
  assert.match(browser, /app\.listen\(PORT, HOST/);
  assert.match(browser, /allowedOrigins\.has\(origin\)/);
  assert.doesNotMatch(browser, /cors\(\{\s*origin:\s*["']\*["']/);
  assert.match(browser, /EADDRINUSE/);
  assert.match(mobile, /MOBILE_SERVER_PORT \|\| 3002/);
  assert.match(mobile, /server\.listen\(PORT, BIND_HOST/);
  assert.match(mobile, /EADDRINUSE/);
});
