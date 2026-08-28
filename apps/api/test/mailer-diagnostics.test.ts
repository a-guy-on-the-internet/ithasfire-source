import { describe, expect, it } from "vitest";

import { summarizeAuthMailerDiagnostics } from "../src/auth/mailer-diagnostics";

describe("summarizeAuthMailerDiagnostics", () => {
  it("prefers plain SMTP when the override is requested and SMTP is ready", () => {
    const result = summarizeAuthMailerDiagnostics({
      resendApiKey: "re_test_123",
      defaultFromEmail: "sender@example.com",
      smtpHost: "127.0.0.1",
      smtpPort: 1025,
      plainSmtp: true,
    });

    expect(result.providerPath).toBe("plain_smtp");
    expect(result.mailerConfigured).toBe(true);
    expect(result.pathReadiness).toEqual({
      plainSmtp: true,
      resend: true,
      smtp: true,
    });
  });

  it("falls back to resend when plain SMTP is requested but incomplete", () => {
    const result = summarizeAuthMailerDiagnostics({
      resendApiKey: "re_test_123",
      defaultFromEmail: "sender@example.com",
      plainSmtp: true,
    });

    expect(result.providerPath).toBe("resend");
    expect(result.mailerConfigured).toBe(true);
    expect(result.pathReadiness).toEqual({
      plainSmtp: false,
      resend: true,
      smtp: false,
    });
  });

  it("selects SMTP when resend is absent and shared SMTP requirements are present", () => {
    const result = summarizeAuthMailerDiagnostics({
      defaultFromEmail: "sender@example.com",
      smtpHost: "smtp.example.com",
      smtpPort: 587,
      smtpSecure: true,
      smtpUsername: "mailer-user",
      smtpPassword: "mailer-pass",
      appHeaderValue: "Ithas Fire",
    });

    expect(result.providerPath).toBe("smtp");
    expect(result.mailerConfigured).toBe(true);
    expect(result.configPresence).toEqual({
      hasResendApiKey: false,
      hasDefaultFromEmail: true,
      hasSmtpHost: true,
      hasSmtpPort: true,
      hasSmtpSecureFlag: true,
      hasSmtpUsername: true,
      hasSmtpPassword: true,
      hasAppHeaderValue: true,
      plainSmtpRequested: false,
    });
  });

  it("reports unconfigured when required pieces are missing", () => {
    const result = summarizeAuthMailerDiagnostics({
      smtpHost: "smtp.example.com",
      smtpSecure: false,
    });

    expect(result.providerPath).toBe("unconfigured");
    expect(result.mailerConfigured).toBe(false);
    expect(result.configPresence).toEqual({
      hasResendApiKey: false,
      hasDefaultFromEmail: false,
      hasSmtpHost: true,
      hasSmtpPort: false,
      hasSmtpSecureFlag: true,
      hasSmtpUsername: false,
      hasSmtpPassword: false,
      hasAppHeaderValue: false,
      plainSmtpRequested: false,
    });
    expect(result.pathReadiness).toEqual({
      plainSmtp: false,
      resend: false,
      smtp: false,
    });
  });
});
