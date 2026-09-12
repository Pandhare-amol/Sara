import fs from "node:fs/promises";
import path from "node:path";
import type { AudioResult } from "./SingerTypes";
import { SingerProviderError } from "./SingerProviders";

export class AudioMixer {
  async mix(vocals: AudioResult, instrumental: AudioResult, outputDirectory: string): Promise<AudioResult> {
    if (!vocals.verified || !instrumental.verified) throw new SingerProviderError("AUDIO_VERIFICATION_FAILED", "Cannot mix unverified singer artifacts.");
    await Promise.all([this.assertReadable(vocals.audioPath), this.assertReadable(instrumental.audioPath)]);
    if (vocals.mimeType !== "audio/wav" || instrumental.mimeType !== "audio/wav") {
      throw new SingerProviderError("MIX_FORMAT_UNSUPPORTED", "The configured audio mixer currently accepts verified PCM WAV artifacts only.");
    }
    const vocalWav = await this.readWav(vocals.audioPath);
    const musicWav = await this.readWav(instrumental.audioPath);
    if (vocalWav.sampleRate !== musicWav.sampleRate) throw new SingerProviderError("MIX_SAMPLE_RATE_MISMATCH", "Vocal and instrumental sample rates do not match.");
    const sampleCount = Math.max(vocalWav.samples.length, musicWav.samples.length);
    const mixed = Buffer.alloc(sampleCount * 2);
    for (let index = 0; index < sampleCount; index++) {
      const vocal = vocalWav.samples[index] || 0;
      const music = musicWav.samples[index] || 0;
      mixed.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(vocal * 0.86 + music * 0.24))), index * 2);
    }
    await fs.mkdir(outputDirectory, { recursive: true });
    const outputPath = path.join(outputDirectory, `sara-song-${Date.now()}.wav`);
    await fs.writeFile(outputPath, this.createWav(mixed, vocalWav.sampleRate));
    return { audioPath: outputPath, mimeType: "audio/wav", durationSeconds: sampleCount / vocalWav.sampleRate, provider: `${vocals.provider}+${instrumental.provider}`, verified: true };
  }

  private async assertReadable(filePath: string): Promise<void> {
    try { await fs.access(filePath); } catch { throw new SingerProviderError("AUDIO_ARTIFACT_MISSING", "The singing provider returned an audio path that cannot be read."); }
  }
  private async readWav(filePath: string): Promise<{ sampleRate: number; samples: Int16Array }> {
    const data = await fs.readFile(filePath);
    if (data.toString("ascii", 0, 4) !== "RIFF" || data.toString("ascii", 8, 12) !== "WAVE") throw new SingerProviderError("MIX_INVALID_WAV", "Audio artifact is not a RIFF/WAVE file.");
    const format = data.readUInt16LE(20);
    const channels = data.readUInt16LE(22);
    const sampleRate = data.readUInt32LE(24);
    const bits = data.readUInt16LE(34);
    const dataOffset = data.indexOf("data", 36, "ascii");
    if (format !== 1 || channels !== 1 || bits !== 16 || dataOffset < 0) throw new SingerProviderError("MIX_WAV_UNSUPPORTED", "Only mono PCM16 WAV artifacts are supported by the built-in mixer.");
    const size = data.readUInt32LE(dataOffset + 4);
    return { sampleRate, samples: new Int16Array(data.subarray(dataOffset + 8, dataOffset + 8 + size).buffer.slice(data.subarray(dataOffset + 8, dataOffset + 8 + size).byteOffset, data.subarray(dataOffset + 8, dataOffset + 8 + size).byteOffset + size)) };
  }
  private createWav(samples: Buffer, sampleRate: number): Buffer {
    const header = Buffer.alloc(44); header.write("RIFF", 0); header.writeUInt32LE(36 + samples.length, 4); header.write("WAVE", 8); header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(samples.length, 40); return Buffer.concat([header, samples]);
  }
}