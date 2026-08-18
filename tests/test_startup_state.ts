import assert from "assert";
import { overallServiceState, formatStartupSummary } from "../startup/startupState.ts";

const healthy = overallServiceState({
  supervisor: { name: "supervisor", state: "HEALTHY", healthy: true },
  backend: { name: "backend", state: "HEALTHY", healthy: true },
  desktop_agent: { name: "desktop_agent", state: "HEALTHY", healthy: true },
});

assert.strictEqual(healthy, "HEALTHY");

const degraded = overallServiceState({
  supervisor: { name: "supervisor", state: "HEALTHY", healthy: true },
  backend: { name: "backend", state: "FAILED", healthy: false },
  desktop_agent: { name: "desktop_agent", state: "HEALTHY", healthy: true },
});

assert.strictEqual(degraded, "DEGRADED");
assert.match(formatStartupSummary({
  supervisor: { name: "supervisor", state: "HEALTHY", healthy: true },
  backend: { name: "backend", state: "FAILED", healthy: false },
  desktop_agent: { name: "desktop_agent", state: "HEALTHY", healthy: true },
}), /overall:DEGRADED/);

const notRunning = overallServiceState({
  supervisor: { name: "supervisor", state: "NOT_RUNNING", healthy: false },
  backend: { name: "backend", state: "NOT_RUNNING", healthy: false },
  desktop_agent: { name: "desktop_agent", state: "NOT_RUNNING", healthy: false },
});

assert.strictEqual(notRunning, "NOT_RUNNING");
console.log("startup state tests passed");
