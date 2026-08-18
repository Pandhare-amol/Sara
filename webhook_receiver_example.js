// Tiny webhook receiver to test incoming webhooks
const http = require('http');
const crypto = require('crypto');

const secret = process.env.WEBHOOK_SECRET || 'shh';

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') return res.end('OK');
  let body = '';
  req.on('data', (c) => body += c.toString());
  req.on('end', () => {
    const sig = req.headers['x-sara-signature'];
    const computed = crypto.createHmac('sha256', secret).update(body).digest('hex');
    console.log('headers', req.headers);
    console.log('body', body);
    console.log('signature match', sig === computed);
    res.end('ok');
  });
});

server.listen(8081, () => console.log('webhook receiver listening on 8081'));
