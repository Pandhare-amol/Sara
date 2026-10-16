// Deliberately process-memory only: never use localStorage, URLs, or cookies for
// a visual capability. A reload or sign-out drops browser access immediately.
let visualToken: string | null = null;
export function setVisualToken(token: string | null): void {
  visualToken = typeof token === "string" && /^[a-f0-9]{64}$/.test(token) ? token : null;
}
export function visualHeaders(): Record<string, string> {
  return visualToken ? { "X-SARA-Visual-Session": visualToken } : {};
}
export function hasVisualToken(): boolean { return visualToken !== null; }
