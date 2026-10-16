import { createHmac, timingSafeEqual } from "node:crypto";

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
  }
  return "null";
}

/**
 * Bind a pending approval to its exact action and JSON arguments. The caller
 * should keep the HMAC key in memory and discard pending approvals on restart.
 */
export function createApprovalArgumentDigest(
  secret: Uint8Array | string,
  action: string,
  args: Record<string, unknown>,
): string {
  return createHmac("sha256", secret)
    .update(canonicalize({ action, args }), "utf8")
    .digest("hex");
}

export function verifyApprovalArgumentDigest(
  secret: Uint8Array | string,
  action: string,
  args: Record<string, unknown>,
  providedDigest: unknown,
): boolean {
  if (typeof providedDigest !== "string" || !/^[a-f0-9]{64}$/i.test(providedDigest)) return false;
  const expected = Buffer.from(createApprovalArgumentDigest(secret, action, args), "hex");
  const provided = Buffer.from(providedDigest, "hex");
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}
