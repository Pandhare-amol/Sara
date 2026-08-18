export interface WakeListener {
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
}

export type WakeCallback = (info: { phrase: string; confidence: number }) => void;

export interface WakeOptions {
  phrase?: string;
  threshold?: number;
}
