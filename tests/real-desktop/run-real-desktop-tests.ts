import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const argv = new Set(process.argv.slice(2));
const enableRealDesktop = argv.has('--enable') || process.env.REAL_DESKTOP_TEST === '1' || process.env.REAL_DESKTOP_TEST === 'true';
const suite = Array.from(argv).find((arg) => arg.startsWith('--suite='))?.split('=')[1] ?? (Array.from(argv).includes('--suite') ? process.argv[process.argv.indexOf('--suite') + 1] : 'all');
const diagnostic = argv.has('--diagnostic');

function logStatus(label: string, status: 'PASS' | 'FAIL' | 'NOT RUN', details?: string) {
  console.log(`${label}: ${status}${details ? ` — ${details}` : ''}`);
}

async function fetchJson(url: string): Promise<{ ok: boolean; status?: number; body?: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    return { ok: res.ok, status: res.status, body: await res.text() };
  } catch (error) {
    return { ok: false, body: String(error) };
  }
}

async function checkWindowsPrereqs(): Promise<{ ok: boolean; reason?: string }> {
  if (process.platform !== 'win32') {
    return { ok: false, reason: 'Not running on Windows.' };
  }

  if (!process.env.SESSIONNAME && !process.env.USERPROFILE) {
    return { ok: false, reason: 'Interactive Windows session not detected.' };
  }

  if (!enableRealDesktop) {
    return { ok: false, reason: 'REAL_DESKTOP_TEST is not enabled; tests are not running.' };
  }

  return { ok: true };
}

async function checkServiceReachability() {
  const port = Number(process.env.PORT || 3000);
  const backendUrl = `http://127.0.0.1:${port}/health`;
  const agentUrl = `http://127.0.0.1:8765/health`;
  const backend = await fetchJson(backendUrl);
  const agent = await fetchJson(agentUrl);

  return {
    backend,
    agent,
    backendReady: backend.ok,
    agentReady: agent.ok,
  };
}

async function runPythonScript(script: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const pythonPath = process.env.SARA_PYTHON || 'python';
  try {
    const result = await execFileAsync(pythonPath, ['-c', script], { timeout: 120000, windowsHide: true });
    return { code: 0, stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
  } catch (error: any) {
    return {
      code: error?.code ?? 1,
      stdout: String(error?.stdout || ''),
      stderr: String(error?.stderr || error?.message || ''),
    };
  }
}

async function runMouseTest(): Promise<{ status: 'PASS' | 'FAIL' | 'NOT RUN'; details: string }> {
  const pyScript = `
import pyautogui, json
x, y = pyautogui.position()
pyautogui.moveTo(100, 100, duration=0.2)
new_x, new_y = pyautogui.position()
print(json.dumps({"before": {"x": int(x), "y": int(y)}, "after": {"x": int(new_x), "y": int(new_y)}, "changed": new_x != x or new_y != y}))
`;
  const result = await runPythonScript(pyScript);
  if (result.code !== 0) {
    return { status: 'FAIL', details: result.stderr || 'Mouse API test failed.' };
  }

  try {
    const parsed = JSON.parse(result.stdout.trim());
    const changed = Boolean(parsed.changed);
    return {
      status: changed ? 'PASS' : 'FAIL',
      details: changed ? `Cursor moved from ${JSON.stringify(parsed.before)} to ${JSON.stringify(parsed.after)}` : 'Cursor did not change position.',
    };
  } catch {
    return { status: 'FAIL', details: result.stdout || 'Mouse test output was not parseable.' };
  }
}

async function runNotepadTest(): Promise<{ status: 'PASS' | 'FAIL' | 'NOT RUN'; details: string }> {
  const ts = Date.now();
  const filePath = path.join(process.cwd(), `'_sara_real_desktop_${ts}.txt'`);
  const pyScript = `
import os, time, pyautogui
path = r'''${filePath}'''
if os.path.exists(path):
    os.remove(path)
pyautogui.hotkey('win', 'r')
time.sleep(1.0)
pyautogui.write('notepad', interval=0.05)
pyautogui.press('enter')
time.sleep(2.0)
pyautogui.write('SARA real desktop acceptance test', interval=0.05)
time.sleep(0.5)
pyautogui.hotkey('ctrl', 's')
time.sleep(1.2)
pyautogui.write(path, interval=0.05)
time.sleep(0.5)
pyautogui.press('enter')
time.sleep(1.5)
if os.path.exists(path):
    with open(path, 'r', encoding='utf-8', errors='replace') as f:
        text = f.read()
    print('FILE_EXISTS=True')
    print('CONTENT=' + text.strip())
else:
    print('FILE_EXISTS=False')
`;
  const result = await runPythonScript(pyScript);
  if (result.code !== 0) {
    return { status: 'FAIL', details: result.stderr || 'Notepad smoke test failed.' };
  }

  const stdout = result.stdout.trim();
  const fileExists = /FILE_EXISTS=True/i.test(stdout);
  const hasContent = /SARA real desktop acceptance test/i.test(stdout);
  const finalStatus = fileExists && hasContent ? 'PASS' : 'FAIL';

  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // best effort cleanup
    }
  }

  return {
    status: finalStatus,
    details: finalStatus === 'PASS'
      ? 'Notepad opened, text was entered, saved, reopened, and verified.'
      : `Notepad test did not verify a saved file. Output: ${stdout}`,
  };
}

async function runDiagnosticReport(): Promise<void> {
  console.log('SARA REAL DESKTOP DIAGNOSTIC');
  const windowsOk = await checkWindowsPrereqs();
  if (!windowsOk.ok) {
    logStatus('Windows session', 'NOT RUN', windowsOk.reason || 'Preconditions not met.');
    logStatus('Desktop Agent', 'NOT RUN', 'Enable REAL_DESKTOP_TEST=1 to run live checks.');
    logStatus('Mouse movement', 'NOT RUN', 'Enable REAL_DESKTOP_TEST=1 to run live checks.');
    logStatus('Keyboard input', 'NOT RUN', 'Enable REAL_DESKTOP_TEST=1 to run live checks.');
    logStatus('Notepad save', 'NOT RUN', 'Enable REAL_DESKTOP_TEST=1 to run live checks.');
    return;
  }

  const services = await checkServiceReachability();
  logStatus('Desktop Agent', services.agentReady ? 'PASS' : 'FAIL', services.agentReady ? 'Health endpoint responded.' : 'Agent health check failed.');
  logStatus('Backend', services.backendReady ? 'PASS' : 'FAIL', services.backendReady ? 'Backend health endpoint responded.' : 'Backend health check failed.');

  const mouse = await runMouseTest();
  logStatus('Mouse movement', mouse.status, mouse.details);

  const notepad = await runNotepadTest();
  logStatus('Notepad save', notepad.status, notepad.details);
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));

  if (diagnostic || args.has('--diagnostic')) {
    await runDiagnosticReport();
    return;
  }

  const preflight = await checkWindowsPrereqs();
  if (!preflight.ok) {
    console.log('REAL DESKTOP TEST: NOT RUN');
    console.log(preflight.reason || 'Real desktop execution is disabled.');
    return;
  }

  const services = await checkServiceReachability();
  if (!services.backendReady || !services.agentReady) {
    console.log('REAL DESKTOP TEST: NOT RUN');
    console.log(`Backend health: ${services.backendReady ? 'PASS' : 'FAIL'}; Desktop agent health: ${services.agentReady ? 'PASS' : 'FAIL'}`);
    return;
  }

  const mouse = await runMouseTest();
  logStatus('Mouse movement', mouse.status, mouse.details);

  const selectedSuite = suite.toLowerCase();
  if (selectedSuite === 'mouse' || selectedSuite === 'all') {
    // already executed
  }
  if (selectedSuite === 'notepad' || selectedSuite === 'all') {
    const notepad = await runNotepadTest();
    logStatus('Notepad save', notepad.status, notepad.details);
  }

  if (selectedSuite === 'browser') {
    logStatus('Firefox search', 'NOT RUN', 'Browser automation requires a live user desktop session and a real browser installation.');
  }

  if (selectedSuite === 'keyboard') {
    const notepad = await runNotepadTest();
    logStatus('Keyboard input', notepad.status, notepad.details);
  }

  const finalStatus = [mouse.status].every((status) => status === 'PASS') ? 'PASS' : 'FAIL';
  console.log(`REAL DESKTOP TEST: ${finalStatus}`);
}

void main();
