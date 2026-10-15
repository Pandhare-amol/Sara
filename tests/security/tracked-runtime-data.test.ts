import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

function trackedPaths(): string[] {
  const output = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' });
  return output.split('\0').filter(Boolean);
}

test('runtime state, credentials, browser profiles and generated agent bundles are not tracked', () => {
  const forbidden = trackedPaths().filter((entry) =>
    /^(?:data|logs|agent_dist|agent_build)\//i.test(entry)
      || /(?:^|\/)__pycache__(?:\/|$)/i.test(entry)
      || /\.(?:pyc|pyo)$/i.test(entry)
      || /^(?:data\.db|sara_memory\.db)$/i.test(entry)
      || /(?:^|\/)(?:Cookies(?:-journal)?|\.sara_vault\.key|\.android_companion\.key|\.manifest-key)$/i.test(entry)
      || /(?:^|\/)[^/]+\.db(?:-journal)?$/i.test(entry),
  );
  assert.deepEqual(forbidden, [], `Sensitive/generated runtime files must remain local and ignored: ${forbidden.join(', ')}`);
});
