import { WakeListener, WakeCallback, WakeOptions } from './wakeInterface';

// Porcupine-based wake listener (optional dependency)
// This module attempts to dynamically load Porcupine and node-record-lpcm16.
// If the native modules are not installed or keyword files are missing, the
// constructor will throw; server startup should catch and fall back to nullWake.

export class PorcupineWake implements WakeListener {
  private running = false;
  private recorder: any = null;
  private porcupine: any = null;
  private pvInstance: any = null;
  private callback?: WakeCallback;
  private opts: WakeOptions;

  constructor(cb?: WakeCallback, opts?: WakeOptions) {
    this.callback = cb;
    this.opts = opts || {};

    // Attempt to require optional dependencies at runtime
    try {
      // @picovoice/porcupine-node preferred
      /* eslint-disable @typescript-eslint/no-var-requires */
      const Porcupine = require('@picovoice/porcupine-node');
      this.porcupine = Porcupine;
    } catch (e) {
      try {
        // Older package name fallback
        this.porcupine = require('porcupine-node');
      } catch (err) {
        throw new Error('Porcupine module not installed. Install @picovoice/porcupine-node or porcupine-node to use PorcupineWake.');
      }
    }

    try {
      this.recorderModule = require('node-record-lpcm16');
    } catch (e) {
      throw new Error('node-record-lpcm16 not installed. Install it to capture microphone audio.');
    }
  }

  private recorderModule: any;

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const keywordPath = this.opts['keywordPath'] || (process.cwd() + '/data/porcupine/keyword.ppn');
    const modelPath = this.opts['modelPath'] || undefined; // let Porcupine default if not provided
    const sensitivity = typeof this.opts['threshold'] === 'number' ? this.opts['threshold'] : 0.6;

    if (!keywordPath) throw new Error('No keywordPath configured for PorcupineWake');

    // Create porcupine instance
    try {
      this.pvInstance = new this.porcupine.Porcupine([keywordPath], [sensitivity], modelPath ? { modelPath } : undefined);
    } catch (e) {
      this.running = false;
      throw e;
    }

    // Start microphone recording
    const record = this.recorderModule.record({ sampleRateHertz: 16000, threshold: 0, verbose: false, recordProgram: 'sox' });
    const stream = record.stream();

    stream.on('data', (chunk: Buffer) => {
      // Porcupine expects Int16 PCM frames; convert Buffer to Int16Array
      try {
        const pcm = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.length / 2);
        const r = this.pvInstance.process(pcm);
        if (r >= 0) {
          // keyword index detected
          const phrase = this.opts.phrase || 'SARA';
          const confidence = sensitivity; // Porcupine returns index, use sensitivity as proxy
          try { this.callback && this.callback({ phrase, confidence }); } catch (e) {}
        }
      } catch (e) {
        // swallow per-frame errors
      }
    });

    stream.on('error', (e: any) => {
      console.warn('[PorcupineWake] mic stream error', String(e));
    });

    this.recorder = record;
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    try {
      if (this.recorder && this.recorder.stop) this.recorder.stop();
    } catch (e) {}
    try {
      if (this.pvInstance && this.pvInstance.release) this.pvInstance.release();
    } catch (e) {}
  }

  isRunning(): boolean { return this.running; }
}

export default PorcupineWake;
