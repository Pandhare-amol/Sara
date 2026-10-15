import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

export interface SafeRemoteResponse {
  statusCode: number;
  statusMessage: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  finalUrl: string;
}

export interface SafeRemoteFetchOptions {
  headers?: Record<string, string>;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
}

function isPublicIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts;

  // Reject private, loopback, link-local, shared, documentation, benchmark,
  // multicast, and reserved address ranges.
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && (c === 0 || c === 113)) return false;
  if (a === 255) return false;
  return true;
}

function isPublicIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0];
  if (!normalized || normalized === "::" || normalized === "::1") return false;

  // Only permit global unicast (2000::/3). This excludes loopback, link-local,
  // unique-local, IPv4-mapped, multicast, and unspecified addresses.
  const firstGroup = normalized.split(":").find(Boolean);
  if (!firstGroup) return false;
  const firstValue = Number.parseInt(firstGroup, 16);
  if (!Number.isFinite(firstValue) || firstValue < 0x2000 || firstValue > 0x3fff) return false;

  // Explicitly reject IPv6 documentation, transition, benchmarking, and
  // special-purpose blocks that are not suitable SSRF destinations.
  const groups = normalized.split(":");
  const secondGroup = Number.parseInt(groups[1] || "0", 16);
  if (firstValue === 0x2001 && (secondGroup <= 0x2 || secondGroup === 0x10 || secondGroup === 0x20 || secondGroup === 0xdb8)) return false;
  if (/^2002:/.test(normalized) || /^3fff:/.test(normalized)) return false;
  return true;
}

export function isPublicIpAddress(address: string): boolean {
  const normalized = address.trim().replace(/^\[|\]$/g, "").split("%")[0];
  const family = isIP(normalized);
  if (family === 4) return isPublicIpv4(normalized);
  if (family === 6) return isPublicIpv6(normalized);
  return false;
}

function bareHostname(hostname: string): string {
  return hostname.trim().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

async function resolvePublicAddress(hostname: string): Promise<{ address: string; family: number }> {
  const host = bareHostname(hostname);
  if (!host || host.toLowerCase() === "localhost") {
    throw new Error("Localhost is not an allowed proxy destination.");
  }

  const family = isIP(host);
  const addresses = family
    ? [{ address: host, family }]
    : await dns.lookup(host, { all: true, verbatim: true });

  if (addresses.length === 0 || addresses.some((candidate) => !isPublicIpAddress(candidate.address))) {
    throw new Error("Proxy destination resolves to a non-public IP address.");
  }
  return addresses[0];
}

function requestOnce(
  url: URL,
  pinnedAddress: { address: string; family: number },
  options: SafeRemoteFetchOptions,
): Promise<{
  statusCode: number;
  statusMessage: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  location?: string;
}> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const hostname = bareHostname(url.hostname);
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const requestOptions: http.RequestOptions = {
      protocol: url.protocol,
      hostname,
      port: url.port ? Number(url.port) : undefined,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: {
        "User-Agent": "SARA-SafeProxy/1.0",
        "Accept-Encoding": "identity",
        ...options.headers,
      },
      agent: false,
      lookup: ((
        _lookupHostname: string,
        lookupOptions: { all?: boolean },
        callback: (...args: any[]) => void,
      ) => {
        if (lookupOptions?.all) {
          callback(null, [pinnedAddress]);
        } else {
          callback(null, pinnedAddress.address, pinnedAddress.family);
        }
      }) as any,
    };

    const req = transport.request(requestOptions, (res) => {
      const statusCode = res.statusCode || 502;
      const location = res.headers.location;
      if ([301, 302, 303, 307, 308].includes(statusCode) && location) {
        res.resume();
        settled = true;
        resolve({
          statusCode,
          statusMessage: res.statusMessage || "Redirect",
          headers: res.headers,
          body: Buffer.alloc(0),
          location,
        });
        return;
      }

      const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
      const chunks: Buffer[] = [];
      let received = 0;
      res.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += buffer.length;
        if (received > maxBytes) {
          req.destroy(new Error(`Remote response exceeded ${maxBytes} bytes.`));
          return;
        }
        chunks.push(buffer);
      });
      res.on("end", () => {
        if (settled) return;
        settled = true;
        resolve({
          statusCode,
          statusMessage: res.statusMessage || "",
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
      res.on("error", fail);
    });

    req.setTimeout(options.timeoutMs ?? 10_000, () => req.destroy(new Error("Remote request timed out.")));
    req.on("error", fail);
    req.end();
  });
}

export async function fetchPublicUrl(
  input: string,
  options: SafeRemoteFetchOptions = {},
): Promise<SafeRemoteResponse> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("A valid absolute URL is required.");
  }

  const maxRedirects = options.maxRedirects ?? 3;
  for (let redirectCount = 0; ; redirectCount += 1) {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Only HTTP and HTTPS proxy destinations are allowed.");
    }
    if (url.username || url.password) throw new Error("URLs with embedded credentials are not allowed.");
    if (url.port && (!/^\d+$/.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65535)) {
      throw new Error("Invalid destination port.");
    }

    const pinnedAddress = await resolvePublicAddress(url.hostname);
    const response = await requestOnce(url, pinnedAddress, options);
    if (response.location) {
      if (redirectCount >= maxRedirects) throw new Error("Too many redirects from proxy destination.");
      url = new URL(response.location, url);
      continue;
    }

    return {
      statusCode: response.statusCode,
      statusMessage: response.statusMessage,
      headers: response.headers,
      body: response.body,
      finalUrl: url.toString(),
    };
  }
}
