const WebSocket = require('ws');
const fs = require('fs');
const url = 'ws://localhost:3000/live';

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

function connectOnce(label) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.on('open', () => {
      console.log(`[${label}] open`);
      setTimeout(() => {
        try { ws.close(); } catch (e) {}
      }, 300);
    });
    ws.on('message', (m) => {
      try { console.log(`[${label}] msg:`, m.toString().slice(0,300)); } catch {}
    });
    ws.on('close', () => {
      console.log(`[${label}] close`);
      resolve();
    });
    ws.on('error', (err) => {
      console.error(`[${label}] error:`, err.message || err);
      resolve();
    });
  });
}

async function run() {
  console.log('Waiting briefly for server...');
  await wait(1000);
  await connectOnce('first');
  await wait(500);
  await connectOnce('second');
  await wait(500);
  try {
    const s = fs.readFileSync('sessions.json', 'utf-8');
    console.log('sessions.json:\n', s);
  } catch (e) {
    console.error('Could not read sessions.json:', e.message || e);
  }
}

run().catch((e) => console.error('Test failed:', e));
