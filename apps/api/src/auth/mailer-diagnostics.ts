export type AuthMailerProviderPath =
  | "resend"
  | "smtp"
  | "plain_smtp"
  | "unconfigured";

export type AuthMailerDiagnosticsInput = {
  resendApiKey?: string;
  defaultFromEmail?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUsername?: string;
  smtpPassword?: string;
  appHeaderValue?: string;
  plainSmtp?: boolean;
};

export type AuthMailerDiagnostics = {
  mailerConfigured: boolean;
  providerPath: AuthMailerProviderPath;
  configPresence: {
    hasResendApiKey: boolean;
    hasDefaultFromEmail: boolean;
    hasSmtpHost: boolean;
    hasSmtpPort: boolean;
    hasSmtpSecureFlag: boolean;
    hasSmtpUsername: boolean;
    hasSmtpPassword: boolean;
    hasAppHeaderValue: boolean;
    plainSmtpRequested: boolean;
  };
  pathReadiness: {
    resend: boolean;
    smtp: boolean;
    plainSmtp: boolean;
  };
};

export function summarizeAuthMailerDiagnostics(
  input: AuthMailerDiagnosticsInput,
): AuthMailerDiagnostics {
  const configPresence = {
    hasResendApiKey: Boolean(input.resendApiKey),
    hasDefaultFromEmail: Boolean(input.defaultFromEmail),
    hasSmtpHost: Boolean(input.smtpHost),
    hasSmtpPort: Boolean(input.smtpPort),
    hasSmtpSecureFlag: typeof input.smtpSecure === "boolean",
    hasSmtpUsername: Boolean(input.smtpUsername),
    hasSmtpPassword: Boolean(input.smtpPassword),
    hasAppHeaderValue: Boolean(input.appHeaderValue),
    plainSmtpRequested: input.plainSmtp === true,
  };

  const hasSharedEmailRequirements =
    configPresence.hasDefaultFromEmail &&
    configPresence.hasSmtpHost &&
    configPresence.hasSmtpPort;

  const pathReadiness = {
    plainSmtp: configPresence.plainSmtpRequested && hasSharedEmailRequirements,
    resend:
      configPresence.hasResendApiKey && configPresence.hasDefaultFromEmail,
    smtp: hasSharedEmailRequirements,
  };

  const providerPath: AuthMailerProviderPath = pathReadiness.plainSmtp
    ? "plain_smtp"
    : pathReadiness.resend
      ? "resend"
      : pathReadiness.smtp
        ? "smtp"
        : "unconfigured";

  return {
    mailerConfigured: providerPath !== "unconfigured",
    providerPath,
    configPresence,
    pathReadiness,
  };
}
