const NOTE = /^([A-G])([#b]?)([2-6])(?::([1-4]))?$/;
const SEMITONES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** User-specified tones, not AI-composed music, vocals, mixing or mastering. */
export function synthesizeToneSequence(score: string, bpm: number, signal?: AbortSignal): Buffer {
  if (typeof score !== "string" || score.length > 400 || !Number.isInteger(bpm) || bpm < 40 || bpm > 180) {
    throw new Error("Use 1–32 notes and a 40–180 BPM tempo.");
  }
  const tokens = score.trim().split(/\s+/);
  if (!tokens.length || tokens.length > 32) throw new Error("Tone sequence must have 1–32 notes.");
  const events = tokens.map((token) => {
    if (/^R(?::[1-4])?$/.test(token)) return { hz: 0, beats: Number(token.split(":")[1] || 1) };
    const match = token.match(NOTE);
    if (!match) throw new Error("Use notes like C4:1, F#4:2 and R:1 (rests); no executable instructions.");
    const accidental = match[2] === "#" ? 1 : match[2] === "b" ? -1 : 0;
    const midi = (Number(match[3]) + 1) * 12 + SEMITONES[match[1]] + accidental;
    return { hz: 440 * Math.pow(2, (midi - 69) / 12), beats: Number(match[4] || 1) };
  });
  const seconds = events.reduce((sum, event) => sum + event.beats * 60 / bpm, 0);
  if (seconds < 0.1 || seconds > 30) throw new Error("Tone sequence exceeds the 30-second audio budget.");
  const rate = 16000, samples = Math.ceil(rate * seconds), pcm = Buffer.alloc(samples * 2);
  let cursor = 0;
  for (const event of events) {
    const length = Math.min(Math.round(rate * event.beats * 60 / bpm), samples - cursor);
    for (let index = 0; index < length; index++) {
      if (index % 4096 === 0 && signal?.aborted) throw new Error("Tone sequence cancelled.");
      const secondsIntoNote = index / rate;
      const envelope = Math.min(1, secondsIntoNote / 0.015, (length - index) / (rate * 0.04));
      const sample = event.hz ? (Math.sin(2 * Math.PI * event.hz * secondsIntoNote) +
        0.15 * Math.sin(4 * Math.PI * event.hz * secondsIntoNote)) * envelope * 0.22 : 0;
      pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * 32767))), (cursor + index) * 2);
    }
    cursor += length;
  }
  const bytes = Buffer.alloc(44 + pcm.length);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(pcm.length, 40);
  pcm.copy(bytes, 44);
  return bytes;
}
