// src/services/KeyboardController.ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class KeyboardController {
  private static pythonPath = process.env.SARA_PYTHON || 'python';
  private static cwd = process.cwd();

  private static async runPython(script: string): Promise<string> {
    const raw = await (async () => {
      const { stdout } = await execFileAsync(this.pythonPath, ['-c', script], {
        timeout: 15000,
        windowsHide: true,
        env: { ...process.env, PYTHONPATH: this.cwd },
      });
      return stdout;
    })();
    // Normalize output using the DesktopAgentResultAdapter
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { adaptDesktopAgentResult, unwrapResult } = require('./DesktopAgentResultAdapter');
    const result = adaptDesktopAgentResult(raw);
    return unwrapResult(result);
  }

  /** Type a string as keyboard input */
  static async typeText(text: string, delayMs: number = 0): Promise<void> {
    const escaped = text.replace(/\\/g, '\\\\').replace(/\`/g, '\`');
    const script = `
import sys, time
sys.path.append(r'${process.cwd().replace(/\\\\/g, '\\\\')}')
from desktop_agent.native_input import create_keyboard_input, send_input, KEYEVENTF_KEYDOWN, KEYEVENTF_KEYUP

for ch in "${escaped}":
    vk = ord(ch)
    inp_down = create_keyboard_input(vk, 0, KEYEVENTF_KEYDOWN)
    inp_up = create_keyboard_input(vk, 0, KEYEVENTF_KEYUP)
    send_input([inp_down, inp_up])
    ${delayMs > 0 ? `time.sleep(${delayMs / 1000})` : ''}
`;
    await this.runPython(script);
  }

  /** Press a single key (no repeat) */
  static async pressKey(vkCode: number): Promise<void> {
    const script = `
import sys
sys.path.append(r'${process.cwd().replace(/\\\\/g, '\\\\')}')
from desktop_agent.native_input import create_keyboard_input, send_input, KEYEVENTF_KEYDOWN, KEYEVENTF_KEYUP
inp_down = create_keyboard_input(${vkCode}, 0, KEYEVENTF_KEYDOWN)
inp_up = create_keyboard_input(${vkCode}, 0, KEYEVENTF_KEYUP)
send_input([inp_down, inp_up])
`;
    await this.runPython(script);
  }

  /** Send a hotkey combination (e.g., ctrl+shift+esc) */
  static async hotkey(...vkCodes: number[]): Promise<void> {
    const down = vkCodes.map(c => `create_keyboard_input(${c}, 0, KEYEVENTF_KEYDOWN)`).join(', ');
    const up = vkCodes.map(c => `create_keyboard_input(${c}, 0, KEYEVENTF_KEYUP)`).join(', ');
    const script = `
import sys
sys.path.append(r'${process.cwd().replace(/\\\\/g, '\\\\')}')
from desktop_agent.native_input import create_keyboard_input, send_input, KEYEVENTF_KEYDOWN, KEYEVENTF_KEYUP
inputs_down = [${down}]
inputs_up = [${up}]
send_input(inputs_down + inputs_up)
`;
    await this.runPython(script);
  }
}
