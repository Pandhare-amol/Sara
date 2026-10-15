import test from "node:test";
import assert from "node:assert/strict";
import { getDesktopAgentPythonCandidates } from "../src/core/pythonRuntime";

test("Python candidates prefer configured and virtual-environment runtimes", () => {
  const candidates = getDesktopAgentPythonCandidates("linux", "/opt/sara", {
    SARA_PYTHON: "/custom/python", VIRTUAL_ENV: "/home/user/.venv",
  });
  assert.deepEqual(candidates, [
    "/custom/python",
    "/home/user/.venv/bin/python",
    "/opt/sara/.venv/bin/python",
    "python3",
    "python",
  ]);
});

test("Python candidates use Windows venv paths and omit the former user-specific path", () => {
  const candidates = getDesktopAgentPythonCandidates("win32", "C:\\sara", {
    SARA_PYTHON: "C:\\Python\\python.exe",
    VIRTUAL_ENV: "C:\\sara\\.venv",
  });
  assert.deepEqual(candidates, [
    "C:\\Python\\python.exe",
    "C:\\sara\\.venv\\Scripts\\python.exe",
    "py",
    "python",
    "python3",
  ]);
  assert.ok(!candidates.some((candidate) => candidate.includes("Users\\MSI")));
});
