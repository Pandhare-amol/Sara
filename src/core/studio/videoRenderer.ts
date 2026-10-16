import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ArtifactStore } from "./artifactStore";

export interface VideoAssembly { imageIds: string[]; narrationId?: string; secondsPerImage: number }
function encoderPath(value: string | undefined): string | null {
  if (!value || !path.isAbsolute(value)) return null;
  try {
    if (!fs.statSync(value).isFile()) return null;
    fs.accessSync(value, fs.constants.X_OK);
    return fs.realpathSync(value);
  } catch { return null; }
}

/** Local slides-and-optional-narration workflow; no text-to-video provider or upload. */
export class VideoRenderer {
  constructor(private readonly artifacts: ArtifactStore, private readonly env: NodeJS.ProcessEnv = process.env) {}
  status() { return { configured: !!encoderPath(this.env.SARA_FFMPEG_PATH),
    note: "Requires an owner-reviewed local FFmpeg executable. Builds a cut-only 720p MP4 from previously saved images and optional narration; not generative video." }; }
  async render(request: VideoAssembly, signal?: AbortSignal): Promise<Buffer> {
    const executable = encoderPath(this.env.SARA_FFMPEG_PATH);
    if (!executable) throw new Error("A reviewed local FFmpeg executable is not configured.");
    if (!request || !Array.isArray(request.imageIds) || request.imageIds.length < 1 || request.imageIds.length > 5 ||
        request.imageIds.some((id) => typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) ||
        new Set(request.imageIds).size !== request.imageIds.length ||
        !Number.isInteger(request.secondsPerImage) || request.secondsPerImage < 1 || request.secondsPerImage > 6 ||
        request.imageIds.length * request.secondsPerImage > 30 ||
        request.narrationId !== undefined && (typeof request.narrationId !== "string" || !/^[0-9a-f-]{36}$/.test(request.narrationId))) {
      throw new Error("Choose 1–5 distinct private PNG images, optional WAV and 1–6 seconds per frame (maximum 30 seconds).");
    }
    if (signal?.aborted) throw new Error("Video assembly cancelled.");
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "sara-video-"));
    try {
      const list: string[] = ["ffconcat version 1.0"];
      for (let index = 0; index < request.imageIds.length; index++) {
        const file = this.artifacts.read(request.imageIds[index]);
        if (!file || file.item.kind !== "image" || file.item.format !== "png") throw new Error("A referenced image is missing or failed its hash check.");
        const name = `slide-${index}.png`;
        fs.writeFileSync(path.join(folder, name), file.bytes, { flag: "wx", mode: 0o600 });
        list.push(`file ${name}`, `duration ${request.secondsPerImage}`);
      }
      list.push(`file slide-${request.imageIds.length - 1}.png`);
      fs.writeFileSync(path.join(folder, "scenes.ffconcat"), list.join("\n") + "\n", { flag: "wx", mode: 0o600 });
      const sound = request.narrationId ? this.artifacts.read(request.narrationId) : undefined;
      if (request.narrationId && (!sound || !["narration", "tone"].includes(sound.item.kind) || sound.item.format !== "wav")) {
        throw new Error("A referenced audio file is missing or failed its hash check.");
      }
      if (sound) fs.writeFileSync(path.join(folder, "narration.wav"), sound.bytes, { flag: "wx", mode: 0o600 });
      const length = request.imageIds.length * request.secondsPerImage;
      const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-safe", "1", "-f", "concat",
        "-i", "scenes.ffconcat", ...(sound ? ["-i", "narration.wav"] : []),
        "-vf", "fps=24,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30", "-r", "24",
        ...(sound ? ["-c:a", "aac", "-b:a", "96k", "-af", `apad,atrim=0:${length}`] : ["-an"]),
        "-t", String(length), "-movflags", "+faststart", "finished.mp4"];
      await new Promise<void>((resolve, reject) => {
        let stopped = false, timedOut = false;
        const child = spawn(executable, args, { cwd: folder, windowsHide: true,
          env: { PATH: process.env.PATH || "", HOME: folder, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
          stdio: ["ignore", "ignore", "pipe"] });
        const timeout = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 30_000);
        const onAbort = () => { stopped = true; child.kill("SIGKILL"); };
        signal?.addEventListener("abort", onAbort, { once: true });
        child.stderr?.on("data", () => { /* Untrusted diagnostics can contain private paths; never return them. */ });
        child.once("error", () => { clearTimeout(timeout); signal?.removeEventListener("abort", onAbort); reject(new Error("FFmpeg could not start.")); });
        child.once("close", (code) => { clearTimeout(timeout); signal?.removeEventListener("abort", onAbort);
          if (stopped || signal?.aborted) reject(new Error("Video assembly cancelled; inspect the encoder process if it did not stop."));
          else if (timedOut) reject(new Error("Video assembly exceeded the 30-second encoder time limit."));
          else if (code !== 0) reject(new Error("FFmpeg did not create a decodable MP4; check the local encoder configuration."));
          else resolve();
        });
        if (signal?.aborted) onAbort();
      });
      if (signal?.aborted) throw new Error("Video assembly cancelled.");
      const output = path.join(folder, "finished.mp4");
      if (fs.lstatSync(output).isSymbolicLink()) throw new Error("Encoder output cannot be a symlink.");
      const bytes = fs.readFileSync(output);
      if (!bytes.length || bytes.length > 20_000_000) throw new Error("Encoded video exceeds the output budget.");
      // Independently decode the video stream; mere presence of an MP4 header is insufficient.
      const decode = ["-nostdin", "-hide_banner", "-loglevel", "error", "-i", "finished.mp4", "-map", "0:v:0",
        "-f", "null", "-"];
      await new Promise<void>((resolve, reject) => {
        const child = spawn(executable, decode, { cwd: folder, windowsHide: true,
          env: { PATH: process.env.PATH || "", HOME: folder, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
          stdio: ["ignore", "ignore", "ignore"] });
        const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
        const onAbort = () => child.kill("SIGKILL");
        signal?.addEventListener("abort", onAbort, { once: true });
        child.once("error", () => { clearTimeout(timeout); signal?.removeEventListener("abort", onAbort); reject(new Error("Video decode verification unavailable.")); });
        child.once("close", (code) => { clearTimeout(timeout); signal?.removeEventListener("abort", onAbort);
          if (code !== 0 || signal?.aborted) reject(new Error("Video decoding could not be verified.")); else resolve(); });
        if (signal?.aborted) onAbort();
      });
      return bytes;
    } finally { fs.rmSync(folder, { recursive: true, force: true }); }
  }
}
