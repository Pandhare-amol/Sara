// src/services/TargetResolver.ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CoordinateMapper } from './CoordinateMapper';
import { DesktopControlConfig } from '../config/desktopControlConfig';

const execFileAsync = promisify(execFile);

type TargetCriteria = {
  title?: string; // UI element title (partial)
  controlType?: string; // UIA control type e.g., "Button"
  x?: number; // fallback screen coords
  y?: number;
};

type BoundingBox = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

/**
 * Resolve a UI target either via UI Automation (pywinauto) or by screen coordinates.
 * Returns a bounding box and a confidence score (0‑1).
 */
export class TargetResolver {
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

  static async resolve(criteria: TargetCriteria): Promise<{ box: BoundingBox; confidence: number }> {
    // Try UI Automation first if a title or control type is supplied
    if (criteria.title || criteria.controlType) {
      const script = `
import sys, json
sys.path.append(r'${process.cwd().replace(/\\\\/g, '\\\\')}')
from desktop_agent.ui_automation import get_element_bounds
try:
    bounds = get_element_bounds(title=${criteria.title ? `'${criteria.title}'` : 'None'}, control_type=${criteria.controlType ? `'${criteria.controlType}'` : 'None'})
    print(json.dumps({"box": bounds, "confidence": 0.95}))
except Exception as e:
    print(json.dumps({"error": str(e)}))
`;
      const out = await this.runPython(script);
      const parsed = JSON.parse(out.trim());
      if (parsed.box) {
        return { box: parsed.box as BoundingBox, confidence: parsed.confidence };
      }
    }
    // Fallback to provided screen coordinates (centered 10x10 box)
    if (criteria.x !== undefined && criteria.y !== undefined) {
      const x = criteria.x;
      const y = criteria.y;
      const box: BoundingBox = { left: x - 5, top: y - 5, right: x + 5, bottom: y + 5, width: 10, height: 10 };
      return { box, confidence: 0.6 };
    }
    throw new Error('Unable to resolve target – insufficient criteria');
  }

  /** Convert a bounding box to a single click point (center) */
  static async boxToPoint(box: BoundingBox): Promise<{ x: number; y: number }> {
    const x = Math.round(box.left + box.width / 2);
    const y = Math.round(box.top + box.height / 2);
    return { x, y };
  }
}
