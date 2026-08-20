const WebSocket = require('ws');
const fs = require('fs');
const url = 'ws://localhost:3000/live';
const http = require('http');

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

  // Read the latest conversation id from conversations.json and reuse it
  let convId = null;
  try {
    const convRaw = fs.readFileSync('conversations.json', 'utf-8');
    const convs = JSON.parse(convRaw || '[]');
    if (Array.isArray(convs) && convs.length) {
      convId = convs[convs.length - 1].id;
      console.log('Reusing conversation id for reconnect:', convId);
    }
  } catch (e) {
    console.warn('No conversations.json available to reuse.');
  }

  if (convId) {
    // connect second time with conversationId query param
    await connectWithConv('second', convId);
  } else {
    await connectOnce('second');
  }

  await wait(500);
  try {
    const s = JSON.parse(fs.readFileSync('sessions.json', 'utf-8'));
    const session = Array.isArray(s) ? s.find((item) => item.conversationId === convId) : null;
    if (session) {
      console.log('session record:', JSON.stringify(session, null, 2));
      console.log('reconnectAttempts:', session.reconnectAttempts);
    } else {
      console.log('No session record found for conversation:', convId);
    }
  } catch (e) {
    console.error('Could not read sessions.json:', e.message || e);
  }

  // Also call the server stats API to verify reconnect counts
  try {
    http.get('http://127.0.0.1:3000/api/session-stats' + (convId ? ('?conversationId=' + encodeURIComponent(convId)) : ''), (res) => {
      let body = '';
      res.on('data', (c) => body += c.toString());
      res.on('end', () => {
        try { console.log('session-stats:', JSON.stringify(JSON.parse(body), null, 2)); } catch (e) { console.log('session-stats raw:', body); }
      });
    }).on('error', (err) => { console.error('session-stats request failed:', err.message || err); });
  } catch (e) {
    console.error('Failed to request session-stats:', e.message || e);
  }
}

function connectWithConv(label, convId) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url + '?conversationId=' + encodeURIComponent(convId));
    ws.on('open', () => {
      console.log(`[${label}] open`);
      setTimeout(() => {
        try { ws.close(); } catch (e) {}
      }, 300);
    });
    ws.on('message', (m) => { try { console.log(`[${label}] msg:`, m.toString().slice(0,300)); } catch {} });
    ws.on('close', () => { console.log(`[${label}] close`); resolve(); });
    ws.on('error', (err) => { console.error(`[${label}] error:`, err.message || err); resolve(); });
  });
}

run().catch((e) => console.error('Test failed:', e));
