import path from "node:path";

/** Vite dev, preview and the embedded Express server must never serve private
 * runtime files. URL decoding/normalization happens here, before Vite rewrites
 * routes or hands a request to its source-file server.
 */
export function isPrivateStaticPath(rawUrl: string): boolean {
  try {
    let pathname = new URL(rawUrl, "http://localhost").pathname;
    for (let i = 0; i < 2; i++) pathname = decodeURIComponent(pathname);
    pathname = path.posix.normalize(pathname.replace(/\\/g, "/"));
    return /^\/(?:data|logs|users|@fs)(?:\/|$)/i.test(pathname) ||
      /(?:^|\/)\.(?:env(?:\.|$)|git(?:\/|$)|netrc(?:$|\/))/i.test(pathname);
  } catch { return true; }
}
