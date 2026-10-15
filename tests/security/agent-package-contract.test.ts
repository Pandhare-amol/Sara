import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

test('Electron, PyInstaller, and builder all use the same sara-agent path and name', () => {
  const electronMain = read('electron/main.cjs');
  const builderConfig = read('electron-builder.yml');
  const spec = read('desktop_agent.spec');
  const buildHelper = read('scripts/build-windows-agent.ps1');

  assert.match(electronMain, /path\.join\(APP_ROOT,\s*'agent_dist',\s*'sara-agent',\s*'sara-agent\.exe'\)/);
  assert.match(electronMain, /path\.join\(process\.resourcesPath,\s*'agent',\s*'sara-agent\.exe'\)/);
  assert.match(builderConfig, /from:\s*agent_dist\/sara-agent[\s\S]*?to:\s*agent/);
  assert.match(spec, /name="sara-agent"/);
  assert.match(buildHelper, /desktop_agent\.spec/);
  assert.match(buildHelper, /Join-Path \$distRoot 'sara-agent'/);
  assert.match(buildHelper, /Join-Path \$agentDir 'sara-agent\.exe'/);
  assert.doesNotMatch(buildHelper, /--onefile|desktop_agent[\\/]main\.py/);
});
