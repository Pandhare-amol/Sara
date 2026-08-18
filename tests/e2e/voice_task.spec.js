const { test, expect } = require('@playwright/test');
const { startStub } = require('./desktop_agent_stub');
const { spawn } = require('child_process');
const fetch = require('node-fetch');

let stubServer = null;
let appProcess = null;

async function waitForUrl(url, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const r = await fetch(url, { method: 'GET' });
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timeout waiting for ${url}`);
}

test.beforeAll(async () => {
  // start desktop agent stub
  stubServer = await startStub(8765);
  // start app server (dev)
  appProcess = spawn('npx', ['tsx', 'server_full.ts'], { cwd: process.cwd(), shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  appProcess.stdout?.on('data', (d) => { /* uncomment to debug: console.log(String(d)) */ });
  appProcess.stderr?.on('data', (d) => { /* uncomment to debug: console.error(String(d)) */ });
  await waitForUrl('http://127.0.0.1:3000/api/agent-health');
});

test.afterAll(async () => {
  try { stubServer && stubServer.close(); } catch {}
  try { appProcess && appProcess.kill(); } catch {}
});

test('voice parse -> create whatsapp task -> confirm -> task completes', async () => {
  // 1) parse
  const parseRes = await fetch('http://127.0.0.1:3000/api/voice/parse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: 'Send WhatsApp to +15551234567 saying hello' }) });
  expect(parseRes.status).toBe(200);
  const parseBody = await parseRes.json();
  expect(parseBody.ok).toBeTruthy();
  const parsed = parseBody.parsed;
  expect(parsed.intent).toBeDefined();

  // 2) execute voice (should ask for confirmation)
  const execRes = await fetch('http://127.0.0.1:3000/api/voice/execute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: 'Send WhatsApp to +15551234567 saying hello' }) });
  expect(execRes.status).toBe(200);
  const execBody = await execRes.json();
  expect(execBody.ok).toBeTruthy();

  // 3) create task with confirmation
  const createRes = await fetch('http://127.0.0.1:3000/api/tasks/whatsapp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: 'test-conv', phone: '+15551234567', message: 'hello from test', requireConfirmation: true }) });
  expect(createRes.status).toBe(200);
  const createBody = await createRes.json();
  expect(createBody.ok).toBeTruthy();
  const confirmation = createBody.confirmation;
  expect(confirmation).toBeDefined();
  expect(confirmation.token).toBeDefined();

  // 4) verify confirmation
  const verifyRes = await fetch('http://127.0.0.1:3000/api/confirm/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: confirmation.id, token: confirmation.token }) });
  expect(verifyRes.status).toBe(200);
  const verifyBody = await verifyRes.json();
  expect(verifyBody.ok).toBeTruthy();

  // 5) tasks should be completed
  const tasksRes = await fetch('http://127.0.0.1:3000/api/tasks');
  expect(tasksRes.status).toBe(200);
  const tasks = await tasksRes.json();
  const t = tasks.find((x) => x.conversationId === 'test-conv');
  expect(t).toBeDefined();
  expect(['completed', 'failed', 'queued', 'running', 'waiting']).toContain(t.status);
});
