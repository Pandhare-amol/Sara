import { timingSafeEqual } from "node:crypto";

export function normalizeHostName(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

export function hostFromHeader(hostHeader: string): string | null {
  try {
    const parsed = new URL(`http://${hostHeader}`);
    if (!parsed.hostname || parsed.username || parsed.password) return null;
    return normalizeHostName(parsed.hostname);
  } catch {
    return null;
  }
}

export function isLoopbackAddress(address?: string | null): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase().replace(/^::ffff:/, "");
  return normalized === "127.0.0.1" || normalized.startsWith("127.") || normalized === "::1";
}

export function isLoopbackHost(hostname: string): boolean {
  const normalized = normalizeHostName(hostname);
  return normalized === "localhost" || normalized === "::1" || normalized === "127.0.0.1" || normalized.startsWith("127.");
}

export function isHostAllowed(hostHeader: string, allowedHosts: ReadonlySet<string>): boolean {
  const host = hostFromHeader(hostHeader);
  return host !== null && allowedHosts.has(host);
}

export function isOriginAllowed(
  origin: string,
  hostHeader: string,
  allowedOrigins: ReadonlySet<string>,
  defaultPort = "3000",
): boolean {
  const normalizedOrigin = origin.trim().toLowerCase().replace(/\/$/, "");
  if (!normalizedOrigin || normalizedOrigin === "null") return false;
  if (allowedOrigins.has(normalizedOrigin)) return true;

  try {
    const parsedOrigin = new URL(normalizedOrigin);
    if (parsedOrigin.protocol !== "http:" && parsedOrigin.protocol !== "https:") return false;
    const requestHost = hostFromHeader(hostHeader);
    if (!requestHost) return false;
    const originHost = normalizeHostName(parsedOrigin.hostname);
    if (originHost !== requestHost) return false;

    const requestPort = new URL(`http://${hostHeader}`).port;
    const originPort = parsedOrigin.port || (parsedOrigin.protocol === "https:" ? "443" : "80");
    const effectiveRequestPort = requestPort || defaultPort;
    return originPort === effectiveRequestPort;
  } catch {
    return false;
  }
}

export function constantTimeStringEqual(expected: string, provided: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  if (expectedBuffer.length === 0 || expectedBuffer.length !== providedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, providedBuffer);
}

export function parseCsvSet(value: string | undefined): Set<string> {
  return new Set(
    (value || "")
      .split(",")
      .map((item) => item.trim().toLowerCase().replace(/\/$/, ""))
      .filter(Boolean),
  );
}
