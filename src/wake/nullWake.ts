import { WakeListener, WakeCallback, WakeOptions } from './wakeInterface';

export class NullWake implements WakeListener {
  private running = false;
  constructor(private cb?: WakeCallback, private opts?: WakeOptions) {}
  async start(): Promise<void> { this.running = true; }
  async stop(): Promise<void> { this.running = false; }
  isRunning(): boolean { return this.running; }
}

export default NullWake;
