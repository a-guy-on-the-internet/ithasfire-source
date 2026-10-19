import { formatDateTimeAs } from "@th/types";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@th/trpc";

// ─────────────────────────────────────────────────────────────────────────────
// Pure view logic for the lineup invite page (`/bookings/acts/[requestId]`,
// lineup v3 FR-013, board I1). No React, no translator: everything here is
// derived from the `bookingRequests.getActInvite` read so it can be tested on
// its own (the web jsdom component suite cannot prove anything today).
// ─────────────────────────────────────────────────────────────────────────────

export type ActInvite =
  inferRouterOutputs<AppRouter>["bookingRequests"]["getActInvite"];
export type InviteIdentity = ActInvite["identities"][number];
export type InviteRole = InviteIdentity["myAct"]["role"];
export type InviteBlockedReason = NonNullable<
  InviteIdentity["confirmBlockedReason"]
>;

/** Localised role names (the lineup editor's keys, shared with /my-lineups). */
export const INVITE_ROLE_KEYS: Record<InviteRole, string> = {
  PERFORMER: "admin.ebLineupRolePerformer",
  HOST: "admin.ebLineupRoleHost",
  DJ: "admin.ebLineupRoleDj",
  INSTRUCTOR: "admin.ebLineupRoleInstructor",
  SPEAKER: "admin.ebLineupRoleSpeaker",
  VENDOR: "admin.ebLineupRoleVendor",
  VOLUNTEER: "admin.ebLineupRoleVolunteer",
  OTHER: "admin.ebLineupRoleOther",
};

export const INVITE_BLOCKED_REASON_KEYS: Record<InviteBlockedReason, string> =
  {
    act_declined: "bookingActInvite.blockedActDeclined",
    request_closed: "bookingActInvite.blockedRequestClosed",
    on_lineup: "bookingActInvite.blockedOnLineup",
  };

// ── State ────────────────────────────────────────────────────────────────────

/**
 * Which one state the page renders for the identity being answered:
 *   waiting — the spot is PENDING and the request still takes answers
 *   joined  — CONFIRMED, no event yet ("Leave the bill" may be open)
 *   passed  — DECLINED; final for this request
 *   closed  — the request is not going ahead (declined / withdrawn / expired)
 *   booked  — this spot joined and is on the minted event's lineup
 *
 * Order matters. A pass stays a pass even if the request later closed (the
 * act's own answer is the more useful thing to show), and a joined spot on a
 * closed request reads as closed.
 */
export type InviteState = "waiting" | "joined" | "passed" | "closed" | "booked";

const CLOSED_REQUEST_STATUSES: ReadonlySet<ActInvite["status"]> = new Set([
  "DECLINED",
  "WITHDRAWN",
  "EXPIRED",
]);

export function deriveInviteState(
  // `eventMinted` is accepted but deliberately NOT decisive (see below).
  invite: Pick<ActInvite, "status" | "eventMinted">,
  identity: Pick<
    InviteIdentity,
    "myAct" | "confirmBlockedReason" | "declineBlockedReason"
  >,
): InviteState {
  const confirmation = identity.myAct.confirmation;
  // "Booked" means the act is ACTUALLY on the minted event's lineup — the
  // same fact the server uses to refuse a leave (`judgeActAnswer` →
  // `on_lineup`). A minted event alone is not enough: an act the editor took
  // off the lineup, or one that joined after the mint, can still leave.
  if (
    confirmation === "CONFIRMED" &&
    identity.declineBlockedReason === "on_lineup"
  ) {
    return "booked";
  }
  if (confirmation === "DECLINED") return "passed";
  if (
    CLOSED_REQUEST_STATUSES.has(invite.status) ||
    identity.confirmBlockedReason === "request_closed"
  ) {
    return "closed";
  }
  if (confirmation === "CONFIRMED") return "joined";
  return "waiting";
}

/**
 * The note under the waiting-state buttons. Once an event exists a join can
 * attach the act straight to its lineup (late join, FR-010), after which only
 * the organizer can remove it, so "you can leave until the night is booked"
 * would be false there.
 */
export function waitingNoteKey(
  invite: Pick<ActInvite, "eventMinted">,
): string {
  return invite.eventMinted
    ? "bookingActInvite.noteJoinAfterMint"
    : "bookingActInvite.noteLeaveAndPass";
}

// ── Positions ────────────────────────────────────────────────────────────────

/** `Intl.PluralRules` ordinal categories; each maps to one catalog key. */
export type OrdinalCategory = "zero" | "one" | "two" | "few" | "many" | "other";

export type PositionLabel =
  | { kind: "headline" }
  | { kind: "ordinal"; n: number; category: OrdinalCategory };

/**
 * A spot's position in words. `sortOrder` is already dense over what the
 * viewer can see (0 = top of the bill), so it is safe to show; there is no
 * total and none is ever derived here.
 */
export function positionLabel(sortOrder: number, locale: string): PositionLabel {
  if (sortOrder <= 0) return { kind: "headline" };
  const n = sortOrder + 1;
  let category: OrdinalCategory = "other";
  try {
    category = new Intl.PluralRules(locale, { type: "ordinal" }).select(
      n,
    ) as OrdinalCategory;
  } catch {
    // An unknown locale tag: fall back to the generic form.
  }
  return { kind: "ordinal", n, category };
}

export const ORDINAL_KEYS: Record<OrdinalCategory, string> = {
  zero: "bookingActInvite.ordinalOther",
  one: "bookingActInvite.ordinalOne",
  two: "bookingActInvite.ordinalTwo",
  few: "bookingActInvite.ordinalFew",
  many: "bookingActInvite.ordinalOther",
  other: "bookingActInvite.ordinalOther",
};

/** Two-digit bill index, 1-based: 0 → "01". */
export function billIndex(sortOrder: number): string {
  return String(sortOrder + 1).padStart(2, "0");
}

// ── The bill ─────────────────────────────────────────────────────────────────

export type BillRow = {
  key: string;
  sortOrder: number;
  displayName: string | null;
  /** Null for EXTERNAL acts, always (they are never links). */
  href: string | null;
  role: InviteRole;
  customRoleLabel: string | null;
  /** An act named by the sender that has no account (EXTERNAL). */
  byName: boolean;
  /** One of the viewer's own spots (themselves or a group they answer for). */
  mine: boolean;
  /** The viewer's spot is a pass (only the viewer's own rows can be). */
  passed: boolean;
};

/**
 * The bill as the viewer sees it: the acts that joined plus every spot the
 * viewer answers for, in position order.
 */
export function mergeBill(
  invite: Pick<ActInvite, "otherActs" | "identities">,
): BillRow[] {
  const others: BillRow[] = invite.otherActs.map((act, index) => ({
    key: `other-${act.sortOrder}-${index}`,
    sortOrder: act.sortOrder,
    displayName: act.displayName,
    href: act.source === "EXTERNAL" ? null : act.href,
    role: act.role,
    customRoleLabel: act.customRoleLabel,
    byName: act.source === "EXTERNAL",
    mine: false,
    passed: false,
  }));
  const mine: BillRow[] = invite.identities.map((identity) => ({
    key: `mine-${identity.myAct.id}`,
    sortOrder: identity.myAct.sortOrder,
    displayName: identity.answeringAs.displayName,
    href: identity.answeringAs.href,
    role: identity.myAct.role,
    customRoleLabel: identity.myAct.customRoleLabel,
    byName: false,
    mine: true,
    passed: identity.myAct.confirmation === "DECLINED",
  }));
  return [...others, ...mine].sort((a, b) => a.sortOrder - b.sortOrder);
}

/** A stable key for an identity: groups and people never share an id space. */
export function identityKey(
  identity: Pick<InviteIdentity, "answeringAs">,
): string {
  return `${identity.answeringAs.ownerType}:${identity.answeringAs.ownerId}`;
}

/** The `asOrgId` a join/pass needs: set for a group, absent for yourself. */
export function asOrgIdFor(
  identity: Pick<InviteIdentity, "answeringAs">,
): string | undefined {
  return identity.answeringAs.ownerType === "organization"
    ? identity.answeringAs.ownerId
    : undefined;
}

// ── Dates ────────────────────────────────────────────────────────────────────

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_AND_TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/;

/**
 * One preferred date as words. The stored strings are wall clocks with no
 * zone (`YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`, `bookingPreferredDateSchema`),
 * already in the place's local time. Reading that wall clock as UTC and
 * formatting it in UTC prints exactly what was picked, on any viewer's
 * machine, without inventing a zone the data doesn't carry. Anything else is
 * shown as stored rather than hidden.
 */
export function formatPreferredDate(raw: string, locale: string): string {
  const timed = DATE_AND_TIME.exec(raw);
  if (timed) {
    const text = formatDateTimeAs(`${timed[1]}T${timed[2]}:00Z`, "meta", {
      timeZone: "UTC",
      locale,
    });
    return text || raw;
  }
  if (DATE_ONLY.test(raw)) {
    const text = formatDateTimeAs(raw, "dateShort", {
      timeZone: "UTC",
      locale,
    });
    return text || raw;
  }
  return raw;
}

// ── Pass reason ──────────────────────────────────────────────────────────────

/** The pass / leave reason bound (`BookingRequestAct.declineReason`). */
export const PASS_REASON_MAX_LENGTH = 240;

/** What a pass sends as its reason: trimmed, and nothing when empty. */
export function passReasonInput(reason: string): string | undefined {
  const trimmed = reason.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// ── Refused answers ──────────────────────────────────────────────────────────

const BLOCKED_REASONS: ReadonlySet<string> = new Set<InviteBlockedReason>([
  "act_declined",
  "request_closed",
  "on_lineup",
]);
const REFUSAL_MESSAGE = /^booking_request_act_(act_declined|request_closed|on_lineup)$/;

/**
 * Why the server refused a join / pass, in the page's own vocabulary, or
 * null for any other failure. The refusal travels as `ACT_ALREADY_DECLINED`
 * (no meta) or `INVALID_STATUS` with `data.meta.reason` and the message
 * `booking_request_act_{reason}` (`answer-booking-request-act.ts` `refuse`).
 * The generic error copy for those codes is written for the venue's side
 * ("That artist already declined…"), so the page speaks for itself instead.
 */
export function refusalReasonOf(error: unknown): InviteBlockedReason | null {
  if (!error || typeof error !== "object") return null;
  const e = error as {
    message?: unknown;
    data?: { appCode?: unknown; meta?: { reason?: unknown } | null } | null;
  };
  if (e.data?.appCode === "ACT_ALREADY_DECLINED") return "act_declined";
  const metaReason = e.data?.meta?.reason;
  if (typeof metaReason === "string" && BLOCKED_REASONS.has(metaReason)) {
    return metaReason as InviteBlockedReason;
  }
  if (typeof e.message === "string") {
    const match = REFUSAL_MESSAGE.exec(e.message);
    if (match?.[1]) return match[1] as InviteBlockedReason;
    if (e.message === "ACT_ALREADY_DECLINED") return "act_declined";
  }
  return null;
}

/**
 * Failures that must read exactly like "not found", so the page says the
 * same thing whether the request is missing, not yours, or the id is junk.
 */
export function isNotFoundLike(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as {
    message?: unknown;
    data?: { appCode?: unknown; code?: unknown } | null;
  };
  return (
    e.data?.appCode === "BOOKING_REQUEST_NOT_FOUND" ||
    e.message === "BOOKING_REQUEST_NOT_FOUND" ||
    e.data?.code === "NOT_FOUND" ||
    e.data?.code === "BAD_REQUEST"
  );
}
