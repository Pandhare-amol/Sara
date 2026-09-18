// src/services/BrowserController.ts
/**
 * Thin wrapper around the Python desktop agent for browser related actions.
 * It re‑uses the unified DesktopAgentResultAdapter for result handling.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class BrowserController {
  private static pythonPath = process.env.SARA_PYTHON || 'python';
  private static cwd = process.cwd();

  /** Run a Python snippet and return the parsed DesktopAgentResult */
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

  /** Open the default system browser with a given URL */
  static async openUrl(url: string): Promise<void> {
    const script = `\
import sys, json, webbrowser\
sys.path.append(r'${process.cwd().replace(/\\\\/g, '\\\\')}')\
webbrowser.open('${url}')\
print(json.dumps({"success": true}))\
`;
    await this.runPython(script);
  }

  /** Focus the browser window (optional, uses window title heuristic) */
  static async focusBrowser(titleContains: string = 'Chrome'): Promise<void> {
    // Re‑use WindowManager to focus by title substring
    const { WindowManager } = await import('./WindowManager');
    await WindowManager.focusWindow(titleContains);
  }
}
