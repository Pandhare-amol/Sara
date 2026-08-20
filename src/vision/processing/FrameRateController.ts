export class FrameRateController {
  private lastCaptureAt = 0;

  constructor(private readonly intervalMs = 500) {}

  shouldCapture(now = Date.now()): boolean {
    if (now - this.lastCaptureAt < this.intervalMs) return false;
    this.lastCaptureAt = now;
    return true;
  }
}
