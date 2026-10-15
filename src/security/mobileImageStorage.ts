import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type MobileImageMime = "image/jpeg" | "image/png" | "image/webp";

export interface DecodedMobileImage {
  bytes: Buffer;
  mimeType: MobileImageMime;
  extension: "jpg" | "png" | "webp";
}

export interface StoredMobileImage {
  filename: string;
  mimeType: MobileImageMime;
  bytes: number;
}

export const MAX_MOBILE_IMAGE_BYTES = 6 * 1024 * 1024;

const EXTENSIONS: Record<MobileImageMime, DecodedMobileImage["extension"]> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

function normalizeMimeType(value: unknown): MobileImageMime | null {
  const mime = String(value || "").trim().toLowerCase();
  if (mime === "image/jpg") return "image/jpeg";
  return mime === "image/jpeg" || mime === "image/png" || mime === "image/webp" ? mime : null;
}

export function decodeMobileImage(data: unknown, declaredMime: unknown): DecodedMobileImage {
  if (typeof data !== "string" || !data) throw new Error("Image data (base64) is required.");

  let encoded = data;
  let mimeType = normalizeMimeType(declaredMime);
  const dataUrl = /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(data);
  if (data.startsWith("data:")) {
    if (!dataUrl) throw new Error("Image data URL must use JPEG, PNG, or WebP base64 encoding.");
    const dataUrlMime = normalizeMimeType(dataUrl[1]);
    if (!dataUrlMime || (mimeType && mimeType !== dataUrlMime)) {
      throw new Error("Image MIME type does not match its data URL.");
    }
    mimeType = dataUrlMime;
    encoded = dataUrl[2];
  }

  if (!mimeType) throw new Error("A supported image MIME type is required.");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error("Image data is not valid base64.");
  }

  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.length > MAX_MOBILE_IMAGE_BYTES || bytes.toString("base64") !== encoded) {
    throw new Error(`Image size must be between 1 byte and ${MAX_MOBILE_IMAGE_BYTES} bytes, with canonical base64 encoding.`);
  }

  const isJpeg = mimeType === "image/jpeg" && bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  const isPng = mimeType === "image/png" && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isWebp = mimeType === "image/webp" && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if (!isJpeg && !isPng && !isWebp) throw new Error("Image bytes do not match the declared MIME type.");

  return { bytes, mimeType, extension: EXTENSIONS[mimeType] };
}

export function storeMobileImage(dataDir: string, image: DecodedMobileImage): StoredMobileImage {
  const imageDir = path.join(path.resolve(dataDir), "images");
  fs.mkdirSync(imageDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(imageDir, 0o700); } catch {}

  const filename = `mobile-${Date.now()}-${crypto.randomBytes(12).toString("hex")}.${image.extension}`;
  const outputPath = path.join(imageDir, filename);
  fs.writeFileSync(outputPath, image.bytes, { flag: "wx", mode: 0o600 });
  return { filename, mimeType: image.mimeType, bytes: image.bytes.length };
}
