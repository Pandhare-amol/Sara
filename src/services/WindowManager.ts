// src/services/WindowManager.ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class WindowManager {
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

  /** List windows, optionally including untitled ones */
  static async listWindows(includeUntitled: boolean = false): Promise<any> {
    const script = `
import sys, json
sys.path.append(r'${process.cwd().replace(/\\\\/g, '\\\\')}')
from desktop_agent.tools_windows import list_windows
result = list_windows({"include_untitled": ${includeUntitled}})
print(json.dumps(result))
`;
    const out = await this.runPython(script);
    return JSON.parse(out);
  }

  /** Focus a window by title or application */
  static async focusWindow(query: string): Promise<any> {
    const script = `
import sys, json
sys.path.append(r'${process.cwd().replace(/\\\\/g, '\\\\')}')
from desktop_agent.tools_windows import focus_window
result = focus_window({"title": "${query}"})
print(json.dumps(result))
`;
    const out = await this.runPython(script);
    return JSON.parse(out);
  }

  static async minimizeWindow(query: string): Promise<any> {
    const script = `
import sys, json
sys.path.append(r'${process.cwd().replace(/\\\\/g, '\\\\')}')
from desktop_agent.tools_windows import minimize_window
result = minimize_window({"title": "${query}"})
print(json.dumps(result))
`;
    const out = await this.runPython(script);
    return JSON.parse(out);
  }

  static async maximizeWindow(query: string): Promise<any> {
    const script = `
import sys, json
sys.path.append(r'${process.cwd().replace(/\\\\/g, '\\\\')}')
from desktop_agent.tools_windows import maximize_window
result = maximize_window({"title": "${query}"})
print(json.dumps(result))
`;
    const out = await this.runPython(script);
    return JSON.parse(out);
  }

  static async closeWindow(query: string): Promise<any> {
    const script = `
import sys, json
sys.path.append(r'${process.cwd().replace(/\\\\/g, '\\\\')}')
from desktop_agent.tools_windows import close_window
result = close_window({"title": "${query}"})
print(json.dumps(result))
`;
    const out = await this.runPython(script);
    return JSON.parse(out);
  }

  static async switchApplication(query?: string): Promise<any> {
    const arg = query ? `{"title": "${query}"}` : `{}`;
    const script = `
import sys, json
sys.path.append(r'${process.cwd().replace(/\\\\/g, '\\\\')}')
from desktop_agent.tools_windows import switch_application
result = switch_application(${arg})
print(json.dumps(result))
`;
    const out = await this.runPython(script);
    return JSON.parse(out);
  }
}
