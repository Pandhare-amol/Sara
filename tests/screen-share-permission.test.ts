import test from "node:test";
import assert from "node:assert/strict";
import { isScreenCaptureUnsupported } from "../src/lib/screenSharePermissions";

test("fallback is only for missing/unsupported capture APIs, never permission refusal", () => {
  assert.equal(isScreenCaptureUnsupported({ name: "NotSupportedError" }, true), true);
  assert.equal(isScreenCaptureUnsupported(new TypeError("getDisplayMedia is not a function"), false), true);
  for (const name of ["NotAllowedError", "SecurityError", "AbortError", "PermissionDeniedError", "NotFoundError", "NotReadableError", "TypeError"]) {
    assert.equal(isScreenCaptureUnsupported({ name }, true), false, `${name} must not fall back to another capture backend`);
  }
});
