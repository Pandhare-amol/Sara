const http = require('http');

function startStub(port = 8765) {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, tool_count: 10 }));
      return;
    }
    if (req.method === 'POST' && req.url === '/execute') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        try {
          const payload = JSON.parse(body || '{}');
          const { tool, args } = payload;
          // Simple canned responses for tests
          if (tool === 'saraVoiceParseCommand') {
            return res.end(JSON.stringify({ ok: true, result: { intent: 'application.automation', tool: 'whatsapp_send', args: { phone: args.command?.match(/\+?\d+/)?.[0] || '+15551234567', message: 'hello from test' }, confidence: 0.9, requires_confirmation: true, response: 'I need confirmation to send this message.' } }));
          }
          if (tool === 'saraVoiceExecuteCommand') {
            // Simulate requires_confirmation when not confirmed
            if (!args || !args.confirmed) {
              return res.end(JSON.stringify({ ok: true, result: { requires_confirmation: true, parsed: { intent: 'application.automation', tool: 'whatsapp_send', args: { phone: '+15551234567', message: 'hello from test' }, response: 'Please confirm.' }, result: 'confirmation required' } }));
            }
            return res.end(JSON.stringify({ ok: true, result: { executed: true } }));
          }
          if (tool === 'whatsapp_send') {
            return res.end(JSON.stringify({ ok: true, result: { sent: true } }));
          }
          if (tool === 'desktopBrowserReadPage') {
            return res.end(JSON.stringify({ ok: true, result: String(args?.max_chars ? '... hello from chat ...' : '') }));
          }
          // Default
          res.end(JSON.stringify({ ok: true, result: { tool, args } }));
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ ok: false, error: String(e) }));
        }
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

module.exports = { startStub };
