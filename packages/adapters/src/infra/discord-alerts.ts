import type { LogLevel, LoggerPort } from "@th/ports/logger";

export type AlertColour = "info" | "warning" | "error";

const COLOURS: Record<AlertColour, number> = {
  info: 3066993,
  warning: 16776960,
  error: 15158332,
};

export interface DiscordAlertField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordAlertOptions {
  title: string;
  colour?: AlertColour;
  fields?: DiscordAlertField[];
  description?: string;
}

export type DiscordAlertFn = (opts: DiscordAlertOptions) => Promise<void>;

export interface ReportExceptionContext {
  tags?: Record<string, string | undefined>;
  extra?: Record<string, unknown>;
}

/**
 * Reports an exception to the error tracker. Returns the tracker's event id
 * (e.g. Sentry's 32-char hex) when available so callers can deep-link the alert
 * to the corresponding issue. Returning `void`/`undefined` stays valid — the
 * link is best-effort.
 */
export type ReportExceptionFn = (
  error: unknown,
  context?: ReportExceptionContext,
) => string | undefined | void;

export type CreateDiscordWebhookAlertSenderOptions = {
  webhookUrl?: string | null;
  fetch?: typeof fetch;
  logger?: LoggerPort;
  /**
   * Optional short tag prepended to every alert title as `[tag] ...`.
   * Useful for distinguishing env-of-origin (e.g. "dev", "prod", "local")
   * so a staging failure can't be mistaken for prod on fire.
   */
  titlePrefix?: string;
};

/**
 * Reads Cloud Run's `K_SERVICE` and extracts the env slice from service
 * names of the form `hf-<env>-<role>` (e.g. `hf-dev-jobs`, `hf-prod-api`).
 * Returns the env capture (`"dev"`, `"prod"`, ...) or null when not on
 * Cloud Run / name doesn't match.
 */
export function detectCloudRunEnvTag(): string | null {
  const service = process.env.K_SERVICE;
  if (!service) return null;
  const match = service.match(/^hf-([^-]+)-[a-z]+$/);
  return match?.[1] ?? null;
}

export function createDiscordWebhookAlertSender(
  options: CreateDiscordWebhookAlertSenderOptions,
): DiscordAlertFn {
  const titlePrefix = options.titlePrefix?.trim();
  return async (opts) => {
    const webhookUrl = options.webhookUrl?.trim();
    if (!webhookUrl) return;

    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") return;

    const title = titlePrefix ? `[${titlePrefix}] ${opts.title}` : opts.title;

    const body = JSON.stringify({
      // Defense-in-depth: NO alert from ANY caller may ever ping
      // @everyone/@here/roles/users, regardless of what ends up interpolated
      // into a title/description/field value. Discord honours this even if the
      // text contains mention syntax.
      allowed_mentions: { parse: [] },
      embeds: [
        {
          title,
          description: opts.description ?? undefined,
          color: COLOURS[opts.colour ?? "info"],
          fields: opts.fields ?? [],
          timestamp: new Date().toISOString(),
        },
      ],
    });

    try {
      const response = await fetchImpl(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        // Bound the best-effort delivery so a hung webhook can't stall the
        // caller. An AbortError lands in the catch below as a network_error.
        signal: AbortSignal.timeout(2000),
      });

      if (!response.ok) {
        options.logger?.warn("discord_alert_delivery_failed", {
          status: response.status,
          statusText: response.statusText,
        });
      }
    } catch {
      options.logger?.warn("discord_alert_delivery_failed", {
        reason: "network_error",
      });
      // Discord delivery is always best-effort.
    }
  };
}

export type LogAndAlertOptions = {
  logger: LoggerPort;
  level: LogLevel;
  message: string;
  extra?: Record<string, unknown>;
  alert?: {
    send?: DiscordAlertFn | null;
    payload: DiscordAlertOptions;
  };
};

export type LogAndReportOptions = LogAndAlertOptions & {
  report?: {
    captureException?: ReportExceptionFn | null;
    error?: unknown;
    context?: ReportExceptionContext;
    /**
     * Optional builder that turns the event id returned by `captureException`
     * into a deep-link URL (e.g. a Sentry issue link). When it yields a
     * non-empty URL and an alert is being sent, a clickable "Sentry" field is
     * appended to the outgoing alert. Keeping the URL construction here (rather
     * than in the adapter) leaves this module framework-/vendor-agnostic.
     */
    buildSentryUrl?: (eventId: string) => string | undefined;
  };
  alert?: {
    send?: DiscordAlertFn | null;
    payload: DiscordAlertOptions;
  };
};

export async function logAndReport({
  logger,
  level,
  message,
  extra,
  report,
  alert,
}: LogAndReportOptions): Promise<void> {
  logger.log(level, message, extra);

  let eventId: string | undefined;
  if (report?.captureException && report.error !== undefined) {
    try {
      const returned = report.captureException(report.error, report.context);
      eventId = typeof returned === "string" ? returned : undefined;
    } catch {
      // Reporting is best-effort; a throwing capture leaves eventId undefined.
    }
  }

  if (!alert?.send) {
    return;
  }

  // Best-effort deep-link: if the tracker handed back an event id and the caller
  // supplied a URL builder, append a clickable field. Never mutate the caller's
  // payload/fields array — build a fresh payload. Any failure => original payload.
  let payload = alert.payload;
  if (eventId && report?.buildSentryUrl) {
    try {
      const url = report.buildSentryUrl(eventId);
      if (url) {
        payload = {
          ...alert.payload,
          fields: [
            ...(alert.payload.fields ?? []),
            { name: "Sentry", value: `[View issue](${url})`, inline: false },
          ],
        };
      }
    } catch {
      // Link building is best-effort — fall back to the original payload.
    }
  }

  try {
    await alert.send(payload);
  } catch {
    // Call sites should never fail because the alert channel is unavailable.
  }
}

export async function logAndAlert({
  logger,
  level,
  message,
  extra,
  alert,
}: LogAndAlertOptions): Promise<void> {
  await logAndReport({
    logger,
    level,
    message,
    extra,
    alert,
  });
}
