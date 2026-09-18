import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * CoordinateMapper provides conversion utilities between different coordinate spaces:
 *   - screen (virtual screen) coordinates
 *   - native (absolute) coordinates used by SendInput
 *   - window/client coordinates
 * It queries DPI and virtual screen bounds from the native Python layer.
 */
export class CoordinateMapper {
  private static pythonPath = process.env.SARA_PYTHON || 'python';
  private static cwd = process.cwd();

  private static async runPython(script: string): Promise<string> {
    const { stdout } = await execFileAsync(this.pythonPath, ['-c', script], {
      timeout: 15000,
      windowsHide: true,
      env: { ...process.env, PYTHONPATH: this.cwd },
    });
    return stdout;
  }

  /** Retrieve virtual screen bounds (x, y, width, height) */
  static async getVirtualScreenBounds(): Promise<{ x: number; y: number; width: number; height: number }> {
    const script = `
import sys
sys.path.append(r'${process.cwd().replace(/\\/g, '\\')}')
from desktop_agent.native_input import get_virtual_screen_bounds
x, y, w, h = get_virtual_screen_bounds()
print(f"{x},{y},{w},{h}")
`;
    const out = await this.runPython(script);
    const [x, y, w, h] = out.trim().split(',').map(Number);
    return { x, y, width: w, height: h };
  }

  /** Retrieve system DPI scaling factor (e.g., 96 for 100%) */
  /** Retrieve system-wide DPI scaling factor (e.g., 96 for 100%) */
  static async getSystemDPI(): Promise<number> {
    const script = `
import sys
sys.path.append(r'${process.cwd().replace(/\\/g, '\\')}')
from desktop_agent.native_input import get_system_dpi
print(get_system_dpi())
`;
    const out = await this.runPython(script);
    return Number(out.trim());
  }

  /** Convert screen (pixel) coordinates to absolute 0-65535 range used by SendInput */
  /** Convert screen (pixel) coordinates to absolute 0-65535 range used by SendInput */
  static async screenToAbsolute(x: number, y: number): Promise<{ absX: number; absY: number }> {
    const bounds = await this.getVirtualScreenBounds();
    const absX = Math.max(0, Math.min(65535, Math.round(((x - bounds.x) * 65536) / bounds.width)));
    const absY = Math.max(0, Math.min(65535, Math.round(((y - bounds.y) * 65536) / bounds.height)));
    return { absX, absY };
  }

  /** Convert absolute (0-65535) coordinates back to screen pixels */
  /** Convert absolute (0-65535) coordinates back to screen pixels */
  static async absoluteToScreen(absX: number, absY: number): Promise<{ x: number; y: number }> {
    const bounds = await this.getVirtualScreenBounds();
    const x = Math.round((absX * bounds.width) / 65536 + bounds.x);
    const y = Math.round((absY * bounds.height) / 65536 + bounds.y);
    return { x, y };
  }
}
