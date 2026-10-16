import type { MemoryCategory } from "../lib/memoryTypes";

export const MEMORY_CATEGORIES: readonly MemoryCategory[] = [
  "identity",
  "preference",
  "goal",
  "project",
  "relationship",
  "emotional",
  "behavior",
  "decision",
  "question",
];

const CREDENTIAL_ASSIGNMENT = /\b(?:password|passwd|passphrase|api[\s_-]?key|secret|access[\s_-]?token|refresh[\s_-]?token|auth(?:entication)?[\s_-]?token|client[\s_-]?secret|private[\s_-]?key)\b\s*[:=]\s*(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s,;]+)/i;
const PRIVATE_KEY_BLOCK = /-----BEGIN (?:[A-Z0-9 ]* )?PRIVATE KEY-----/i;
const TOKEN_PATTERNS = [
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{20,}/i,
];

export type MemoryTextValidation =
  | { ok: true; text: string }
  | { ok: false; error: string };

export function isMemoryCategory(value: unknown): value is MemoryCategory {
  return typeof value === "string" && MEMORY_CATEGORIES.includes(value as MemoryCategory);
}

/**
 * Reject obvious credential material before it enters durable personal memory.
 * This is a conservative detector, not a complete PII classifier or secret scanner.
 */
export function validateMemoryText(value: unknown, maxLength = 2000): MemoryTextValidation {
  if (typeof value !== "string") {
    return { ok: false, error: "Memory text must be a string." };
  }

  const text = value.trim();
  if (!text) return { ok: false, error: "Memory text cannot be empty." };
  if (text.length > maxLength) {
    return { ok: false, error: `Memory text must be at most ${maxLength} characters.` };
  }
  if (text.includes("\0")) {
    return { ok: false, error: "Memory text contains an unsupported control character." };
  }
  if (CREDENTIAL_ASSIGNMENT.test(text) || PRIVATE_KEY_BLOCK.test(text) || TOKEN_PATTERNS.some((pattern) => pattern.test(text))) {
    return {
      ok: false,
      error: "This memory appears to contain a password, API key, token, or private key. Remove the credential before saving.",
    };
  }

  return { ok: true, text };
}
