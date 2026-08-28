import {
  logAndReport,
  type DiscordAlertFn,
  type ReportExceptionFn,
} from "@th/adapters/infra/discord-alerts";
import type { LoggerPort } from "@th/ports/logger";

export type SettlementFailureAlerter = (ctx: {
  orderId: string;
  error: string;
}) => void;

/**
 * Builds the shared "settlement creation failed" alerter used by both the
 * Stripe webhook finalize path and the fully credit-covered checkout path.
 *
 * Both paths mint tickets and write order splits before creating settlements,
 * so a settlement-creation failure must NOT roll those back — the order has
 * already succeeded. Instead the failure has to be loud (Discord alert +
 * Sentry, keyed on `orderId`) so an operator can re-drive it via the
 * `settlements.createFromOrder` mutation.
 *
 * The credit-covered checkout path has no Stripe webhook DLQ / 200-with-retry
 * backstop, so without this alerter a dropped settlement there is completely
 * invisible to operators. Sharing one helper keeps both paths' alerting
 * behaviour identical.
 */
export function buildSettlementFailureAlerter(opts: {
  logger: LoggerPort;
  sendAlert?: DiscordAlertFn | null;
  captureException?: ReportExceptionFn | null;
  message: string;
}): SettlementFailureAlerter {
  const { logger, sendAlert, captureException, message } = opts;
  return ({ orderId, error }) => {
    void logAndReport({
      logger,
      level: "error",
      message,
      extra: { orderId, error },
      report: captureException
        ? {
            captureException,
            error: new Error(error),
            context: { tags: { orderId }, extra: { error } },
          }
        : undefined,
      alert: sendAlert
        ? {
            send: sendAlert,
            payload: {
              title: "Settlement Creation Failed",
              colour: "error",
              description:
                "Order payment succeeded but settlement creation did not complete. Review logs, then retry with settlements.createFromOrder.",
              fields: [{ name: "Order ID", value: orderId, inline: false }],
            },
          }
        : undefined,
    });
  };
}
