import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import type { NotifyInput, NotifyOutput } from "../../comms/notify";
import { describeError } from "../../../lib/io";
import type { AgreementParty } from "./agreement-access";

export type NotifyFn = (input: NotifyInput) => Promise<NotifyOutput>;

const ORG_NOTIFY_MEMBER_LIMIT = 50;

/**
 * Best-effort in-app ping to an agreement party (v1: in-app only).
 *
 * - Human party → that human.
 * - Org party → the org's OWNER/ADMIN members (first page; an org with >50
 *   members is far outside the booking-agreement persona for v1).
 *
 * The actor is excluded and ALL failures are swallowed — a notify outage must
 * never fail (or roll back) the agreement mutation, so callers invoke this
 * AFTER their tx commits. The swallow is a deliberate degrade, so it reports
 * through `ReporterPort` (CLAUDE.md convention) as well as `logger.error`.
 */
export async function notifyAgreementParty(
  deps: {
    repos: Pick<Repos, "organizations">;
    notify?: NotifyFn;
    logger?: LoggerPort;
    reportError?: ReporterPort;
  },
  input: {
    party: AgreementParty;
    actorHumanId: string;
    agreementId: string;
    /** Stable suffix for the notify idempotency key, e.g. "proposed". */
    eventKey: string;
    title: string;
    body: string;
  },
): Promise<void> {
  if (!deps.notify) return;

  try {
    const humanIds =
      input.party.type === "human"
        ? [input.party.id]
        : (
            await deps.repos.organizations.listMembers({
              orgId: input.party.id,
              limit: ORG_NOTIFY_MEMBER_LIMIT,
              offset: 0,
            })
          ).items
            .filter((m) => m.role === "OWNER" || m.role === "ADMIN")
            .map((m) => m.humanId);

    for (const humanId of humanIds) {
      if (humanId === input.actorHumanId) continue;
      await deps.notify({
        humanId,
        variant: "notification.generic",
        payload: {
          title: input.title,
          body: input.body,
          metadata: { agreementId: input.agreementId },
        },
        idempotencyKey: `bookingAgreement:${input.agreementId}:${input.eventKey}:${humanId}`,
        channels: {
          inApp: { enabled: true },
          push: { enabled: false },
          email: { enabled: false },
          sms: { enabled: false },
        },
      });
    }
  } catch (error) {
    deps.logger?.error?.("booking_agreements.notify_failed", {
      agreementId: input.agreementId,
      eventKey: input.eventKey,
      error: describeError(error),
    });
    // Guarded: a throwing reporter must never turn a swallowed notify
    // failure into a failed mutation.
    try {
      deps.reportError?.(error, {
        tags: {
          useCase: "booking-agreements.notify-party",
          eventKey: input.eventKey,
        },
        extra: { agreementId: input.agreementId, actorHumanId: input.actorHumanId },
      });
    } catch {
      // Intentionally empty — see `safeReporter` in @th/ports/reporter.
    }
  }
}
