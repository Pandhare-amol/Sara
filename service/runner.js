const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Simple service runner: launches the packaged server in detached mode and writes pid
const projectRoot = path.resolve(__dirname, '..');
const distServer = path.join(projectRoot, 'dist', 'server.cjs');
const pidFile = path.join(projectRoot, 'data', 'service.pid');

function start() {
  const node = process.execPath;
  const script = fs.existsSync(distServer) ? distServer : path.join(projectRoot, 'server_full.ts');
  const args = fs.existsSync(distServer) ? [distServer] : ['-r', 'tsx/register', 'server_full.ts'];
  const child = spawn(node, args, { cwd: projectRoot, detached: true, stdio: 'ignore' });
  child.unref();
  try { fs.mkdirSync(path.dirname(pidFile), { recursive: true }); } catch {}
  fs.writeFileSync(pidFile, String(child.pid), 'utf8');
  console.log('SARA service started pid=' + child.pid);
}

function stop() {
  try {
    if (!fs.existsSync(pidFile)) return;
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    process.kill(pid);
    fs.unlinkSync(pidFile);
    console.log('SARA service stopped');
  } catch (e) { console.warn('Failed to stop service:', e.message); }
}

if (process.argv[2] === 'stop') stop(); else start();
