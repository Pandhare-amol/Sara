// Simple WebSocket client example to subscribe to task events (ESM)
import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:3000/live');
ws.on('open', () => console.log('connected to /live'));
ws.on('message', (m) => {
  try {
    const d = JSON.parse(m.toString());
    console.log('event', d.type || 'msg', d);
  } catch (e) {
    console.log('raw', m.toString());
  }
});
