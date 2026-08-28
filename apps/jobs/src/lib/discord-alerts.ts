import {
  createDiscordWebhookAlertSender,
  detectCloudRunEnvTag,
} from "@th/adapters/infra/discord-alerts";
import { createPinoLoggerAdapter } from "@th/adapters/infra/logger";

import { env } from "./env";

const logger = createPinoLoggerAdapter().child({ transport: "discord_alerts" });

export const fireDiscordAlert = createDiscordWebhookAlertSender({
  webhookUrl: env.DISCORD_ALERTS_WEBHOOK,
  logger,
  titlePrefix:
    detectCloudRunEnvTag() ??
    (process.env.NODE_ENV === "production" ? "prod" : "local"),
});

/**
 * Build a Cloud Logging deep-link that scopes to a single job run.
 *
 * Returns null when we can't construct a useful URL (local dev, no
 * GCP_PROJECT_ID set, etc.) so callers can omit the field rather than
 * paste a broken link.
 *
 * Operators clicking the link land in the Cloud Logging Explorer with
 * the runId pre-filtered — every log line emitted by the run shows up
 * because the dispatcher (`app.ts`) binds runId into the job logger's
 * child context.
 */
export function buildCloudLoggingUrl(runId: string): string | null {
  const projectId = process.env.GCP_PROJECT_ID ?? process.env.PROJECT_ID;
  if (!projectId || !runId) return null;
  const service = process.env.K_SERVICE; // Cloud Run injects this
  const filterLines = [
    service ? `resource.labels.service_name="${service}"` : null,
    `jsonPayload.runId="${runId}"`,
  ].filter((l): l is string => l !== null);
  const filter = filterLines.join("\n");
  return `https://console.cloud.google.com/logs/query;query=${encodeURIComponent(filter)}?project=${encodeURIComponent(projectId)}`;
}
