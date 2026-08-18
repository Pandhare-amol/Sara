const fs = require('fs');
const p = require('path');
const file = p.resolve(__dirname, '..', 'conversations.json');
const data = { testWrite: new Date().toISOString() };
fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
console.log('Wrote', file);