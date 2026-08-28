import type { EmailDeliverabilityPort } from "@th/ports/comms/email-deliverability";
import type { LoggerPort } from "@th/ports/logger";

export type EmailDeliveryVerificationUser = {
  id?: string;
  email?: string | null;
};

export type EmailDeliveryVerificationDeps = {
  deliverability: Pick<EmailDeliverabilityPort, "clearByEmail">;
  logger: LoggerPort;
};

export type EmailDeliveryVerificationResult =
  | { outcome: "cleared"; email: string; matched: boolean }
  | { outcome: "skipped_missing_email" }
  | { outcome: "failed"; email: string; error: unknown };

export async function clearEmailDeliveryStatusAfterVerification(
  deps: EmailDeliveryVerificationDeps,
  user: EmailDeliveryVerificationUser,
): Promise<EmailDeliveryVerificationResult> {
  const email = user.email?.trim().toLowerCase();
  if (!email) {
    deps.logger.warn("auth_email_delivery_clear_skipped", {
      reason: "missing_email",
      authUserId: user.id ?? null,
    });
    return { outcome: "skipped_missing_email" };
  }

  try {
    const matched = await deps.deliverability.clearByEmail(email);
    return { outcome: "cleared", email, matched };
  } catch (error) {
    deps.logger.warn("auth_email_delivery_clear_failed", {
      authUserId: user.id ?? null,
      error,
    });
    return { outcome: "failed", email, error };
  }
}