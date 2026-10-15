import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeWhatsAppRecipient,
  validateWhatsAppText,
  WhatsAppSendError,
} from "../../src/whatsapp_client";

test("WhatsApp recipient normalization preserves the country code and strips formatting", () => {
  assert.equal(normalizeWhatsAppRecipient("+91 (98765) 43210"), "919876543210");
  assert.equal(normalizeWhatsAppRecipient("12025550123"), "12025550123");
});

test("WhatsApp messages are validated before any provider request", () => {
  assert.equal(validateWhatsAppText("  exact text  "), "exact text");
  assert.throws(() => normalizeWhatsAppRecipient("not a phone"), (error: unknown) => {
    assert.ok(error instanceof WhatsAppSendError);
    assert.equal(error.code, "INVALID_RECIPIENT");
    return true;
  });
  assert.throws(() => validateWhatsAppText("   "), /cannot be empty/i);
  assert.throws(() => validateWhatsAppText("x".repeat(4097)), /4096-character limit/i);
});
