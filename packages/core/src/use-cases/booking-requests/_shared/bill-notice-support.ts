import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type {
  BookingRequestActRecord,
  BookingRequestRecord,
} from "@th/ports/repos/booking-requests";

import {
  getBookingRequestSender,
  isUnclaimedBookingInquiry,
} from "@th/ports/repos/booking-requests";

import { describeError } from "../../../lib/io";
import {
  listOrgEditMembers,
  resolveHumanAdminSlug,
} from "../../booking-holds/notify-booking-hold-intents";
import {
  lookupPerformerDisplayName,
  resolvePerformerDisplayNames,
} from "./performer-display-names";

// ─────────────────────────────────────────────────────────────────────────────
// Shared plumbing for the bill's notices after the invite (lineup v3,
// FR-012): who hears about an act or about the sender's request, the names
// the copy needs, and the one swallow shape every notice uses.
//
// RECIPIENTS
//   · an ACT is heard by itself when it is a person, and by its members with
//     an org edit role (ORG_EDIT_ROLES) when it is a group (v3 L17) — the
//     same people who may answer for it (`listOrgEditMembers`);
//   · the SENDER is a person, or an org's edit members — the hold notices'
//     rule (notify-booking-hold-intents `resolveActRecipients`). An
//     unclaimed anonymous inquiry has nobody to tell.
//   · in a GROUP fan-out the acting human is skipped: nobody is notified of
//     their own action.
// ─────────────────────────────────────────────────────────────────────────────

/** The renderers' name bound. */
export const BILL_NOTICE_NAME_MAX_LENGTH = 200;

export const BILL_NOTICE_SENDER_FALLBACK = "Someone";
export const BILL_NOTICE_VENUE_FALLBACK = "a place";

export type BillNoticeRecipient = {
  humanId: string;
  /** Set when the recipient hears as an editor of this group. */
  viaOrgId: string | null;
};

/** Trim + clip to the renderer bound; empty → the field's own fallback. */
export function clipNoticeName(
  name: string | null | undefined,
  fallback: string,
): string {
  return (
    (name ?? "").trim().slice(0, BILL_NOTICE_NAME_MAX_LENGTH).trim() ||
    fallback
  );
}

/** Trim trailing slashes so URL joins never emit `//…`. */
export function normalizeNoticeBaseUrl(
  url: string | null | undefined,
): string | null {
  const trimmed = url?.trim().replace(/\/+$/, "");
  return trimmed ? trimmed : null;
}

/**
 * Who hears about this act: the person, or the group's editors (minus the
 * acting human). An act with no platform identity (by-name) hears nothing.
 */
export async function resolveActNoticeRecipients(
  deps: { repos: Pick<Repos, "organizations"> },
  act: Pick<BookingRequestActRecord, "actOwnerType" | "actOwnerId">,
  actorHumanId: string | null | undefined,
): Promise<BillNoticeRecipient[]> {
  if (!act.actOwnerType || !act.actOwnerId) return [];
  if (act.actOwnerType === "human") {
    return [{ humanId: act.actOwnerId, viaOrgId: null }];
  }
  const orgId = act.actOwnerId;
  return (await listOrgEditMembers(deps, orgId))
    .filter((humanId) => !actorHumanId || humanId !== actorHumanId)
    .map((humanId) => ({ humanId, viaOrgId: orgId }));
}

/**
 * Who hears about the SENDER's request, and where their copy of it lives
 * (`/admin/{slug}/bookings` — v3 FR-014: a request lives in the admin of
 * whoever sent it). Empty for an anonymous or unclaimed inquiry.
 */
export async function resolveSenderNoticeRecipients(
  deps: { repos: Pick<Repos, "organizations" | "humans" | "entityPages"> },
  request: BookingRequestRecord,
  baseUrl: string,
  actorHumanId: string | null | undefined,
): Promise<Array<BillNoticeRecipient & { targetUrl: string }>> {
  const sender = getBookingRequestSender(request);
  if (sender.kind !== "owned" || isUnclaimedBookingInquiry(request)) return [];
  if (sender.performerOwnerType === "human") {
    const slug = await resolveHumanAdminSlug(deps, sender.performerOwnerId);
    return [
      {
        humanId: sender.performerOwnerId,
        viaOrgId: null,
        targetUrl: `${baseUrl}/admin/${slug}/bookings`,
      },
    ];
  }
  const orgId = sender.performerOwnerId;
  const org = await deps.repos.organizations.getById(orgId);
  const targetUrl = `${baseUrl}/admin/${encodeURIComponent(org?.slug || orgId)}/bookings`;
  return (await listOrgEditMembers(deps, orgId))
    .filter((humanId) => !actorHumanId || humanId !== actorHumanId)
    .map((humanId) => ({ humanId, viaOrgId: orgId, targetUrl }));
}

/**
 * The sender's platform name for act-facing copy (never `actName`, which may
 * be a by-name act's name), clipped; the neutral fallback when it does not
 * resolve.
 */
export async function resolveNoticeSenderName(
  repos: Pick<Repos, "humans" | "organizations">,
  request: BookingRequestRecord,
): Promise<string> {
  const names = await resolvePerformerDisplayNames(repos, [request]);
  return clipNoticeName(
    lookupPerformerDisplayName(request, names),
    BILL_NOTICE_SENDER_FALLBACK,
  );
}

/**
 * A group's name (Organization.name), clipped — null when the act is not a
 * group or the org does not resolve.
 */
export async function resolveNoticeGroupName(
  repos: Pick<Repos, "organizations">,
  act: Pick<BookingRequestActRecord, "actOwnerType" | "actOwnerId">,
): Promise<string | null> {
  if (act.actOwnerType !== "organization" || !act.actOwnerId) return null;
  const org = await repos.organizations.getById(act.actOwnerId);
  const name = org?.name?.trim().slice(0, BILL_NOTICE_NAME_MAX_LENGTH).trim();
  return name ? name : null;
}

/**
 * The one swallow every bill notice uses (CLAUDE.md ReporterPort
 * convention): `logger.error` (Sentry's pino backstop) AND a guarded
 * `reportError` — a throwing reporter never turns the swallow into a throw.
 */
export function reportNoticeFailure(
  deps: { logger?: LoggerPort; reportError?: ReporterPort },
  error: unknown,
  event: string,
  context: { useCase: string; step?: string; extra: Record<string, unknown> },
): void {
  deps.logger?.error(event, {
    ...context.extra,
    err: error,
    error: describeError(error),
  });
  try {
    deps.reportError?.(error, {
      tags: {
        useCase: context.useCase,
        ...(context.step ? { step: context.step } : {}),
      },
      extra: context.extra,
    });
  } catch {
    // Reporting is best-effort — a throwing reporter must never turn the
    // swallow into a thrown error.
  }
}
