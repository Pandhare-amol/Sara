import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");

test("verified project workflow is preview-only until explicit approval and verifies persistence", () => {
  const server = read("server_full.ts");
  const panel = read("src/components/ProjectManagerPanel.tsx");
  const previewStart = server.indexOf('app.post("/api/projects/workflows/preview"');
  const applyStart = server.indexOf('app.post("/api/projects/workflows/apply"');
  const projectListStart = server.indexOf('app.get("/api/projects"', applyStart);

  assert.ok(previewStart >= 0 && applyStart > previewStart && projectListStart > applyStart);
  const previewRoute = server.slice(previewStart, applyStart);
  const applyRoute = server.slice(applyStart, projectListStart);
  assert.match(previewRoute, /previewProjectWorkflow\(req\.body/);
  assert.doesNotMatch(previewRoute, /applyProjectWorkflow|createProject\(/);
  assert.match(applyRoute, /req\.body\?\.approved !== true/);
  assert.match(applyRoute, /applyProjectWorkflow\(req\.body \|\| \{\}, req\.body\?\.approved\)/);
  assert.match(applyRoute, /getProject\(result\.project\.id\)/);
  assert.match(applyRoute, /persisted: true/);
  assert.match(panel, /approved: true/);
  assert.match(panel, /Approve &amp; apply locally|Approve & apply locally/);
  assert.match(panel, /Nothing has been saved/);
});
