const fs = require('fs');
const path = require('path');
const payload = process.argv.slice(2);
fs.writeFileSync(path.join(__dirname, 'windows_path_probe_out.txt'), JSON.stringify(payload));
console.log(payload.join('|'));