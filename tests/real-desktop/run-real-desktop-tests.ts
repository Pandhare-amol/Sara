import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

type Status = 'PASS' | 'FAIL' | 'PARTIAL' | 'NOT RUN';

interface StepResult {
  id: string;
  name: string;
  status: Status;
  details: string;
  evidence?: Record<string, unknown>;
}

interface AgentResponse {
  ok: boolean;
  result?: any;
  canonical?: any;
  error?: string | null;
  tool: string;
}

const argv = process.argv.slice(2);
const args = new Set(argv);
const enableRealDesktop = args.has('--enable') || process.env.REAL_DESKTOP_TEST === '1' || process.env.REAL_DESKTOP_TEST === 'true';
const diagnostic = args.has('--diagnostic');
const allowChatGpt = args.has('--allow-chatgpt') || process.env.SARA_STRESS_ALLOW_CHATGPT === '1';
const startAgent = args.has('--start-agent') || process.env.SARA_STRESS_START_AGENT === '1';
const cleanup = !args.has('--no-cleanup');
const suite = valueArg('--suite') || 'all';
const agentBaseUrl = process.env.SARA_DESKTOP_AGENT_URL || 'http://127.0.0.1:8765';
const backendBaseUrl = process.env.SARA_BACKEND_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;
const taskId = `TASK-SARA-STRESS-${Date.now()}`;
const runId = `RUN-${Date.now()}`;
const testDir = path.join(os.tmpdir(), 'SARA_TEST');
const snakeFile = path.join(testDir, 'sara_snake_test.py');

function valueArg(name: string): string | undefined {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.split('=').slice(1).join('=');
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logStep(step: StepResult): void {
  console.log(`${step.id} ${step.name}: ${step.status}${step.details ? ` - ${step.details}` : ''}`);
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ ok: boolean; status?: number; body?: any; error?: string }> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
    const text = await res.text();
    try {
      return { ok: res.ok, status: res.status, body: text ? JSON.parse(text) : null };
    } catch {
      return { ok: res.ok, status: res.status, body: text };
    }
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

async function ensureDesktopAgent(): Promise<StepResult | null> {
  const current = await fetchJson(`${agentBaseUrl}/health`);
  if (current.ok) return null;
  if (!startAgent) return null;

  const pythonPath = process.env.SARA_PYTHON || 'python';
  const child = execFile(pythonPath, ['-m', 'desktop_agent.main'], {
    cwd: process.cwd(),
    windowsHide: true,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
  });
  child.unref();

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const health = await fetchJson(`${agentBaseUrl}/health`);
    if (health.ok) {
      return {
        id: 'PHASE-000B0',
        name: 'Desktop Agent auto-start',
        status: 'PASS',
        details: `Started Desktop Agent with ${pythonPath} -m desktop_agent.main.`,
        evidence: { pid: child.pid },
      };
    }
    await wait(500);
  }

  return {
    id: 'PHASE-000B0',
    name: 'Desktop Agent auto-start',
    status: 'FAIL',
    details: `Desktop Agent did not become healthy after starting with ${pythonPath}.`,
    evidence: { pid: child.pid },
  };
}

async function callAgent(tool: string, toolArgs: Record<string, unknown> = {}, actionIndex = 0): Promise<AgentResponse> {
  const padded = String(actionIndex).padStart(3, '0');
  const payload = {
    tool,
    args: {
      ...toolArgs,
      taskId,
      actionId: `ACTION-${padded}`,
      executionId: `EXEC-${padded}`,
      eventId: `EVENT-${padded}`,
      correlationId: runId,
    },
  };
  const response = await fetchJson(`${agentBaseUrl}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    return { ok: false, error: response.error || `HTTP ${response.status}`, tool };
  }
  return response.body as AgentResponse;
}

function agentPassed(response: AgentResponse): boolean {
  return response.ok === true && response.canonical?.status !== 'FAILED';
}

async function checkWindowsPrereqs(): Promise<StepResult> {
  if (process.platform !== 'win32') {
    return { id: 'PHASE-000', name: 'Windows interactive session', status: 'NOT RUN', details: 'Not running on Windows.' };
  }
  if (!process.env.SESSIONNAME && !process.env.USERPROFILE) {
    return { id: 'PHASE-000', name: 'Windows interactive session', status: 'NOT RUN', details: 'No interactive Windows session detected.' };
  }
  if (!enableRealDesktop) {
    return { id: 'PHASE-000', name: 'Windows interactive session', status: 'NOT RUN', details: 'Use --enable or REAL_DESKTOP_TEST=1 to permit real desktop control.' };
  }
  return { id: 'PHASE-000', name: 'Windows interactive session', status: 'PASS', details: 'Interactive Windows session detected.' };
}

async function healthCheck(): Promise<StepResult[]> {
  const steps: StepResult[] = [];
  const backend = await fetchJson(`${backendBaseUrl}/health`);
  steps.push({
    id: 'PHASE-000A',
    name: 'SARA backend health',
    status: backend.ok ? 'PASS' : 'FAIL',
    details: backend.ok ? 'Backend health endpoint responded.' : backend.error || `HTTP ${backend.status}`,
    evidence: { url: `${backendBaseUrl}/health`, status: backend.status },
  });

  const started = await ensureDesktopAgent();
  if (started) {
    steps.push(started);
  }

  const agent = await fetchJson(`${agentBaseUrl}/health`);
  steps.push({
    id: 'PHASE-000B',
    name: 'Desktop Agent health',
    status: agent.ok ? 'PASS' : 'FAIL',
    details: agent.ok ? 'Desktop Agent health endpoint responded.' : agent.error || `HTTP ${agent.status}`,
    evidence: { url: `${agentBaseUrl}/health`, input_control: agent.body?.input_control },
  });

  if (!agent.ok) return steps;

  const mouse = await callAgent('hardwareMousePosition', {}, 1);
  steps.push({
    id: 'PHASE-000C',
    name: 'Mouse position read',
    status: agentPassed(mouse) && Number.isFinite(Number(mouse.result?.x)) ? 'PASS' : 'FAIL',
    details: agentPassed(mouse) ? `Mouse at ${mouse.result?.x}, ${mouse.result?.y}.` : mouse.error || 'Mouse position tool failed.',
    evidence: { result: mouse.result, canonical: mouse.canonical },
  });

  const active = await callAgent('getActiveWindow', {}, 2);
  steps.push({
    id: 'PHASE-000D',
    name: 'Active window detection',
    status: agentPassed(active) ? 'PASS' : 'FAIL',
    details: agentPassed(active) ? 'Active window detected through Desktop Agent.' : active.error || 'Active window tool failed.',
    evidence: { result: active.result, canonical: active.canonical },
  });

  const screenshot = await callAgent('takeScreenshot', { include_image: false }, 3);
  const hasSize = Number(screenshot.result?.width || 0) > 0 && Number(screenshot.result?.height || 0) > 0;
  steps.push({
    id: 'PHASE-000E',
    name: 'Screen capture',
    status: agentPassed(screenshot) && hasSize ? 'PASS' : 'FAIL',
    details: hasSize ? `Captured ${screenshot.result.width}x${screenshot.result.height}.` : screenshot.error || 'Screenshot did not include dimensions.',
    evidence: { result: screenshot.result, canonical: screenshot.canonical },
  });

  const keyboard = await callAgent('hardwareKeyboardPress', { keys: ['shift'] }, 4);
  steps.push({
    id: 'PHASE-000F',
    name: 'Keyboard controller availability',
    status: agentPassed(keyboard) ? 'PASS' : 'FAIL',
    details: agentPassed(keyboard) ? 'Keyboard press executed through Desktop Agent.' : keyboard.error || 'Keyboard press failed.',
    evidence: { result: keyboard.result, canonical: keyboard.canonical },
  });

  return steps;
}

async function findWindow(query: string): Promise<any | null> {
  const response = await callAgent('listWindows', { include_untitled: false }, 20);
  const windows = response.result?.verification?.details?.windows || response.canonical?.data?.verification?.details?.windows || [];
  return Array.isArray(windows)
    ? windows.find((window: any) =>
        String(window.title || '').toLowerCase().includes(query.toLowerCase()) ||
        String(window.process_name || '').toLowerCase().includes(query.toLowerCase()))
    : null;
}

async function waitForWindow(query: string, timeoutMs = 15000): Promise<any | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await findWindow(query);
    if (found) return found;
    await wait(500);
  }
  return null;
}

async function openNotepadViaStart(actionBase: number): Promise<StepResult> {
  await callAgent('hardwareKeyboardPress', { keys: ['win'] }, actionBase);
  await wait(700);
  await callAgent('hardwareKeyboardType', { text: 'Notepad', interval: 0.01 }, actionBase + 1);
  await wait(700);
  await callAgent('hardwareKeyboardPress', { keys: ['enter'] }, actionBase + 2);
  const window = await waitForWindow('notepad', 15000);
  return {
    id: 'PHASE-001',
    name: 'Open Notepad via Windows Start search',
    status: window ? 'PASS' : 'FAIL',
    details: window ? `Detected Notepad window: ${window.title}` : 'Notepad window was not detected after Start search.',
    evidence: { window },
  };
}

async function minimizeRestoreMoveCloseNotepad(): Promise<StepResult[]> {
  const steps: StepResult[] = [];
  let window = await waitForWindow('notepad', 5000);
  if (!window) {
    steps.push({ id: 'PHASE-002', name: 'Verify Notepad', status: 'FAIL', details: 'Notepad window not found.' });
    return steps;
  }

  const focus = await callAgent('focusWindow', { title: 'notepad' }, 30);
  steps.push({
    id: 'PHASE-002',
    name: 'Verify Notepad foreground',
    status: agentPassed(focus) ? 'PASS' : 'FAIL',
    details: agentPassed(focus) ? 'Notepad focused.' : focus.error || 'Focus failed.',
    evidence: { focus: focus.result },
  });

  const minimize = await callAgent('minimizeWindow', { title: 'notepad' }, 31);
  await wait(700);
  window = await findWindow('notepad');
  steps.push({
    id: 'PHASE-003',
    name: 'Minimize Notepad',
    status: agentPassed(minimize) && window?.minimized === true ? 'PASS' : 'FAIL',
    details: window?.minimized ? 'Notepad minimized and verified.' : 'Notepad minimize state was not verified.',
    evidence: { response: minimize.result, window },
  });

  const restore = await callAgent('focusWindow', { title: 'notepad' }, 32);
  await wait(700);
  window = await findWindow('notepad');
  steps.push({
    id: 'PHASE-004',
    name: 'Restore Notepad',
    status: agentPassed(restore) && window?.minimized === false ? 'PASS' : 'FAIL',
    details: window && !window.minimized ? 'Notepad restored and visible.' : 'Notepad restore state was not verified.',
    evidence: { response: restore.result, window },
  });

  if (window?.bounds) {
    const before = window.bounds;
    const startX = Math.round(before.x + before.width / 2);
    const startY = Math.round(before.y + 12);
    const endX = startX + 80;
    const endY = startY + 40;
    const drag = await callAgent('hardwareMouseDrag', { start_x: startX, start_y: startY, x: endX, y: endY, duration: 0.35, button: 'left' }, 33);
    await wait(900);
    const afterWindow = await findWindow('notepad');
    const after = afterWindow?.bounds;
    const moved = Boolean(after && (Math.abs(after.x - before.x) > 10 || Math.abs(after.y - before.y) > 10));
    steps.push({
      id: 'PHASE-005',
      name: 'Move Notepad window by title bar drag',
      status: agentPassed(drag) && moved ? 'PASS' : 'FAIL',
      details: moved ? `Window moved from ${before.x},${before.y} to ${after.x},${after.y}.` : 'Window bounds did not change enough to verify movement.',
      evidence: { before, after, drag: drag.result },
    });
  } else {
    steps.push({ id: 'PHASE-005', name: 'Move Notepad window by title bar drag', status: 'FAIL', details: 'Window bounds unavailable.' });
  }

  const close = await callAgent('closeWindow', { title: 'notepad' }, 34);
  await wait(1000);
  const afterClose = await findWindow('notepad');
  steps.push({
    id: 'PHASE-006',
    name: 'Close Notepad',
    status: agentPassed(close) && !afterClose ? 'PASS' : 'FAIL',
    details: !afterClose ? 'Notepad window closed.' : 'Notepad window still exists after close.',
    evidence: { response: close.result, afterClose },
  });

  return steps;
}

function snakeSource(): string {
  return String.raw`import tkinter as tk
import random

CELL = 20
WIDTH = 24
HEIGHT = 18

class SnakeGame:
    def __init__(self, root):
        self.root = root
        self.root.title("SARA Snake Test")
        self.canvas = tk.Canvas(root, width=WIDTH * CELL, height=HEIGHT * CELL, bg="black")
        self.canvas.pack()
        self.label = tk.Label(root, text="Score: 0")
        self.label.pack()
        root.bind("<KeyPress>", self.on_key)
        self.reset()

    def reset(self):
        self.snake = [(8, 8), (7, 8), (6, 8)]
        self.direction = (1, 0)
        self.pending = (1, 0)
        self.score = 0
        self.game_over = False
        self.spawn_food()
        self.tick()

    def spawn_food(self):
        while True:
            self.food = (random.randrange(WIDTH), random.randrange(HEIGHT))
            if self.food not in self.snake:
                return

    def on_key(self, event):
        key = event.keysym
        mapping = {"Up": (0, -1), "Down": (0, 1), "Left": (-1, 0), "Right": (1, 0)}
        if key.lower() == "r" and self.game_over:
            self.reset()
            return
        if key in mapping:
            dx, dy = mapping[key]
            if (dx, dy) != (-self.direction[0], -self.direction[1]):
                self.pending = (dx, dy)

    def tick(self):
        if not self.game_over:
            self.direction = self.pending
            head_x, head_y = self.snake[0]
            dx, dy = self.direction
            head = ((head_x + dx) % WIDTH, (head_y + dy) % HEIGHT)
            if head in self.snake:
                self.game_over = True
            else:
                self.snake.insert(0, head)
                if head == self.food:
                    self.score += 1
                    self.spawn_food()
                else:
                    self.snake.pop()
        self.draw()
        self.root.after(120, self.tick)

    def draw(self):
        self.canvas.delete("all")
        self.label.config(text=f"Score: {self.score}" + (" - Game Over - Press R" if self.game_over else ""))
        fx, fy = self.food
        self.canvas.create_rectangle(fx * CELL, fy * CELL, (fx + 1) * CELL, (fy + 1) * CELL, fill="red")
        for index, (x, y) in enumerate(self.snake):
            color = "lime" if index == 0 else "green"
            self.canvas.create_rectangle(x * CELL, y * CELL, (x + 1) * CELL, (y + 1) * CELL, fill=color)

if __name__ == "__main__":
    root = tk.Tk()
    SnakeGame(root)
    root.mainloop()
`;
}

async function runSafeSnakeWorkflow(): Promise<StepResult[]> {
  const steps: StepResult[] = [];
  fs.mkdirSync(testDir, { recursive: true });
  fs.writeFileSync(snakeFile, snakeSource(), 'utf8');
  const stat = fs.statSync(snakeFile);
  steps.push({
    id: 'PHASE-016',
    name: 'Verify temporary Python file',
    status: stat.size > 0 ? 'PASS' : 'FAIL',
    details: `${snakeFile} size=${stat.size}`,
    evidence: { snakeFile, size: stat.size },
  });

  try {
    const version = await execFileAsync(process.env.SARA_PYTHON || 'python', ['--version'], { timeout: 10000, windowsHide: true });
    steps.push({ id: 'PHASE-018', name: 'Verify Python environment', status: 'PASS', details: String(version.stdout || version.stderr).trim() });
  } catch (error: any) {
    steps.push({ id: 'PHASE-018', name: 'Verify Python environment', status: 'FAIL', details: String(error?.message || error) });
    return steps;
  }

  const child = execFile(process.env.SARA_PYTHON || 'python', [snakeFile], { windowsHide: false });
  await wait(2500);
  const gameWindow = await waitForWindow('SARA Snake Test', 10000);
  steps.push({
    id: 'PHASE-019',
    name: 'Launch and verify Snake game',
    status: gameWindow ? 'PASS' : 'FAIL',
    details: gameWindow ? 'Snake game window detected.' : 'Snake game window was not detected.',
    evidence: { gameWindow },
  });

  if (gameWindow) {
    await callAgent('focusWindow', { title: 'SARA Snake Test' }, 50);
    const keyResults = [];
    for (const key of ['right', 'down', 'left', 'up']) {
      const response = await callAgent('hardwareKeyboardPress', { keys: [key] }, 51 + keyResults.length);
      keyResults.push({ key, ok: agentPassed(response), response: response.result });
      await wait(300);
    }
    const stillOpen = await findWindow('SARA Snake Test');
    steps.push({
      id: 'PHASE-020',
      name: 'Interact with Snake using arrow keys',
      status: keyResults.every((result) => result.ok) && stillOpen ? 'PASS' : 'FAIL',
      details: stillOpen ? 'Arrow keys sent with game window still alive.' : 'Game window disappeared after keyboard input.',
      evidence: { keyResults, stillOpen },
    });

    const close = await callAgent('closeWindow', { title: 'SARA Snake Test' }, 60);
    await wait(1000);
    const afterClose = await findWindow('SARA Snake Test');
    steps.push({
      id: 'PHASE-022',
      name: 'Close Snake game',
      status: agentPassed(close) && !afterClose ? 'PASS' : 'FAIL',
      details: !afterClose ? 'Snake game closed.' : 'Snake game window still exists.',
      evidence: { close: close.result, afterClose },
    });
  }

  if (!child.killed) {
    try { child.kill(); } catch {}
  }

  if (cleanup) {
    try {
      if (fs.existsSync(snakeFile)) fs.unlinkSync(snakeFile);
      if (fs.existsSync(testDir) && fs.readdirSync(testDir).length === 0) fs.rmdirSync(testDir);
      steps.push({ id: 'PHASE-023', name: 'Cleanup temporary test artifacts', status: 'PASS', details: `Removed ${snakeFile}.` });
    } catch (error) {
      steps.push({ id: 'PHASE-023', name: 'Cleanup temporary test artifacts', status: 'FAIL', details: String(error) });
    }
  } else {
    steps.push({ id: 'PHASE-023', name: 'Cleanup temporary test artifacts', status: 'NOT RUN', details: '--no-cleanup was supplied.' });
  }

  return steps;
}

async function runChatGptPhase(): Promise<StepResult[]> {
  if (!allowChatGpt) {
    return [{
      id: 'PHASE-007-015',
      name: 'Browser and ChatGPT live workflow',
      status: 'NOT RUN',
      details: 'Live ChatGPT browser workflow requires --allow-chatgpt because it depends on user login/session state and external UI availability.',
    }];
  }
  const open = await callAgent('browserOpen', { url: 'https://chatgpt.com/' }, 70);
  await wait(3000);
  const state = await fetchJson(`${agentBaseUrl}/browser/state`);
  return [{
    id: 'PHASE-007-015',
    name: 'Browser and ChatGPT live workflow',
    status: agentPassed(open) && state.ok ? 'PARTIAL' : 'FAIL',
    details: agentPassed(open)
      ? 'Browser opened ChatGPT. Manual login/page-state dependent code-copy workflow is not yet fully automated by this runner.'
      : open.error || 'Browser open failed.',
    evidence: { open: open.result, browserState: state.body },
  }];
}

function summarize(steps: StepResult[]): Status {
  const runnable = steps.filter((step) => step.status !== 'NOT RUN');
  if (runnable.length === 0) return 'NOT RUN';
  if (runnable.every((step) => step.status === 'PASS')) return 'PASS';
  if (runnable.some((step) => step.status === 'PASS' || step.status === 'PARTIAL')) return 'PARTIAL';
  return 'FAIL';
}

function statusFor(steps: StepResult[], names: string[]): Status {
  const matches = steps.filter((step) => names.some((name) => step.name.includes(name)));
  return summarize(matches);
}

function printFinalReport(steps: StepResult[]): void {
  const overall = summarize(steps);
  console.log('');
  console.log('SARA REAL-WORLD DESKTOP STRESS TEST');
  console.log('===================================');
  console.log(`Overall: ${overall}`);
  console.log(`Mouse: ${statusFor(steps, ['Mouse position read', 'Move Notepad'])}`);
  console.log(`Keyboard: ${statusFor(steps, ['Keyboard controller availability', 'Open Notepad', 'Interact with Snake'])}`);
  console.log(`Screen observation: ${statusFor(steps, ['Screen capture', 'Active window detection'])}`);
  console.log(`Window control: ${statusFor(steps, ['Minimize Notepad', 'Restore Notepad', 'Close Notepad', 'Close Snake'])}`);
  console.log(`Browser/ChatGPT: ${statusFor(steps, ['Browser and ChatGPT'])}`);
  console.log(`File handling: ${statusFor(steps, ['Verify temporary Python file', 'Cleanup temporary'])}`);
  console.log(`Python execution: ${statusFor(steps, ['Verify Python environment', 'Launch and verify Snake'])}`);
  console.log('');
  console.log('FAILED STEPS');
  console.log('------------');
  const failed = steps.filter((step) => step.status === 'FAIL');
  console.log(failed.length ? failed.map((step) => `${step.id} ${step.name}: ${step.details}`).join('\n') : 'None');
  console.log('');
  console.log('NOT RUN / PARTIAL STEPS');
  console.log('-----------------------');
  const skipped = steps.filter((step) => step.status === 'NOT RUN' || step.status === 'PARTIAL');
  console.log(skipped.length ? skipped.map((step) => `${step.id} ${step.name}: ${step.status} - ${step.details}`).join('\n') : 'None');
}

async function main(): Promise<void> {
  const steps: StepResult[] = [];
  const prereq = await checkWindowsPrereqs();
  steps.push(prereq);
  logStep(prereq);
  if (prereq.status !== 'PASS') {
    printFinalReport(steps);
    return;
  }

  const health = await healthCheck();
  steps.push(...health);
  health.forEach(logStep);
  if (diagnostic) {
    printFinalReport(steps);
    return;
  }
  if (health.some((step) => step.status === 'FAIL')) {
    printFinalReport(steps);
    return;
  }

  const selectedSuite = suite.toLowerCase();
  if (selectedSuite === 'notepad' || selectedSuite === 'all' || selectedSuite === 'stress') {
    const open = await openNotepadViaStart(10);
    steps.push(open);
    logStep(open);
    const windowSteps = await minimizeRestoreMoveCloseNotepad();
    steps.push(...windowSteps);
    windowSteps.forEach(logStep);
  }

  if (selectedSuite === 'browser' || selectedSuite === 'all' || selectedSuite === 'stress') {
    const browserSteps = await runChatGptPhase();
    steps.push(...browserSteps);
    browserSteps.forEach(logStep);
  }

  if (selectedSuite === 'snake' || selectedSuite === 'all' || selectedSuite === 'stress') {
    const snakeSteps = await runSafeSnakeWorkflow();
    steps.push(...snakeSteps);
    snakeSteps.forEach(logStep);
  }

  printFinalReport(steps);
}

void main().then(() => {
  process.exit(0);
}).catch((error) => {
  console.error('REAL DESKTOP TEST HARNESS FAILED');
  console.error(error);
  process.exit(1);
});
