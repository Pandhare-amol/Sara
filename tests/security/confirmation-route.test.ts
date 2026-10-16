import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const tsxCli = require.resolve('tsx/cli');
const repositoryRoot = process.cwd();

async function reservePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

test('confirmation list is mounted during startup and arbitrary confirmation-token requests are absent', async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sara-confirmation-route-'));
  const adminToken = 'test-admin-token-for-startup-route-check-0123456789';
  const child = spawn(process.execPath, [tsxCli, path.join(repositoryRoot, 'server_full.ts')], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      SARA_BIND_HOST: '127.0.0.1',
      SARA_DATA_DIR: dataDir,
      SARA_ADMIN_TOKEN: adminToken,
      SARA_SUPERVISOR: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let processOutput = '';
  child.stdout.on('data', (chunk) => { processOutput += chunk.toString(); });
  child.stderr.on('data', (chunk) => { processOutput += chunk.toString(); });
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    let ready = false;
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break;
      try {
        const response = await fetch(`${baseUrl}/api/confirm/list`, {
          headers: { 'X-Admin-Token': adminToken },
          signal: AbortSignal.timeout(1500),
        });
        if (response.status === 200) {
          const payload = await response.json() as { ok?: boolean; confirmations?: unknown[] };
          assert.equal(payload.ok, true);
          assert.deepEqual(payload.confirmations, []);
          ready = true;
          break;
        }
      } catch {
        // The server may still be importing the application modules.
      }
      await delay(200);
    }
    assert.equal(ready, true, `Backend did not start with the confirmation route mounted. Output:\n${processOutput}`);

    const unauthenticatedList = await fetch(`${baseUrl}/api/confirm/list`);
    assert.equal(unauthenticatedList.status, 401, 'confirmation details require the admin approval key');

    const arbitraryRequest = await fetch(`${baseUrl}/api/confirm/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'arbitrary_desktop_action', args: { command: 'not allowed' } }),
    });
    assert.equal(arbitraryRequest.status, 404, 'the self-issued confirmation-token endpoint must not exist');

    const whatsappConfirmation = await fetch(`${baseUrl}/api/whatsapp/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: '+91 98765-43210', text: 'Exact approved text', confirmed: true }),
    });
    assert.equal(whatsappConfirmation.status, 202, 'a request consent boolean must create an approval, not dispatch a send');
    const whatsappPayload = await whatsappConfirmation.json() as any;
    assert.equal(whatsappPayload.status, 'awaiting_confirmation');
    assert.equal(whatsappPayload.confirmation.action, 'whatsapp_send');
    assert.equal(whatsappPayload.task.status, 'awaiting_confirmation');

    const unauthenticatedDecision = await fetch(`${baseUrl}/api/confirm/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: whatsappPayload.confirmation.id, approved: true }),
    });
    assert.equal(unauthenticatedDecision.status, 401, 'a pending approval cannot execute without active admin authentication');

    const queuedWhatsAppTask = await fetch(`${baseUrl}/api/tasks/whatsapp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: 'test-conversation',
        phone: '+91 98765-43210',
        message: 'Please confirm this reply',
      }),
    });
    assert.equal(queuedWhatsAppTask.status, 200);
    const taskPayload = await queuedWhatsAppTask.json() as any;
    assert.equal(taskPayload.task.status, 'awaiting_confirmation', 'WhatsApp task must not be enqueued before approval');
    assert.equal(taskPayload.task.metadata?.args, undefined, 'private message arguments stay out of unauthenticated task metadata');
    assert.equal(taskPayload.confirmation.action, 'whatsapp_send');

    const retryPendingAction = await fetch(`${baseUrl}/api/tasks/${taskPayload.task.taskId}/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmDangerousRetry: true }),
    });
    assert.equal(retryPendingAction.status, 409, 'a pending action must require a fresh approval instead of replaying stored arguments');
    const retryPayload = await retryPendingAction.json() as any;
    assert.equal(retryPayload.code, 'FRESH_APPROVAL_REQUIRED');

    const toolCallLogPath = path.join(dataDir, 'tool_calls.json');
    const toolCallLog = fs.readFileSync(toolCallLogPath, 'utf8');
    assert.equal(toolCallLog.includes('Exact approved text'), false, 'pending message contents must not be duplicated in general tool-call history');
    assert.equal(toolCallLog.includes('Please confirm this reply'), false, 'pending message contents must not be duplicated in general tool-call history');

    const removedSuggestionRoute = await fetch(`${baseUrl}/api/whatsapp/send_suggestion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: '+919876543210', suggestion: 'must not auto-send' }),
    });
    assert.equal(removedSuggestionRoute.status, 404, 'the legacy auto-send suggestion route must be removed');
  } finally {
    await stopChild(child);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
