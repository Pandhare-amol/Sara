import crypto from "node:crypto";
import { constantTimeStringEqual } from "./requestGuards";

/** Verify Node/Python companion records without ever treating a display name as identity. */
export function verifyCompanionToken(record: any, token: string): boolean {
  if (!record || record.revoked || typeof token !== "string" || token.length === 0) return false;
  try {
    const storedHash = record.hash ?? record.token_hash;
    const storedSalt = record.salt ?? record.token_salt;
    if (typeof storedHash === "string" && typeof storedSalt === "string") {
      const expected = Buffer.from(storedHash, "hex");
      const actual = crypto.scryptSync(token, storedSalt, 64);
      return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    }
    return typeof record.token === "string" && constantTimeStringEqual(record.token, token);
  } catch {
    return false;
  }
}
