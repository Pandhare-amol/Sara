import crypto from "node:crypto";

/** A short-lived, process-local browser capability minted ONLY after admin approval.
 * Never persist it, put it in tool arguments, or return it from a status route.
 */
export class VisualSessionGate {
  private tokenHash: Buffer | null = null;
  private grantId: string | null = null;
  private until = 0;

  grant(seconds: number): { token: string; grantId: string; expiresAt: number } {
    if (!Number.isInteger(seconds) || seconds < 10 || seconds > 300) throw new Error("Invalid visual permission lifetime.");
    const token = crypto.randomBytes(32).toString("hex");
    this.tokenHash = crypto.createHash("sha256").update(token).digest();
    this.grantId = crypto.randomBytes(12).toString("hex");
    this.until = Date.now() + seconds * 1000;
    return { token, grantId: this.grantId, expiresAt: this.until };
  }

  revoke(): void {
    this.tokenHash = null;
    this.grantId = null;
    this.until = 0;
  }

  authorize(value: unknown): boolean {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value) || !this.tokenHash || Date.now() >= this.until) return false;
    const candidate = crypto.createHash("sha256").update(value).digest();
    return crypto.timingSafeEqual(this.tokenHash, candidate);
  }

  get generation(): string | null { return Date.now() < this.until ? this.grantId : null; }
  get enabled(): boolean { return this.generation !== null; }
}
