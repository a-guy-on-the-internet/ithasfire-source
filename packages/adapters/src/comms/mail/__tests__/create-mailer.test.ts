import { describe, expect, it } from "vitest";

import { createTestLogger } from "@th/test-utils";

import { createMailerFromConfig } from "../create-mailer";
import { ResendMailAdapter } from "../resend-mailer";
import { SMTPMailAdapter } from "../smtp-mail";

describe("createMailerFromConfig", () => {
  it("prefers Resend when a resend api key and from address are present", () => {
    const mailer = createMailerFromConfig({
      resendApiKey: "re_test_123",
      defaultFromEmail: "sender@example.com",
      smtpHost: "127.0.0.1",
      smtpPort: 1025,
      logger: createTestLogger(),
    });

    expect(mailer).toBeInstanceOf(ResendMailAdapter);
  });

  it("honors plain SMTP override even when Resend is configured", () => {
    const mailer = createMailerFromConfig({
      resendApiKey: "re_test_123",
      defaultFromEmail: "sender@example.com",
      smtpHost: "127.0.0.1",
      smtpPort: 1025,
      plainSmtp: true,
      logger: createTestLogger(),
    });

    expect(mailer).toBeInstanceOf(SMTPMailAdapter);
  });

  it("falls back to SMTP when Resend is absent and SMTP is configured", () => {
    const mailer = createMailerFromConfig({
      defaultFromEmail: "sender@example.com",
      smtpHost: "127.0.0.1",
      smtpPort: 1025,
      logger: createTestLogger(),
    });

    expect(mailer).toBeInstanceOf(SMTPMailAdapter);
  });

  it("returns null when neither provider is fully configured", () => {
    const mailer = createMailerFromConfig({
      defaultFromEmail: "sender@example.com",
      logger: createTestLogger(),
    });

    expect(mailer).toBeNull();
  });
});
