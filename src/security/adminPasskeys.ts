import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
  WebAuthnCredential,
} from "@simplewebauthn/server";

const CEREMONY_TTL_MS = 2 * 60 * 1000;
const ADMIN_SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_CREDENTIALS = 10;
const MAX_PENDING_CEREMONIES = 50;

interface StoredAdminPasskey {
  id: string;
  publicKey: string;
  counter: number;
  transports: string[];
  name: string;
  createdAt: string;
  lastUsedAt?: string;
}

interface PendingCeremony {
  kind: "registration" | "authentication";
  challenge: string;
  rpID: string;
  origin: string;
  expiresAt: number;
}

export interface PasskeyRegistrationResult {
  credentialId: string;
  name: string;
  createdAt: string;
}

export interface AdminPasskeySession {
  token: string;
  expiresAt: number;
}

/**
 * Local SARA admin passkeys. The platform authenticator verifies the user's
 * local biometric/PIN; SARA stores only the public credential key, never a
 * face template, fingerprint, or raw voice sample.
 */
export class AdminPasskeyManager {
  private readonly storePath: string;
  private readonly ceremonies = new Map<string, PendingCeremony>();
  private readonly sessions = new Map<string, number>();

  constructor(storePath: string) {
    this.storePath = path.resolve(storePath);
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true, mode: 0o700 });
    try { fs.chmodSync(path.dirname(this.storePath), 0o700); } catch { /* Windows ACLs are managed by the user profile. */ }
  }

  list(): PasskeyRegistrationResult[] {
    return this.loadCredentials().map(({ id, name, createdAt }) => ({ credentialId: id, name, createdAt }));
  }

  hasCredentials(): boolean {
    return this.loadCredentials().length > 0;
  }

  async beginRegistration(input: { rpID: string; origin: string; userName: string; displayName?: string }) {
    this.purgeExpired();
    const credentials = this.loadCredentials();
    if (credentials.length >= MAX_CREDENTIALS) throw new Error("SARA already has the maximum number of admin passkeys.");
    const options = await generateRegistrationOptions({
      rpName: "SARA Local Admin",
      rpID: input.rpID,
      userName: input.userName.slice(0, 120),
      userDisplayName: (input.displayName || input.userName).slice(0, 120),
      userID: new TextEncoder().encode("sara-local-admin"),
      attestationType: "none",
      timeout: CEREMONY_TTL_MS,
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        residentKey: "preferred",
        userVerification: "required",
      },
      excludeCredentials: credentials.map((credential) => ({ id: credential.id, transports: credential.transports })),
    });
    const ceremonyId = this.createCeremony({
      kind: "registration",
      challenge: options.challenge,
      rpID: input.rpID,
      origin: input.origin,
    });
    return { ceremonyId, options };
  }

  async finishRegistration(input: {
    ceremonyId: string;
    response: RegistrationResponseJSON;
    name?: string;
  }): Promise<PasskeyRegistrationResult> {
    const ceremony = this.consumeCeremony(input.ceremonyId, "registration");
    const verification = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: ceremony.challenge,
      expectedOrigin: ceremony.origin,
      expectedRPID: ceremony.rpID,
      requireUserVerification: true,
    });
    if (!verification.verified || !verification.registrationInfo?.userVerified) {
      throw new Error("Passkey registration did not verify the local user.");
    }

    const credential = verification.registrationInfo.credential;
    const records = this.loadCredentials();
    if (records.some((record) => record.id === credential.id)) throw new Error("This passkey is already registered.");
    const name = sanitizePasskeyName(input.name || "SARA admin device");
    const createdAt = new Date().toISOString();
    records.push({
      id: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString("base64"),
      counter: credential.counter,
      transports: credential.transports || [],
      name,
      createdAt,
    });
    this.saveCredentials(records);
    return { credentialId: credential.id, name, createdAt };
  }

  async beginAuthentication(input: { rpID: string; origin: string }) {
    this.purgeExpired();
    const credentials = this.loadCredentials();
    if (credentials.length === 0) throw new Error("No admin passkey is enrolled. Register one using the existing admin token first.");
    const options = await generateAuthenticationOptions({
      rpID: input.rpID,
      timeout: CEREMONY_TTL_MS,
      userVerification: "required",
      allowCredentials: credentials.map((credential) => ({ id: credential.id, transports: credential.transports })),
    });
    const ceremonyId = this.createCeremony({
      kind: "authentication",
      challenge: options.challenge,
      rpID: input.rpID,
      origin: input.origin,
    });
    return { ceremonyId, options };
  }

  async finishAuthentication(input: {
    ceremonyId: string;
    response: AuthenticationResponseJSON;
  }): Promise<AdminPasskeySession> {
    const ceremony = this.consumeCeremony(input.ceremonyId, "authentication");
    const records = this.loadCredentials();
    const record = records.find((candidate) => candidate.id === input.response.id);
    if (!record) throw new Error("The presented passkey is not enrolled for this SARA installation.");
    const credential: WebAuthnCredential = {
      id: record.id,
      publicKey: new Uint8Array(Buffer.from(record.publicKey, "base64")),
      counter: record.counter,
      transports: record.transports,
    };
    const verification = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: ceremony.challenge,
      expectedOrigin: ceremony.origin,
      expectedRPID: ceremony.rpID,
      credential,
      requireUserVerification: true,
    });
    if (!verification.verified || !verification.authenticationInfo.userVerified) {
      throw new Error("Passkey authentication did not verify the local user.");
    }

    record.counter = verification.authenticationInfo.newCounter;
    record.lastUsedAt = new Date().toISOString();
    this.saveCredentials(records);
    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + ADMIN_SESSION_TTL_MS;
    this.sessions.set(token, expiresAt);
    return { token, expiresAt };
  }

  isValidSession(token: string): boolean {
    if (!token || token.length > 256) return false;
    const expiresAt = this.sessions.get(token);
    if (!expiresAt) return false;
    if (expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  revokeSession(token: string): void {
    this.sessions.delete(token);
  }

  private createCeremony(input: Omit<PendingCeremony, "expiresAt">): string {
    this.purgeExpired();
    if (this.ceremonies.size >= MAX_PENDING_CEREMONIES) {
      const oldest = this.ceremonies.keys().next().value;
      if (oldest) this.ceremonies.delete(oldest);
    }
    const id = crypto.randomBytes(16).toString("hex");
    this.ceremonies.set(id, { ...input, expiresAt: Date.now() + CEREMONY_TTL_MS });
    return id;
  }

  private consumeCeremony(id: string, kind: PendingCeremony["kind"]): PendingCeremony {
    this.purgeExpired();
    const ceremony = this.ceremonies.get(id);
    this.ceremonies.delete(id);
    if (!ceremony || ceremony.kind !== kind || ceremony.expiresAt <= Date.now()) {
      throw new Error("The passkey challenge is invalid, expired, or already used. Start again.");
    }
    return ceremony;
  }

  private purgeExpired(): void {
    const now = Date.now();
    for (const [id, ceremony] of this.ceremonies) {
      if (ceremony.expiresAt <= now) this.ceremonies.delete(id);
    }
    for (const [token, expiry] of this.sessions) {
      if (expiry <= now) this.sessions.delete(token);
    }
  }

  private loadCredentials(): StoredAdminPasskey[] {
    try {
      if (!fs.existsSync(this.storePath)) return [];
      const parsed = JSON.parse(fs.readFileSync(this.storePath, "utf8"));
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((entry): entry is StoredAdminPasskey =>
        !!entry && typeof entry.id === "string" && typeof entry.publicKey === "string"
        && Number.isFinite(Number(entry.counter)) && typeof entry.name === "string",
      ).map((entry) => ({
        id: entry.id,
        publicKey: entry.publicKey,
        counter: Number(entry.counter),
        transports: Array.isArray(entry.transports) ? entry.transports.filter((item: unknown): item is string => typeof item === "string") : [],
        name: entry.name,
        createdAt: typeof entry.createdAt === "string" ? entry.createdAt : new Date(0).toISOString(),
        lastUsedAt: typeof entry.lastUsedAt === "string" ? entry.lastUsedAt : undefined,
      }));
    } catch {
      return [];
    }
  }

  private saveCredentials(credentials: StoredAdminPasskey[]): void {
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.storePath}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(credentials, null, 2), { encoding: "utf8", mode: 0o600 });
      try { fs.chmodSync(temporary, 0o600); } catch { /* best-effort on Windows */ }
      fs.renameSync(temporary, this.storePath);
      try { fs.chmodSync(this.storePath, 0o600); } catch { /* best-effort on Windows */ }
    } finally {
      try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* best-effort cleanup */ }
    }
  }
}

function sanitizePasskeyName(name: string): string {
  const sanitized = String(name || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80);
  return sanitized || "SARA admin device";
}
