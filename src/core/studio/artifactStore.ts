import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { PNG } from "pngjs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { inspectPrimitiveObj } from "./primitiveMesh";

export type ArtifactKind = "text" | "image" | "narration" | "tone" | "document" | "presentation" | "spreadsheet" | "code" | "mesh" | "video";
export type ArtifactFormat = "md" | "txt" | "csv" | "png" | "wav" | "pdf" | "py" | "obj" | "mp4" | "docx" | "xlsx" | "pptx";
export interface StudioArtifact {
  id: string; parentId?: string; kind: ArtifactKind; format: ArtifactFormat;
  fileName: string; bytes: number; sha256: string; createdAt: string;
  prompt: string; provider: string; model: string; verification: string[];
  dimensions?: { width: number; height: number }; durationSeconds?: number;
  geometry?: { vertices: number; triangles: number };
  usage?: { inputTokens?: number; outputTokens?: number }; estimatedCostUsd?: number;
}
const SUFFIX: Record<ArtifactFormat, string> = { md: "text/markdown", txt: "text/plain", csv: "text/csv",
  png: "image/png", wav: "audio/wav", pdf: "application/pdf", py: "text/x-python", obj: "text/plain", mp4: "video/mp4",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation" };
function checkPng(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 55 || bytes.length > 8_000_000 || bytes.toString("hex", 0, 8) !== "89504e470d0a1a0a" ||
      bytes.toString("ascii", 12, 16) !== "IHDR" || !bytes.includes(Buffer.from("IEND"))) throw new Error("Image is not a bounded PNG.");
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width > 3072 || height > 3072 || width * height > 5_000_000) throw new Error("Image dimensions exceed the approved budget.");
  try { const png = PNG.sync.read(bytes, { checkCRC: true });
    if (png.width !== width || png.height !== height || png.data.length !== width * height * 4) throw new Error("Corrupt PNG pixels.");
  } catch { throw new Error("PNG image cannot be decoded or failed integrity checks."); }
  return { width, height };
}
function checkWav(bytes: Buffer): number {
  if (bytes.length < 48 || bytes.length > 15_000_000 || bytes.toString("ascii", 0, 4) !== "RIFF" ||
      bytes.toString("ascii", 8, 12) !== "WAVE" || bytes.readUInt32LE(4) + 8 !== bytes.length) throw new Error("Audio is not a complete bounded WAV file.");
  let offset = 12; let channels = 0, sampleRate = 0, bits = 0, dataBytes = 0, format = 0;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (offset + 8 + size > bytes.length) throw new Error("Corrupt WAV chunk size.");
    if (type === "fmt " && size >= 16) {
      format = bytes.readUInt16LE(offset + 8); channels = bytes.readUInt16LE(offset + 10);
      sampleRate = bytes.readUInt32LE(offset + 12); bits = bytes.readUInt16LE(offset + 22);
    }
    if (type === "data") dataBytes = size;
    offset += 8 + size + size % 2;
  }
  if (format !== 1 || channels < 1 || channels > 2 || sampleRate < 8000 || sampleRate > 48000 ||
      ![16, 24].includes(bits) || !dataBytes) throw new Error("Unsupported or empty PCM WAV audio.");
  const duration = dataBytes / (sampleRate * channels * (bits / 8));
  if (duration < 0.1 || duration > 300) throw new Error("Audio duration is outside the supported range.");
  return duration;
}
function checkText(bytes: Buffer, format: ArtifactFormat) {
  if (!bytes.length || bytes.length > 500_000 || bytes.includes(0) ||
      new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim() === "") throw new Error("Document must be nonempty, bounded UTF-8 text.");
  if (format === "csv") {
    const content = bytes.toString("utf8");
    if (!content.includes(",") || !content.includes("\n")) throw new Error("CSV needs a header and at least one row.");
    if (/(?:^|,|\n)\s*"?[=+@-]/m.test(content)) throw new Error("CSV spreadsheet formula injection is not permitted.");
  }
}
function checkOfficeZip(bytes: Buffer) {
  if (bytes.length < 500 || bytes.length > 5_000_000 || bytes.subarray(0, 4).toString("hex") !== "504b0304" ||
      !bytes.subarray(-90).includes(Buffer.from("PK\x05\x06", "binary"))) throw new Error("Office file is not a complete bounded ZIP package.");
}
function checkPdf(bytes: Buffer) {
  if (bytes.length < 50 || bytes.length > 3_000_000 || !bytes.subarray(0, 8).toString("ascii").startsWith("%PDF-") ||
      !bytes.subarray(-20).toString("ascii").includes("%%EOF")) throw new Error("PDF is not a complete bounded document.");
}
function checkMp4(bytes: Buffer): number {
  if (bytes.length < 1_000 || bytes.length > 20_000_000) throw new Error("MP4 is missing or exceeds the video budget.");
  let offset = 0, media = 0, movie = false, brand = false, duration = 0;
  while (offset + 8 <= bytes.length) {
    let size = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (size === 0) size = bytes.length - offset;
    if (size < 8 || offset + size > bytes.length) throw new Error("MP4 box lengths are corrupt.");
    if (type === "ftyp" && offset === 0) brand = true;
    if (type === "mdat") media += size - 8;
    if (type === "moov") {
      movie = true;
      let child = offset + 8;
      while (child + 8 <= offset + size) {
        const length = bytes.readUInt32BE(child), name = bytes.toString("ascii", child + 4, child + 8);
        if (length < 8 || child + length > offset + size) throw new Error("MP4 movie metadata is corrupt.");
        if (name === "mvhd") {
          const version = bytes[child + 8];
          if (version === 0 && length >= 28) {
            const timescale = bytes.readUInt32BE(child + 20);
            duration = timescale ? bytes.readUInt32BE(child + 24) / timescale : 0;
          } else if (version === 1 && length >= 40) {
            const timescale = bytes.readUInt32BE(child + 28);
            duration = timescale ? Number(bytes.readBigUInt64BE(child + 32)) / timescale : 0;
          }
        }
        child += length;
      }
    }
    offset += size;
  }
  if (offset !== bytes.length || !brand || !movie || media < 300 || !Number.isFinite(duration) || duration < 0.2 || duration > 31) {
    throw new Error("MP4 container, payload or duration failed validation.");
  }
  return duration;
}
export async function createPlainPdf(title: string, body: string): Promise<Buffer> {
  if (title.length > 140 || body.length > 16_000 || !/^[\x09\x0a\x0d\x20-\x7e]*$/.test(title + body)) {
    throw new Error("PDF export currently supports bounded Latin text only; use Markdown for multilingual content.");
  }
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const lines = body.replace(/\t/g, "    ").split(/\r?\n/).flatMap((paragraph) => {
    const words = paragraph.split(" "), output: string[] = []; let line = "";
    for (let word of words) {
      while (word.length > 85) { if (line) { output.push(line); line = ""; }
        output.push(word.slice(0, 85)); word = word.slice(85); }
      if (line && (line + " " + word).length > 85) { output.push(line); line = ""; }
      line = line ? `${line} ${word}` : word;
    }
    return [...output, line];
  });
  let page = pdf.addPage([612, 792]); let y = 750;
  page.drawText(title.slice(0, 100), { x: 45, y, size: 18, font }); y -= 35;
  for (const line of lines) {
    if (y < 50) { page = pdf.addPage([612, 792]); y = 745; }
    page.drawText(line, { x: 45, y, size: 10, font }); y -= 15;
    if (pdf.getPageCount() > 20) throw new Error("PDF exceeds the 20-page export budget.");
  }
  const bytes = Buffer.from(await pdf.save()); checkPdf(bytes);
  if ((await PDFDocument.load(bytes)).getPageCount() !== pdf.getPageCount()) throw new Error("PDF reopening failed.");
  return bytes;
}

/** All artifacts are new, private, individually validated files; never overwrite source material. */
export class ArtifactStore {
  private history: StudioArtifact[] = [];
  private readonly historyPath: string;
  private readonly outputDir: string;
  constructor(private readonly root: string) {
    this.outputDir = path.join(root, "artifacts"); this.historyPath = path.join(root, "history.json");
    if (fs.existsSync(this.historyPath)) {
      if (fs.lstatSync(this.historyPath).isSymbolicLink()) throw new Error("Artifact history cannot be a symlink.");
      const saved = JSON.parse(fs.readFileSync(this.historyPath, "utf8")) as { schema: 1; items: StudioArtifact[] };
      if (saved.schema !== 1 || !Array.isArray(saved.items) || saved.items.length > 300) throw new Error("Artifact history requires manual review.");
      this.history = saved.items;
    }
  }
  list(): StudioArtifact[] { return JSON.parse(JSON.stringify(this.history)).reverse(); }
  get(id: string): StudioArtifact | undefined { return this.history.find((item) => item.id === id); }
  /** Recheck disk integrity with bounded memory for project manifests. It does
   * not re-parse media semantics; the bytes were format-checked at save time. */
  verify(id: string): StudioArtifact | undefined {
    const item = this.get(id);
    if (!item || !/^[0-9a-f-]{36}$/.test(item.id) || item.fileName !== `${item.id}.${item.format}`) return undefined;
    const file = path.join(this.outputDir, item.fileName);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size !== item.bytes || stat.size > 20_000_000) return undefined;
      const digest = createHash("sha256");
      const chunk = Buffer.allocUnsafe(64 * 1024);
      const handle = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try {
        let offset = 0;
        while (offset < stat.size) {
          const size = fs.readSync(handle, chunk, 0, Math.min(chunk.length, stat.size - offset), offset);
          if (!size) return undefined;
          digest.update(chunk.subarray(0, size)); offset += size;
        }
      } finally { fs.closeSync(handle); }
      const after = fs.lstatSync(file);
      if (!after.isFile() || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs ||
          after.ino !== stat.ino || digest.digest("hex") !== item.sha256) return undefined;
      return JSON.parse(JSON.stringify(item)) as StudioArtifact;
    } catch { return undefined; } // File removed, replaced or unreadable during verification: fail closed.
  }
  read(id: string): { item: StudioArtifact; bytes: Buffer; mime: string } | undefined {
    const item = this.get(id);
    if (!item || !/^[0-9a-f-]{36}$/.test(item.id) || item.fileName !== `${item.id}.${item.format}`) return undefined;
    const file = path.join(this.outputDir, item.fileName);
    if (!fs.existsSync(file)) return undefined;
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size !== item.bytes || stat.size > 20_000_000) return undefined;
    const bytes = fs.readFileSync(file);
    if (bytes.length !== item.bytes || createHash("sha256").update(bytes).digest("hex") !== item.sha256) return undefined;
    return { item: JSON.parse(JSON.stringify(item)), bytes, mime: SUFFIX[item.format] };
  }
  save(input: { kind: ArtifactKind; format: ArtifactFormat; bytes: Buffer; prompt: string;
    provider: string; model: string; parentId?: string; usage?: StudioArtifact["usage"];
    estimatedCostUsd?: number }): StudioArtifact {
    if (!Buffer.isBuffer(input.bytes) || !SUFFIX[input.format] ||
        !input.prompt.trim() || input.prompt.length > 4000 || input.provider.length > 80 || input.model.length > 120 ||
        this.history.length >= 300 || input.parentId && !this.get(input.parentId)) throw new Error("Invalid or full artifact workspace.");
    let dimensions: StudioArtifact["dimensions"], durationSeconds: number | undefined;
    let geometry: StudioArtifact["geometry"];
    const checks: string[] = [];
    if (input.format === "png" && input.kind === "image") { dimensions = checkPng(input.bytes); checks.push("decoded_png_crc_and_dimensions"); }
    else if (input.format === "wav" && ["narration", "tone"].includes(input.kind)) { durationSeconds = checkWav(input.bytes); checks.push("parsed_pcm_wav_and_duration"); }
    else if (input.format === "pdf" && input.kind === "document") { checkPdf(input.bytes); checks.push("pdf_signature_eof"); }
    else if (input.format === "obj" && input.kind === "mesh") { geometry = inspectPrimitiveObj(input.bytes); checks.push("closed_outward_triangular_obj"); }
    else if (input.format === "mp4" && input.kind === "video") { durationSeconds = checkMp4(input.bytes); checks.push("mp4_boxes_media_and_duration"); }
    else if (input.format === "docx" && input.kind === "document" || input.format === "xlsx" && input.kind === "spreadsheet" ||
             input.format === "pptx" && input.kind === "presentation") {
      checkOfficeZip(input.bytes); checks.push("ooxml_zip_signature");
    }
    else if (["md", "txt", "csv", "py"].includes(input.format) && ["text", "document", "code"].includes(input.kind)) {
      checkText(input.bytes, input.format); checks.push("nonempty_valid_utf8");
    } else throw new Error("Artifact format and modality do not match.");
    fs.mkdirSync(this.outputDir, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(this.outputDir).isSymbolicLink()) throw new Error("Output directory cannot be a symlink.");
    const id = randomUUID(), fileName = `${id}.${input.format}`, file = path.join(this.outputDir, fileName);
    const digest = createHash("sha256").update(input.bytes).digest("hex");
    const item: StudioArtifact = { id, fileName, kind: input.kind, format: input.format,
      bytes: input.bytes.length, sha256: digest, createdAt: new Date().toISOString(),
      prompt: input.prompt, provider: input.provider, model: input.model, parentId: input.parentId,
      verification: checks, dimensions, durationSeconds, geometry, usage: input.usage, estimatedCostUsd: input.estimatedCostUsd };
    const tempFile = `${file}.tmp`;
    try {
      fs.writeFileSync(tempFile, input.bytes, { flag: "wx", mode: 0o600 });
      fs.renameSync(tempFile, file);
      const stored = fs.readFileSync(file);
      if (stored.length !== input.bytes.length || createHash("sha256").update(stored).digest("hex") !== digest) throw new Error("Artifact write could not be verified.");
      const next = [...this.history, item];
      const historyTemp = `${this.historyPath}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(historyTemp, JSON.stringify({ schema: 1, items: next }), { flag: "wx", mode: 0o600 });
        fs.renameSync(historyTemp, this.historyPath);
        this.history = next;
      } finally { if (fs.existsSync(historyTemp)) fs.unlinkSync(historyTemp); }
      return JSON.parse(JSON.stringify(item));
    } catch (error) { if (fs.existsSync(file)) fs.unlinkSync(file); throw error; }
    finally { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); }
  }
  delete(id: string): boolean {
    const item = this.get(id);
    if (!item) return false;
    if (!/^[0-9a-f-]{36}$/.test(item.id) || item.fileName !== `${item.id}.${item.format}`) throw new Error("Artifact record requires manual recovery.");
    const file = path.join(this.outputDir, item.fileName);
    try { fs.unlinkSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    this.history = this.history.filter((entry) => entry.id !== id);
    const tmp = `${this.historyPath}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(tmp, JSON.stringify({ schema: 1, items: this.history }), { flag: "wx", mode: 0o600 });
      fs.renameSync(tmp, this.historyPath); } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
    return true;
  }
}
