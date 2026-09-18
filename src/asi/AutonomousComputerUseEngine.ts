import { callDesktopAgent, AgentResult } from '../../desktop_agent_bridge';

export type AutonomousStep =
  | { type: 'openApplication'; args: { appPath: string } }
  | { type: 'openWebsite'; args: { url: string } }
  | { type: 'navigate'; args: { url: string } }
  | { type: 'click'; args: { x: number; y: number; button?: 'left' | 'right' } }
  | { type: 'type'; args: { text: string } }
  | { type: 'fillForm'; args: { selector: string; value: string } }
  | { type: 'wait'; args: { ms: number } };

/**
 * High‑level engine that can run a sequence of autonomous computer actions.
 * It uses the existing desktop‑agent bridge (which forwards calls to the Python
 * agent) for low‑level operations such as moving the mouse, clicking, typing,
 * and using the built‑in Playwright browser automation tools.
 */
export class AutonomousComputerUseEngine {
  constructor() {}

  /**
   * Execute an ordered list of steps. Each step is dispatched to the desktop
   * agent via `callDesktopAgent`. The method returns an aggregated result with
   * success status and any error messages.
   */
  async runTask(steps: AutonomousStep[]): Promise<{ ok: boolean; details: any[] }> {
    const results: any[] = [];
    for (const step of steps) {
      try {
        let toolName: string;
        let args: Record<string, any> = {};
        switch (step.type) {
          case 'openApplication':
            toolName = 'openApplication';
            args = step.args;
            break;
          case 'openWebsite':
            toolName = 'openWebsite';
            args = step.args;
            break;
          case 'navigate':
            toolName = 'desktopBrowserNavigate';
            args = step.args;
            break;
          case 'click':
            toolName = 'hardwareMouseClick';
            args = { x: step.args.x, y: step.args.y, button: step.args.button ?? 'left' };
            break;
          case 'type':
            toolName = 'hardwareKeyboardType';
            args = { text: step.args.text };
            break;
          case 'fillForm':
            // Use Playwright's fill form tool
            toolName = 'desktopBrowserFillForm';
            args = { selector: step.args.selector, value: step.args.value };
            break;
          case 'wait':
            await new Promise((res) => setTimeout(res, step.args.ms));
            results.push({ type: 'wait', status: 'done' });
            continue;
          default:
            throw new Error(`Unsupported step type: ${JSON.stringify(step)}`);
        }
        const response: AgentResult = await callDesktopAgent(toolName, args);
        if (!response.ok) {
          throw new Error(response.error || 'unknown error');
        }
        results.push({ type: step.type, status: 'ok', result: response.result });
      } catch (e: any) {
        // Stop execution on first failure and return details
        results.push({ type: step.type, status: 'error', error: e.message });
        return { ok: false, details: results };
      }
    }
    return { ok: true, details: results };
  }
}
