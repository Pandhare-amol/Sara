/** Never switch to a capture backend after the user or OS denied sharing. */
export function isScreenCaptureUnsupported(error: unknown, displayMediaExists: boolean): boolean {
  const name = typeof error === "object" && error ? String((error as { name?: string }).name || "") : "";
  return !displayMediaExists || name === "NotSupportedError";
}
