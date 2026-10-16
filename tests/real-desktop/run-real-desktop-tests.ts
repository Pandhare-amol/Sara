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

async function fetchJson(url: string): Promise<{ ok: boolean; status?: number; body?: string; data?: any }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    const body = await res.text();
    let data: any = null;
    try { data = body ? JSON.parse(body) : null; } catch { data = null; }
    return { ok: res.ok, status: res.status, body, data };
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
  const backendOrigin = `http://127.0.0.1:${port}`;
  const backend = await fetchJson(`${backendOrigin}/health`);
  const agent = await fetchJson("http://127.0.0.1:8765/health");
  // /health is deliberately public liveness only. Ask the backend to report
  // whether its protected token handshake succeeded before calling the agent ready.
  const agentReadiness = backend.ok
    ? await fetchJson(`${backendOrigin}/api/agent-health`)
    : { ok: false, data: null };
  const agentProtocolReady = agent.data?.service === "sara-desktop-agent" &&
    agent.data?.agent_auth_required === true &&
    Number(agent.data?.agent_auth_protocol_version) === 1;
  const agentReady = agentProtocolReady &&
    agentReadiness.ok && agentReadiness.data?.agent_auth_verified === true;

  return {
    backend,
    agent,
    agentReadiness,
    backendReady: backend.ok,
    agentLiveness: agent.ok,
    agentReady,
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
before_x, before_y = pyautogui.position()
width, height = pyautogui.size()
target_x = min(max(before_x + 25, 0), max(width - 1, 0))
target_y = min(max(before_y + 25, 0), max(height - 1, 0))
if (target_x, target_y) == (before_x, before_y):
    target_x = max(before_x - 25, 0)
    target_y = max(before_y - 25, 0)
changed = False
move_error = None
try:
    pyautogui.moveTo(target_x, target_y, duration=0.2)
    moved_x, moved_y = pyautogui.position()
    changed = moved_x != before_x or moved_y != before_y
except Exception as exc:
    move_error = str(exc)
finally:
    try:
        pyautogui.moveTo(before_x, before_y, duration=0.2)
    except Exception as exc:
        move_error = move_error or str(exc)
restored_x, restored_y = pyautogui.position()
print(json.dumps({"before": [int(before_x), int(before_y)], "target": [int(target_x), int(target_y)], "changed": changed, "restored": (restored_x, restored_y) == (before_x, before_y), "error": move_error}))
`;
  const result = await runPythonScript(pyScript);
  if (result.code !== 0) {
    return { status: 'FAIL', details: result.stderr || 'Mouse API test failed.' };
  }

  try {
    const parsed = JSON.parse(result.stdout.trim());
    const passed = Boolean(parsed.changed && parsed.restored && !parsed.error);
    return {
      status: passed ? 'PASS' : 'FAIL',
      details: passed
        ? `Cursor moved to ${JSON.stringify(parsed.target)} and was restored to ${JSON.stringify(parsed.before)}.`
        : `Mouse movement/restoration was not verified: ${JSON.stringify(parsed)}`,
    };
  } catch {
    return { status: 'FAIL', details: result.stdout || 'Mouse test output was not parseable.' };
  }
}

async function runNotepadTest(): Promise<{ status: 'PASS' | 'FAIL' | 'NOT RUN'; details: string }> {
  const ts = Date.now();
  const filePath = path.join(process.cwd(), `_sara_real_desktop_${ts}.txt`);
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

  try {
    const result = await runPythonScript(pyScript);
    if (result.code !== 0) {
      return { status: 'FAIL', details: result.stderr || 'Notepad smoke test failed.' };
    }

    const stdout = result.stdout.trim();
    const fileExists = /FILE_EXISTS=True/i.test(stdout);
    const hasContent = /SARA real desktop acceptance test/i.test(stdout);
    const finalStatus = fileExists && hasContent ? 'PASS' : 'FAIL';
    return {
      status: finalStatus,
      details: finalStatus === 'PASS'
        ? 'Notepad opened, keyboard input was entered, saved, and verified from disk.'
        : `Notepad test did not verify a saved file. Output: ${stdout}`,
    };
  } finally {
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch { /* best-effort cleanup */ }
    }
  }
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
  logStatus('Desktop Agent', services.agentReady ? 'PASS' : 'FAIL', services.agentReady ? 'Backend verified the authenticated agent protocol.' : services.agentLiveness ? 'Health endpoint responded, but authenticated readiness is unverified.' : 'Agent health check failed.');
  logStatus('Backend', services.backendReady ? 'PASS' : 'FAIL', services.backendReady ? 'Backend health endpoint responded.' : 'Backend health check failed.');
  if (!services.backendReady || !services.agentReady) {
    logStatus('Mouse movement', 'NOT RUN', 'Authenticated service readiness was not verified.');
    logStatus('Notepad save', 'NOT RUN', 'Authenticated service readiness was not verified.');
    return;
  }

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
    console.log(`Backend health: ${services.backendReady ? 'PASS' : 'FAIL'}; Desktop agent authenticated readiness: ${services.agentReady ? 'PASS' : 'FAIL'} (public /health is liveness only).`);
    return;
  }

  const selectedSuite = suite.toLowerCase();
  const results: Array<{ label: string; status: 'PASS' | 'FAIL' | 'NOT RUN'; details: string }> = [];
  if (selectedSuite === 'mouse' || selectedSuite === 'all') {
    const result = await runMouseTest();
    results.push({ label: 'Mouse movement', ...result });
  }
  if (selectedSuite === 'keyboard' || selectedSuite === 'notepad' || selectedSuite === 'all') {
    const result = await runNotepadTest();
    results.push({ label: selectedSuite === 'keyboard' ? 'Keyboard input' : 'Notepad save', ...result });
  }
  if (selectedSuite === 'browser') {
    results.push({ label: 'Browser automation', status: 'NOT RUN', details: 'Browser automation requires a separate live browser acceptance test.' });
  }
  if (results.length === 0) {
    results.push({ label: 'Requested suite', status: 'NOT RUN', details: `Unknown or unsupported suite: ${selectedSuite}.` });
  }

  for (const result of results) logStatus(result.label, result.status, result.details);
  const statuses = results.map((result) => result.status);
  const finalStatus = statuses.some((status) => status === 'FAIL')
    ? 'FAIL'
    : statuses.every((status) => status === 'PASS') ? 'PASS' : 'NOT RUN';
  console.log(`REAL DESKTOP TEST: ${finalStatus}`);
}

void main();
