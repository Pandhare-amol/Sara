import test from "node:test";
import assert from "node:assert/strict";
import { sendEmail } from "./notificationManager";

async function getMailerForMocking(): Promise<{ createTransport: (options: unknown) => unknown }> {
  const module = await import("nodemailer") as any;
  return module.default || module;
}

test("email notifications preserve SMTP URL, keytar-backed auth, and the configured sender", async () => {
  const nodemailer = await getMailerForMocking();
  const originalCreateTransport = nodemailer.createTransport;
  let transportOptions: Record<string, unknown> | null = null;
  let message: Record<string, unknown> | null = null;
  nodemailer.createTransport = ((options: Record<string, unknown>) => {
    transportOptions = options;
    return {
      sendMail: async (value: Record<string, unknown>) => {
        message = value;
        return { messageId: "mock-message", accepted: ["person@example.com"] };
      },
    };
  }) as typeof nodemailer.createTransport;

  try {
    const result = await sendEmail(
      ["person@example.com"],
      "A reviewed subject",
      "The approved body",
      {
        url: "smtps://smtp.example.test:465",
        from: "SARA <sara@example.test>",
        auth: { user: "smtp-user", pass: "test-only-secret" },
        connectionTimeout: 1234,
        socketTimeout: 2345,
      },
    );

    assert.equal(result.ok, true);
    assert.deepEqual(transportOptions, {
      host: "smtp.example.test",
      port: 465,
      secure: true,
      auth: { user: "smtp-user", pass: "test-only-secret" },
      connectionTimeout: 1234,
      socketTimeout: 2345,
    });
    assert.deepEqual(message, {
      from: "SARA <sara@example.test>",
      to: "person@example.com",
      subject: "A reviewed subject",
      text: "The approved body",
    });
  } finally {
    nodemailer.createTransport = originalCreateTransport;
  }
});

test("email notifications reject non-SMTP URL protocols before creating a transport", async () => {
  const nodemailer = await getMailerForMocking();
  const originalCreateTransport = nodemailer.createTransport;
  let called = false;
  nodemailer.createTransport = (() => {
    called = true;
    throw new Error("A transport must not be created for a non-SMTP URL.");
  }) as typeof nodemailer.createTransport;

  try {
    const result = await sendEmail(["person@example.com"], "Subject", "Body", { url: "https://example.test" });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "invalid_smtp_url");
    assert.equal(called, false);
  } finally {
    nodemailer.createTransport = originalCreateTransport;
  }
});
