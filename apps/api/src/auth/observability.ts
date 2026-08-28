import type { LoggerPort } from "@th/ports/logger";

export function logAuthUserSignedUp({
  logger,
  authUserId,
  maskedEmail,
  hasDisplayName,
}: {
  logger: LoggerPort;
  authUserId: string;
  maskedEmail: string | null;
  hasDisplayName: boolean;
}): void {
  logger.info("auth_user_signed_up", {
    authUserId,
    maskedEmail,
    hasDisplayName,
  });
}

export function logAuthVerificationEmailSent({
  logger,
  authUserId,
  maskedEmail,
}: {
  logger: LoggerPort;
  authUserId: string | null;
  maskedEmail: string | null;
}): void {
  logger.info("auth_email_verification_send_completed", {
    authUserId,
    maskedEmail,
  });
}
