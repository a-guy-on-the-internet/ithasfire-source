import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { fail, isAppError } from "@th/errors";

import { parseInput } from "../../lib/io";
import { requireScannerAccessOnOrg } from "../../lib/rbac";
import {
  recordScannerOperatorBootstrapInputSchema,
  SCANNER_OPERATOR_ROLES,
} from "./schemas";

export type RecordScannerOperatorBootstrapDeps = {
  repos: Repos;
  authz: AuthZPort;
  clock: ClockPort;
  logger?: LoggerPort;
};

export type RecordScannerOperatorBootstrapOutput = {
  ok: true;
};

/**
 * Log a scanner first-run bootstrap event for support visibility.
 *
 * The rollout spec says lightweight is fine and explicitly sets
 * `migrations_needed: false` and `data.new_models: []`. To honor that, we
 * reuse the existing audit-log port instead of introducing a new
 * `scanner_operator_bootstrap_logs` table or analytics port. If/when the
 * volume warrants a dedicated registry, this use case is the seam to
 * replace.
 */
export async function recordScannerOperatorBootstrap(
  deps: RecordScannerOperatorBootstrapDeps,
  rawInput: unknown,
): Promise<RecordScannerOperatorBootstrapOutput> {
  const input = parseInput(recordScannerOperatorBootstrapInputSchema, rawInput);

  // An audit row only NAMES an event the actor may scan (F16, 2026-09-29):
  // this used to record ANY eventId. A saved eventId the actor can't scan
  // (access revoked, event gone, personal event) is dropped and flagged
  // rather than refused, so the bootstrap telemetry itself isn't lost. Same
  // gate as getScannerSessionContext; non-access failures still throw.
  const eventIdAllowed = input.eventId
    ? await actorMayScanEvent(deps, input.eventId, input.actorHumanId)
    : false;
  const recordedEventId = eventIdAllowed ? (input.eventId ?? null) : null;
  const eventIdRejected = Boolean(input.eventId) && !eventIdAllowed;

  await deps.repos.tx(async (tx) => {
    await tx.audit.log({
      entity: "scanner_operator",
      entityId: input.actorHumanId,
      action: "scanner.bootstrap",
      at: deps.clock.now(),
      data: {
        appVersion: input.appVersion,
        channel: input.channel,
        outcome: input.outcome,
        eventId: recordedEventId,
        ...(eventIdRejected ? { eventIdRejected: true } : {}),
        failureReason: input.failureReason ?? null,
      },
    });
  });

  deps.logger?.info("scanner.record_bootstrap", {
    actorHumanId: input.actorHumanId,
    appVersion: input.appVersion,
    channel: input.channel,
    outcome: input.outcome,
    hasEventId: !!recordedEventId,
    eventIdRejected,
  });

  return { ok: true };
}

const SCAN_ACCESS_DENIALS = new Set([
  "EVENT_NOT_FOUND",
  "EVENT_NOT_ORG_OWNED",
  "INSUFFICIENT_ROLE",
  // A platform ADMIN with no second factor enrolled: no override, so no access.
  "SECOND_FACTOR_REQUIRED",
]);

async function actorMayScanEvent(
  deps: RecordScannerOperatorBootstrapDeps,
  eventId: string,
  actorHumanId: string,
): Promise<boolean> {
  try {
    const event = await deps.repos.events.getById(eventId);
    if (!event) throw fail("EVENT_NOT_FOUND");
    if (!event.orgId) throw fail("EVENT_NOT_ORG_OWNED");
    await requireScannerAccessOnOrg({
      repos: deps.repos,
      authz: deps.authz,
      orgId: event.orgId,
      actorHumanId,
      roles: SCANNER_OPERATOR_ROLES,
      errorCode: "INSUFFICIENT_ROLE",
    });
    return true;
  } catch (err) {
    if (isAppError(err) && SCAN_ACCESS_DENIALS.has(err.code)) return false;
    throw err;
  }
}
