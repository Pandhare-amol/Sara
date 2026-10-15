import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), 'utf8');

test('gesture settings use narrow routes and admin-protected writes, never the legacy arbitrary tool endpoint', () => {
  const server = read('server_full.ts');
  const panel = read('src/components/GestureControlPanel.tsx');
  const mappings = read('src/components/GestureMappingEditor.tsx');
  const fallback = read('src/components/BrowserVisionFallback.tsx');

  const configMutationStart = server.indexOf("app.put('/api/gesture/config'");
  const mappingsMutationStart = server.indexOf("app.post('/api/gesture/mappings/set'");
  assert.ok(configMutationStart >= 0);
  assert.ok(mappingsMutationStart > configMutationStart);
  assert.match(server.slice(configMutationStart, mappingsMutationStart), /checkAdminAuth\(req, res\)/);
  assert.match(server.slice(configMutationStart, mappingsMutationStart), /sanitizeGestureConfig\(req\.body\?\.config\)/);

  const mappingsMutation = server.slice(mappingsMutationStart, server.indexOf('// Retry a task', mappingsMutationStart));
  assert.match(mappingsMutation, /checkAdminAuth\(req, res\)/);
  assert.match(panel, /fetch\('\/api\/gesture\/config'/);
  assert.match(mappings, /fetch\('\/api\/gesture\/mappings\/get'/);
  assert.match(mappings, /fetch\('\/api\/gesture\/mappings\/set'/);
  assert.doesNotMatch(`${panel}\n${mappings}\n${fallback}`, /\/api\/desktop\/execute/);
  assert.doesNotMatch(fallback, /gestureForward/);
});
