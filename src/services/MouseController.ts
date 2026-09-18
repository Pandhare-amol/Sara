import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class MouseController {
  private static pythonPath = process.env.SARA_PYTHON || 'python';
  private static cwd = process.cwd();

  private static async runPython(script: string): Promise<string> {
    const raw = await (async () => {
      try {
        const { stdout } = await execFileAsync(this.pythonPath, ['-c', script], {
          timeout: 15000,
          windowsHide: true,
          env: { ...process.env, PYTHONPATH: this.cwd },
        });
        return stdout;
      } catch (error: any) {
        console.error('MouseController Python execution failed:', error?.stderr || error?.message);
        throw new Error(`Mouse control failed: ${error?.message}`);
      }
    })();
    // Normalize output using the DesktopAgentResultAdapter
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { adaptDesktopAgentResult, unwrapResult } = require('./DesktopAgentResultAdapter');
    const result = adaptDesktopAgentResult(raw);
    return unwrapResult(result);
  }

  /** Get cursor position using native_input */
  static async getPosition(): Promise<{ x: number; y: number }> {
    const script = `
import sys, json
sys.path.append(r'${process.cwd().replace(/\\/g, '\\')}')
from desktop_agent.native_input import get_cursor_pos
x, y = get_cursor_pos()
print(json.dumps({"x": int(x), "y": int(y)}))
`;
    const output = await this.runPython(script);
    return JSON.parse(output.trim());
  }

  /** Move cursor to absolute coordinates using native_input.move_mouse_absolute */
  static async moveTo(x: number, y: number, duration: number = 0.2, mode: 'NATURAL' | 'INSTANT' = 'NATURAL'): Promise<void> {
    const script = `
import sys, time
sys.path.append(r'${process.cwd().replace(/\\/g, '\\')}')
from desktop_agent.native_input import move_mouse_absolute, get_cursor_pos
move_mouse_absolute(${x}, ${y}, duration=${duration}, mode='${mode}')
# tiny pause for system to settle
time.sleep(0.05)
pos = get_cursor_pos()
print(f"{pos[0]},{pos[1]}")
`;
    const output = await this.runPython(script);
    const [actualX, actualY] = output.trim().split(',').map(Number);
    const distance = Math.hypot(actualX - x, actualY - y);
    if (distance > 5) {
      throw new Error(`Cursor verification failed: target (${x},${y}) vs actual (${actualX},${actualY})`);
    }
  }

  /** Move cursor relative */
  static async move(xOffset: number, yOffset: number, duration: number = 0.2): Promise<void> {
    const start = await this.getPosition();
    await this.moveTo(start.x + xOffset, start.y + yOffset, duration);
  }

  /** Click using native_input.mouse_click */
  static async click(button: 'left' | 'right' | 'middle' = 'left', clicks: number = 1): Promise<void> {
    const script = `
import sys, time
sys.path.append(r'${process.cwd().replace(/\\\\/g, '\\\\')}')
from desktop_agent.native_input import mouse_click
for _ in range(${clicks}):
  mouse_click('${button}')
  time.sleep(0.05)
`;
    await this.runPython(script);
  }

  /** Click at specific coordinates */
  static async clickAt(x: number, y: number, button: 'left' | 'right' | 'middle' = 'left', clicks: number = 1): Promise<void> {
    await this.moveTo(x, y);
    await this.click(button, clicks);
  }

  /** Resolve a UI target, move to its center, and click with verification and retry */
  static async clickTarget(criteria: { title?: string; controlType?: string; x?: number; y?: number }, button: 'left' | 'right' | 'middle' = 'left', clicks: number = 1): Promise<void> {
    const { TargetResolver } = await import('./TargetResolver');
    const { SafetyCheck } = await import('./SafetyCheck');
    const { RecoveryEngine } = await import('./RecoveryEngine');

    const action = async () => {
      const { box, confidence } = await TargetResolver.resolve(criteria);
      // Verify confidence
      SafetyCheck.verifyConfidence(confidence);
      const { x, y } = await TargetResolver.boxToPoint(box);
      await this.moveTo(x, y);
      await this.click(button, clicks);
    };
    await RecoveryEngine.executeWithRecovery(action);
  }

  /** Drag to coordinates */
  static async dragTo(x: number, y: number, duration: number = 0.5, button: 'left' | 'right' | 'middle' = 'left'): Promise<void> {
    const downConst = button === 'right' ? 'MOUSEEVENTF_RIGHTDOWN' : button === 'middle' ? 'MOUSEEVENTF_MIDDLEDOWN' : 'MOUSEEVENTF_LEFTDOWN';
    const upConst = button === 'right' ? 'MOUSEEVENTF_RIGHTUP' : button === 'middle' ? 'MOUSEEVENTF_MIDDLEUP' : 'MOUSEEVENTF_LEFTUP';

    // press down
    const downScript = `
import sys
sys.path.append(r'${process.cwd().replace(/\\/g, '\\')}')
from desktop_agent.native_input import create_mouse_input, send_input, ${downConst}
inp = create_mouse_input(0,0,0,${downConst})
send_input([inp])
`;
    await this.runPython(downScript);
    // move
    await this.moveTo(x, y, duration);
    // release
    const upScript = `
import sys
sys.path.append(r'${process.cwd().replace(/\\/g, '\\')}')
from desktop_agent.native_input import create_mouse_input, send_input, MOUSEEVENTF_LEFTUP
inp = create_mouse_input(0,0,0,MOUSEEVENTF_LEFTUP)
send_input([inp])
`;
    await this.runPython(upScript);
  }

  /** Scroll using native_input */
  static async scroll(clicks: number): Promise<void> {
    const script = `
import sys
sys.path.append(r'${process.cwd().replace(/\\/g, '\\')}')
from desktop_agent.native_input import create_mouse_input, send_input, MOUSEEVENTF_WHEEL
inp = create_mouse_input(0,0,${clicks},MOUSEEVENTF_WHEEL)
send_input([inp])
`;
    await this.runPython(script);
  }
}
