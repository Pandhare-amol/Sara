export interface VoiceActivityGateOptions {
  /** 0 is strictest, 100 is most sensitive. */
  sensitivity?: number;
  /** Number of adjacent frames needed before opening the gate. */
  attackFrames?: number;
  /** Briefly keep the gate open after speech energy drops. */
  hangoverFrames?: number;
}

export interface VoiceActivityFrame {
  /** PCM frames to send in order. A detected onset includes one pre-roll frame. */
  frames: Float32Array[];
  speechActive: boolean;
  started: boolean;
  ended: boolean;
  rms: number;
  threshold: number;
}

/**
 * A small, conservative local voice activity gate for microphone PCM.
 * It suppresses low-level ambient sound before it reaches the live model, but
 * continues sending zero-valued PCM during silence so server-side turn
 * detection can still see the end of an utterance. This is not speech
 * recognition and cannot reliably separate speech from loud TV/music.
 */
export class VoiceActivityGate {
  private readonly sensitivity: number;
  private readonly attackFrames: number;
  private readonly hangoverFrames: number;
  private noiseFloor = 0.0025;
  private candidates = 0;
  private hangover = 0;
  private active = false;
  private previousCandidate: Float32Array | null = null;

  constructor(options: VoiceActivityGateOptions = {}) {
    this.sensitivity = Math.max(0, Math.min(100, Number(options.sensitivity ?? 55)));
    this.attackFrames = Math.max(1, Math.min(5, Math.floor(options.attackFrames ?? 2)));
    this.hangoverFrames = Math.max(1, Math.min(100, Math.floor(options.hangoverFrames ?? 18)));
  }

  reset(): void {
    this.noiseFloor = 0.0025;
    this.candidates = 0;
    this.hangover = 0;
    this.active = false;
    this.previousCandidate = null;
  }

  process(input: Float32Array): VoiceActivityFrame {
    const rms = computeRms(input);
    const zeroCrossingRate = computeZeroCrossingRate(input);
    const threshold = this.getThreshold();
    const plausibleSpeech = rms >= threshold
      && zeroCrossingRate >= 0.004
      && zeroCrossingRate <= 0.48;

    if (!this.active) {
      if (plausibleSpeech) {
        if (this.candidates === 0) this.previousCandidate = new Float32Array(input);
        this.candidates += 1;
        if (this.candidates >= this.attackFrames) {
          this.active = true;
          this.candidates = 0;
          this.hangover = this.hangoverFrames;
          const onsetFrame = this.previousCandidate;
          this.previousCandidate = null;
          const frames = this.attackFrames > 1 && onsetFrame
            ? [onsetFrame, new Float32Array(input)]
            : [new Float32Array(input)];
          return {
            frames,
            speechActive: true,
            started: true,
            ended: false,
            rms,
            threshold,
          };
        }
        this.updateNoiseFloor(rms);
        return this.silentFrame(input.length, rms, threshold, false, false);
      }

      this.candidates = 0;
      this.previousCandidate = null;
      this.updateNoiseFloor(rms);
      return this.silentFrame(input.length, rms, threshold, false, false);
    }

    if (plausibleSpeech) {
      this.hangover = this.hangoverFrames;
      return { frames: [new Float32Array(input)], speechActive: true, started: false, ended: false, rms, threshold };
    }

    if (this.hangover > 0) {
      this.hangover -= 1;
      return this.silentFrame(input.length, rms, threshold, true, false);
    }

    this.active = false;
    this.candidates = 0;
    this.previousCandidate = null;
    this.updateNoiseFloor(rms);
    return this.silentFrame(input.length, rms, threshold, false, true);
  }

  private getThreshold(): number {
    const sensitivityScale = 2.8 - (this.sensitivity / 100) * 1.1;
    const minimum = 0.008 + (100 - this.sensitivity) * 0.000035;
    return Math.min(0.04, Math.max(minimum, this.noiseFloor * sensitivityScale));
  }

  private updateNoiseFloor(rms: number): void {
    // Adapt only slowly, and never let a transient spike inflate the baseline.
    const bounded = Math.min(Math.max(0, rms), 0.04);
    this.noiseFloor = Math.max(0.0008, Math.min(0.025, this.noiseFloor * 0.96 + bounded * 0.04));
  }

  private silentFrame(length: number, rms: number, threshold: number, speechActive: boolean, ended: boolean): VoiceActivityFrame {
    return {
      frames: [new Float32Array(length)],
      speechActive,
      started: false,
      ended,
      rms,
      threshold,
    };
  }
}

function computeRms(samples: Float32Array): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

function computeZeroCrossingRate(samples: Float32Array): number {
  if (samples.length < 2) return 0;
  let crossings = 0;
  for (let i = 1; i < samples.length; i += 1) {
    if ((samples[i - 1] >= 0) !== (samples[i] >= 0)) crossings += 1;
  }
  return crossings / (samples.length - 1);
}
