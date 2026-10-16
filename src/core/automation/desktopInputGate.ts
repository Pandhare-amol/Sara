export class DesktopInputBusyError extends Error {
  constructor() { super("Desktop input queue is busy; no new desktop action was dispatched."); }
}

export class DesktopInputUncertainError extends Error {
  constructor() { super("Desktop action outcome is uncertain. Stop new GUI input and verify the external state before restarting SARA."); }
}

interface Waiting<T> {
  execute: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Process-local FIFO for foreground input shared by the desktop transport,
 * including direct voice calls, browser workflows and background automation.
 * A timed-out/disconnected POST might still be running in Python: quarantine
 * further input rather than releasing another GUI action into an unknown state.
 */
export class DesktopInputGate {
  private active = false;
  private uncertain = false;
  private readonly waiting: Waiting<unknown>[] = [];

  constructor(private readonly maxWaiting = 16, private readonly waitMs = 18_000) {}

  run<T>(execute: () => Promise<T>): Promise<T> {
    if (this.uncertain) return Promise.reject(new DesktopInputUncertainError());
    if (this.waiting.length >= this.maxWaiting) return Promise.reject(new DesktopInputBusyError());
    return new Promise<T>((resolve, reject) => {
      const work: Waiting<T> = { execute, resolve, reject };
      if (this.active || this.waiting.length) {
        work.timer = setTimeout(() => {
          const index = this.waiting.indexOf(work as Waiting<unknown>);
          if (index < 0) return;
          this.waiting.splice(index, 1);
          reject(new DesktopInputBusyError());
        }, this.waitMs);
        work.timer.unref?.();
      }
      this.waiting.push(work as Waiting<unknown>);
      this.drain();
    });
  }

  /** No automatic reset: a transport timeout is not proof the agent stopped. */
  markUncertain(): void {
    this.uncertain = true;
    for (const work of this.waiting.splice(0)) {
      if (work.timer) clearTimeout(work.timer);
      work.reject(new DesktopInputUncertainError());
    }
  }

  get status() { return { active: this.active, waiting: this.waiting.length, uncertain: this.uncertain }; }

  private drain(): void {
    if (this.active || this.uncertain) return;
    const work = this.waiting.shift();
    if (!work) return;
    if (work.timer) clearTimeout(work.timer);
    this.active = true;
    void Promise.resolve().then(work.execute).then(work.resolve, work.reject).finally(() => {
      this.active = false;
      this.drain();
    });
  }
}

// These tools neither issue desktop GUI input nor inspect a mutable GUI target.
// Everything else, including unknown agent-owned tools, is conservatively gated.
const STATUS_ONLY = new Set([
  "systemInfo", "saraTaskStatus", "saraTaskCancel", "saraAgentEmergencyStop",
  "saraSocialShouldRespond", "saraSocialPlanResponse", "saraSocialRecordInteraction",
  "saraProactiveRecordOutcome", "saraCompanionSuggestNext", "saraEmotionalState",
  "saraVoiceParseCommand", "getVisionState", "saraSocialSettings",
  "saraVisualStatus", "saraVisualDisplays", "saraVisualStop", "saraVisualTaskStatus", "saraVisualTaskCancel",
  "hardwareEmergencyRelease", "emergencyStop",
]);

export function requiresDesktopInput(tool: string): boolean {
  return !STATUS_ONLY.has(tool);
}
