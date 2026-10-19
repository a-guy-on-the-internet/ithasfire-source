import { randomUUID } from "node:crypto";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos, TxRepos } from "@th/ports/repos";
import type {
  EventVolunteerRoleWithShiftsRecord,
  VolunteerShiftRecord,
  VolunteerSignupRecord,
} from "@th/ports/repos/volunteering";
import type { EventRecord } from "@th/ports/repos/events";
import type { VolunteerScanTokenPort } from "@th/ports/volunteer-scan-token";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";
import {
  ORG_EDIT_ROLES,
  ORG_SCAN_ROLES,
  requireScannerAccessOnOrg,
} from "../../lib/rbac";
import {
  getVolunteerContextForTicketScanInputSchema,
  mintVolunteerScanTokenInputSchema,
  resolveVolunteerSignupByTokenInputSchema,
  searchVolunteerSignupsForCheckInInputSchema,
} from "./schemas";

// ── Deps ────────────────────────────────────────────────────────────────────

export type VolunteerScanTokenDeps = {
  repos: Repos;
  authz: Pick<AuthZPort, "hasStaffRole">;
  clock: ClockPort;
  volunteerScanToken: VolunteerScanTokenPort;
  logger?: LoggerPort;
  /** TTL for `short` tokens in hours. Defaults to 24h. */
  shortTokenTtlHours?: number;
  /**
   * Hard cap on an ORGANIZER-minted `print` token's TTL, in seconds.
   * Defaults to 90 days.
   */
  printTokenMaxTtlSeconds?: number;
  /**
   * Hard cap on a SELF-minted (`print`) token's TTL, in seconds. Defaults to
   * 14 days. Always applied as a `Math.min` against the organizer TTL, so a
   * volunteer's own token can never outlive what an organizer would have been
   * given for the same signup, and `printTokenMaxTtlSeconds` still binds.
   */
  selfPrintTokenMaxTtlSeconds?: number;
};

const DEFAULT_SHORT_TTL_HOURS = 24;
const DEFAULT_PRINT_MAX_TTL_SECONDS = 90 * 24 * 60 * 60;
/**
 * Ceiling on a volunteer's own printable QR. Two weeks covers "print it the
 * week of the shift" with slack, while bounding how long a lost sheet of paper
 * stays live. Past this the volunteer re-mints; a stale QR degrades to the
 * door's name-search fallback rather than failing the volunteer outright.
 */
const DEFAULT_SELF_PRINT_MAX_TTL_SECONDS = 14 * 24 * 60 * 60;
const PRINT_TTL_TRAILING_SECONDS = 24 * 60 * 60; // event end + 24h
/** Grace for a print token minted after the trailing window already closed. */
const EXPIRED_EVENT_PRINT_TTL_SECONDS = 15 * 60;
const EARLY_WINDOW_MS = 60 * 60 * 1000; // 60 min
const LATE_WINDOW_MS = 60 * 60 * 1000; // 60 min

const ELIGIBLE_STATUSES = new Set<VolunteerSignupRecord["status"]>([
  "APPROVED",
  "CHECKED_IN",
  "NO_SHOW",
]);

// ── Shared candidate output ─────────────────────────────────────────────────

export type VolunteerCheckInCandidate = {
  signupId: string;
  humanId: string;
  humanDisplayName: string;
  humanContactMasked: string;
  eventId: string;
  eventTitle: string;
  roleId: string;
  roleLabel: string;
  shiftId: string;
  shiftLabel: string;
  shiftStartAt: string;
  shiftEndAt: string;
  status: "APPROVED" | "CHECKED_IN" | "NO_SHOW";
  checkedInAt: string | null;
  checkedInByHumanId: string | null;
  window: "before" | "within" | "after";
  scanWindowNote: string;
  alsoHoldsTicket: boolean;
};

// ── mint-volunteer-scan-token ───────────────────────────────────────────────

/**
 * Mint a signed volunteer scan token for an APPROVED signup.
 *
 * - The signup's owner can mint their own `short` token, and their own
 *   `print` token (a printable QR for their OWN signup — see the badge/QR
 *   note below).
 * - Org-edit-role admins (and a platform ADMIN acting on a tenant) can mint
 *   either kind for any approved signup on the event.
 * - The token is human+event scoped so a single token covers all of a
 *   volunteer's eligible signups for the event (FR-010).
 *
 * A QR IS NOT A BADGE. Badge stock is venue-issued: it reads as
 * authorization and stays organizer/venue-only, printed by whoever is
 * accountable at the door. What a volunteer mints here is only "scan me in" —
 * the same human+event assertion they already carry on their phone, on paper
 * for the volunteer whose phone is dead. It admits nobody by itself: an
 * authorized operator still has to resolve it and check the person in.
 * (Exact floors, since they differ and it matters: direct token resolution
 * via `resolveVolunteerSignupByToken` requires ORG_EDIT_ROLES, while the
 * unified scanner's `resolveScanPayload` reaches the volunteer branch through
 * `getVolunteerContextForTicketScan` at ORG_SCAN_ROLES, which also admits
 * SCANNER. Do not paraphrase these as one gate.) Do not grow this path into
 * badge issuance, and do not let the volunteer surface present it as one.
 *
 * ANTI-ORACLE: authorization runs BEFORE any state inspection, matching
 * `reviewVolunteerSignup`. Every "you have no business with this id" outcome —
 * nonexistent, ask-only, someone else's — collapses to a single
 * `SIGNUP_NOT_FOUND`, so an authenticated stranger probing ids cannot tell
 * "not yours" from "doesn't exist" (nor classify a foreign signup by status).
 * Status / shape errors are only reachable once the caller is the owner or an
 * org-edit admin, i.e. someone already entitled to know.
 *
 * State the guarantee accurately: this is RESPONSE-SHAPE indistinguishability,
 * not TIMING indistinguishability. "Doesn't exist" returns after one query,
 * while "not yours" costs an event read, a membership read and possibly a
 * `hasStaffRole` call, so the two are separable by a caller who can measure.
 * That is accepted, not overlooked: `signupId` is a UUIDv4, so an attacker
 * able to time the difference already possesses the id and has learned
 * nothing they could not have learned by holding it. Do not restate this
 * guarantee more strongly than that.
 *
 * Naturally idempotent: nothing is written. Calling repeatedly with the
 * same inputs simply mints a fresh equivalent token.
 */
export async function mintVolunteerScanToken(
  deps: VolunteerScanTokenDeps,
  rawInput: unknown,
): Promise<{ token: string; expiresAt: Date }> {
  const input = parseInput(mintVolunteerScanTokenInputSchema, rawInput);

  const mint = await deps.repos.tx(async (tx) => {
    const signup = await tx.volunteering.getSignup(input.signupId);
    if (!signup) {
      throw fail("SIGNUP_NOT_FOUND");
    }

    // `eventId` is nullable since generic asks — scan tokens are an
    // event-gate concept, so ask-only signups can't mint one.
    // SIGNUP_NOT_FOUND, not EVENT_NOT_FOUND: revealing "this signup exists
    // but isn't event-owned" would let anyone probe ids and classify them
    // (same anti-oracle rule as review/check-in). Checked immediately after
    // existence — BEFORE the authz gate, which is safe because it throws the
    // SAME error the gate does, and necessary because an ask-only signup has
    // no event and therefore no org to authorize against.
    if (!signup.eventId) {
      throw fail("SIGNUP_NOT_FOUND");
    }

    const event = await tx.events.getById(signup.eventId);
    if (!event || !event.orgId) {
      // Unreachable-but-defended (the event FK cascades). SIGNUP_NOT_FOUND
      // rather than EVENT_NOT_FOUND: this is still pre-authz, so a distinct
      // code here would classify the probed id as "a real signup whose event
      // is malformed" for a caller with no claim on it.
      throw fail("SIGNUP_NOT_FOUND");
    }

    // ── Authorization — BEFORE any state inspection ──────────────────────
    // Ownership + role first. Checking `status` first would let an
    // authenticated user probe arbitrary signup ids and tell
    // "exists + not approved" (conflict) from "exists + approved, not yours"
    // (forbidden) from "doesn't exist" (not found). Same rule, and the same
    // reason, as `reviewVolunteerSignup`.
    const isOwner = !!signup.humanId && signup.humanId === input.actorHumanId;
    const membership = await tx.authz.getOrgMembership({
      orgId: event.orgId,
      humanId: input.actorHumanId,
    });
    const isOrgEdit =
      !!membership &&
      (ORG_EDIT_ROLES as readonly string[]).includes(membership.role);
    // The platform-admin probe is for actors who need the OVERRIDE to get in
    // at all. An owner is already authorized as themselves, so we skip it —
    // otherwise an Ithas Fire staffer volunteering at somebody's event and
    // printing their own QR would be recorded as a tenant override
    // (`scan_token_minted.platform_admin_override`, `isOwnerSelfMint: false`)
    // and handed the organizer TTL. Since the audit row is the ONLY home of
    // provenance here, salting the highest-signal action with false positives
    // is how a real override gets missed. (It also drops a `hasStaffRole`
    // round-trip from the common self-mint path.)
    let viaPlatformAdmin = false;
    if (!isOwner && !isOrgEdit) {
      const staff = await deps.authz.hasStaffRole({
        actorHumanId: input.actorHumanId,
        requiredRoles: ["ADMIN"],
      });
      if (staff.allowed) viaPlatformAdmin = true;
    }
    const hasOrgEditRole = isOrgEdit || viaPlatformAdmin;

    if (!isOwner && !hasOrgEditRole) {
      // Deliberately the same code as "no such signup" — see the anti-oracle
      // note on this function. The cost is that an org member holding a
      // non-edit role (e.g. SCANNER) sees "not found" instead of a role
      // error; the print surfaces are org-edit-gated anyway, and one uniform
      // rule is worth more than a nicer message on a path nobody walks.
      throw fail("SIGNUP_NOT_FOUND");
    }

    // ── Past the gate: the caller owns this signup or administers its org,
    // so state errors are safe to name. ─────────────────────────────────────
    if (signup.status !== "APPROVED") {
      throw fail("SIGNUP_NOT_APPROVED");
    }

    if (!signup.humanId) {
      // Tokens are keyed to a Human. A signup with no Human is expected, not
      // malformed: a CONTACT-ONLY signup (an anonymous signup naming an email
      // that already has an account) is deliberately left unlinked. Those
      // volunteers are checked in manually from the roster; the badge sheet
      // counts them and says so.
      throw fail("SIGNUP_MISSING_HUMAN");
    }

    /**
     * A volunteer minting for themselves, with no organizer capability of
     * their own. An owner who ALSO holds an org-edit role is treated as an
     * organizer (they can already mint for anyone on the event, so pretending
     * otherwise would only mislead the audit trail).
     */
    const isSelfMint = isOwner && !hasOrgEditRole;

    const now = deps.clock.now();
    const ttl =
      input.kind === "short"
        ? (deps.shortTokenTtlHours ?? DEFAULT_SHORT_TTL_HOURS) * 3600
        : isSelfMint
          ? computeSelfPrintTtlSeconds(
              event,
              now,
              deps.printTokenMaxTtlSeconds,
              deps.selfPrintTokenMaxTtlSeconds,
            )
          : computePrintTtlSeconds(event, now, deps.printTokenMaxTtlSeconds);

    // Minted here rather than in the adapter so this row and the token carry
    // the SAME id: a printed QR found on the floor can be decoded and joined
    // back to the row that says who minted it, when, and on what basis.
    // Without it, two mints of this signup in the same second with the same
    // TTL produce byte-identical tokens and the audit trail cannot tell you
    // which one you are holding.
    const jti = randomUUID();

    // The audit row is the ONLY place the two provenances are distinguished
    // (`isOwnerSelfMint` + `kind` + `ttlSeconds`), and it is deliberately the
    // only place: the token itself carries no self-mint marker, because
    // nothing downstream should behave differently based on one. See the
    // scope note on `VolunteerScanTokenPort` — including the caveat that the
    // TTL is nonetheless READABLE off the wire, and must never be treated as
    // an authorization signal.
    await tx.audit.log({
      entity: "volunteer_signup",
      entityId: signup.id,
      action: viaPlatformAdmin
        ? "scan_token_minted.platform_admin_override"
        : "scan_token_minted",
      data: {
        actorHumanId: input.actorHumanId,
        kind: input.kind,
        ttlSeconds: ttl,
        isOwnerSelfMint: isSelfMint,
        viaPlatformAdmin,
        orgId: event.orgId,
        jti,
      },
      at: now,
    });

    return {
      humanId: signup.humanId,
      eventId: signup.eventId,
      ttlSeconds: ttl,
      jti,
    };
  });

  return deps.volunteerScanToken.sign({
    humanId: mint.humanId,
    eventId: mint.eventId,
    kind: input.kind,
    ttlSeconds: mint.ttlSeconds,
    jti: mint.jti,
  });
}

function computePrintTtlSeconds(
  event: EventRecord,
  now: Date,
  maxOverride: number | undefined,
): number {
  const max = maxOverride ?? DEFAULT_PRINT_MAX_TTL_SECONDS;
  if (!event.endsAt) return max;
  const remaining =
    Math.floor((event.endsAt.getTime() - now.getTime()) / 1000) +
    PRINT_TTL_TRAILING_SECONDS;
  // Past the trailing window the TTL is exhausted. Return a small fixed
  // grace, NOT the full trailing window: handing back 24h here made the
  // function non-monotonic — the further past the deadline you minted, the
  // longer-lived the token you got, with a token minted a year late outliving
  // one minted an hour late. Nothing depends on the old value (an org can
  // still mint repeatedly), and "the deadline has passed, here is just enough
  // to finish the scan in your hand" is the honest shape.
  if (remaining <= 0) return EXPIRED_EVENT_PRINT_TTL_SECONDS;
  return Math.min(remaining, max);
}

/**
 * TTL for a volunteer's own printable QR.
 *
 * Same anchor as the organizer's (event end + 24h) — the paper has to still
 * work at the door or the feature is pointless — but clamped by a tighter
 * ceiling. Expressed as `min(organizerTtl, selfMax)` on purpose: it is then
 * structurally impossible for a self-minted token to outlive the organizer
 * token for the same signup, and `printTokenMaxTtlSeconds` keeps binding
 * through the organizer term. An organizer's sheet goes printer → door; a
 * volunteer's lives in a bag for as long as they keep it, so the window in
 * which a lost one is live gets bounded.
 */
function computeSelfPrintTtlSeconds(
  event: EventRecord,
  now: Date,
  maxOverride: number | undefined,
  selfMaxOverride: number | undefined,
): number {
  const organizerTtl = computePrintTtlSeconds(event, now, maxOverride);
  const selfMax = selfMaxOverride ?? DEFAULT_SELF_PRINT_MAX_TTL_SECONDS;
  return Math.min(organizerTtl, selfMax);
}

// ── resolve-volunteer-signup-by-token ───────────────────────────────────────

/**
 * Verify a volunteer scan token and return all eligible signups for the
 * token's human on the token's event. Used by the scanner app's volunteer
 * check-in flow (FR-002 / FR-006). Does NOT call any mutation.
 */
export async function resolveVolunteerSignupByToken(
  deps: VolunteerScanTokenDeps,
  rawInput: unknown,
): Promise<VolunteerCheckInCandidate[]> {
  const input = parseInput(resolveVolunteerSignupByTokenInputSchema, rawInput);

  // Verify the token first; re-throw the typed error codes from the port.
  let payload;
  try {
    payload = await deps.volunteerScanToken.verify(input.token);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err) {
      const code = (err as { code: unknown }).code;
      if (code === "volunteer_qr_expired" || code === "volunteer_qr_invalid") {
        throw err;
      }
    }
    throw fail("TOKEN_INVALID", { category: "INVALID_INPUT" });
  }

  if (payload.eventId !== input.eventId) {
    throw {
      code: "volunteer_qr_wrong_event",
      message: "token_event_mismatch",
      eventId: payload.eventId,
    } as const;
  }

  return deps.repos.tx(async (tx) => {
    const event = await tx.events.getById(input.eventId);
    if (!event || !event.orgId) {
      throw fail("EVENT_NOT_FOUND");
    }

    await requireScannerAccessOnOrg({
      repos: tx,
      authz: deps.authz,
      orgId: event.orgId,
      actorHumanId: input.actorHumanId,
      roles: ORG_EDIT_ROLES,
      errorCode: "INSUFFICIENT_ROLE",
    });

    const signups = await loadEligibleSignupsForHumanOnEvent(
      tx,
      payload.humanId,
      input.eventId,
    );

    return mapAndSortCandidates(tx, signups, event, deps.clock.now());
  });
}

// ── search-volunteer-signups-for-check-in ───────────────────────────────────

/**
 * Org-edit-scoped search across eligible signups for an event by volunteer
 * name or email. Drives the manual fallback flow (FR-004).
 */
export async function searchVolunteerSignupsForCheckIn(
  deps: VolunteerScanTokenDeps,
  rawInput: unknown,
): Promise<VolunteerCheckInCandidate[]> {
  const input = parseInput(
    searchVolunteerSignupsForCheckInInputSchema,
    rawInput,
  );

  return deps.repos.tx(async (tx) => {
    const event = await tx.events.getById(input.eventId);
    if (!event || !event.orgId) {
      throw fail("EVENT_NOT_FOUND");
    }

    await requireScannerAccessOnOrg({
      repos: tx,
      authz: deps.authz,
      orgId: event.orgId,
      actorHumanId: input.actorHumanId,
      roles: ORG_EDIT_ROLES,
      errorCode: "INSUFFICIENT_ROLE",
    });

    const matches = await tx.humans.searchByQuery(input.query, {
      limit: input.limit,
    });

    if (matches.length === 0) return [];

    const allSignups: VolunteerSignupRecord[] = [];
    for (const match of matches) {
      const humanId = match.human.id;
      const humanSignups = await loadEligibleSignupsForHumanOnEvent(
        tx,
        humanId,
        input.eventId,
      );
      allSignups.push(...humanSignups);
      if (allSignups.length >= input.limit) break;
    }

    const trimmed = allSignups.slice(0, input.limit);
    return mapAndSortCandidates(tx, trimmed, event, deps.clock.now());
  });
}

// ── get-volunteer-context-for-ticket-scan ───────────────────────────────────

/**
 * Given a ticket-scan result (humanId + eventId), return any eligible
 * volunteer signups for the same event. Powers the "Also volunteering"
 * enrichment chip (FR-009a). Returns empty array when none.
 */
export async function getVolunteerContextForTicketScan(
  deps: VolunteerScanTokenDeps,
  rawInput: unknown,
): Promise<VolunteerCheckInCandidate[]> {
  const input = parseInput(
    getVolunteerContextForTicketScanInputSchema,
    rawInput,
  );

  return deps.repos.tx(async (tx) => {
    const event = await tx.events.getById(input.eventId);
    if (!event || !event.orgId) {
      throw fail("EVENT_NOT_FOUND");
    }

    await requireScannerAccessOnOrg({
      repos: tx,
      authz: deps.authz,
      orgId: event.orgId,
      actorHumanId: input.actorHumanId,
      // Read-only enrichment for the unified scan resolver. Any org member
      // who can scan tickets (incl. SCANNER) can read this context. Mutating
      // operations (e.g. checkInVolunteer) still require ORG_EDIT_ROLES and
      // are gated separately.
      roles: ORG_SCAN_ROLES,
      errorCode: "INSUFFICIENT_ROLE",
    });

    const signups = await loadEligibleSignupsForHumanOnEvent(
      tx,
      input.humanId,
      input.eventId,
    );

    return mapAndSortCandidates(tx, signups, event, deps.clock.now());
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function loadEligibleSignupsForHumanOnEvent(
  tx: TxRepos,
  humanId: string,
  eventId: string,
): Promise<VolunteerSignupRecord[]> {
  const all = await tx.volunteering.listSignupsByHuman(humanId);
  return all.filter(
    (s) => s.eventId === eventId && ELIGIBLE_STATUSES.has(s.status),
  );
}

async function mapAndSortCandidates(
  tx: TxRepos,
  signups: VolunteerSignupRecord[],
  event: EventRecord,
  now: Date,
): Promise<VolunteerCheckInCandidate[]> {
  if (signups.length === 0) return [];

  // Cache role + shift + human lookups so we don't re-query for the same
  // role across multiple shifts of the same volunteer.
  const roleCache = new Map<
    string,
    EventVolunteerRoleWithShiftsRecord | null
  >();
  const shiftCache = new Map<string, VolunteerShiftRecord | null>();
  const humanNameCache = new Map<string, string>();

  const candidates: VolunteerCheckInCandidate[] = [];
  for (const signup of signups) {
    if (!signup.humanId || !signup.shiftId) {
      // We require a shift to render check-in window state. v1 of the
      // volunteering surfaces always enforces a shift on APPROVED signups,
      // but be defensive.
      continue;
    }

    let role = roleCache.get(signup.roleId);
    if (role === undefined) {
      role = await tx.volunteering.getEventRole(signup.roleId);
      roleCache.set(signup.roleId, role);
    }
    let shift = shiftCache.get(signup.shiftId);
    if (shift === undefined) {
      shift = await tx.volunteering.getShift(signup.shiftId);
      shiftCache.set(signup.shiftId, shift);
    }

    if (!role || !shift) continue;

    let humanName = humanNameCache.get(signup.humanId);
    if (humanName === undefined) {
      const human = await tx.humans.getById(signup.humanId);
      // When name + contactName are both absent, fall back to a MASKED
      // form of the email so the display surface never leaks the raw
      // email alongside `humanContactMasked`.
      humanName =
        human?.name ?? signup.contactName ?? maskEmail(signup.contactEmail);
      humanNameCache.set(signup.humanId, humanName);
    }

    const window = classifyWindow(now, shift.startsAt, shift.endsAt);
    const scanWindowNote = describeWindow(
      now,
      shift.startsAt,
      shift.endsAt,
      window,
    );

    candidates.push({
      signupId: signup.id,
      humanId: signup.humanId,
      humanDisplayName: humanName,
      humanContactMasked: maskEmail(signup.contactEmail),
      eventId: event.id,
      eventTitle: event.title,
      roleId: role.id,
      roleLabel: role.name,
      shiftId: shift.id,
      shiftLabel: shift.label ?? formatFallbackShiftLabel(shift),
      shiftStartAt: shift.startsAt.toISOString(),
      shiftEndAt: shift.endsAt.toISOString(),
      status: signup.status as "APPROVED" | "CHECKED_IN" | "NO_SHOW",
      checkedInAt: signup.checkedInAt?.toISOString() ?? null,
      checkedInByHumanId: signup.reviewerHumanId ?? null,
      window,
      scanWindowNote,
      // The unified scan resolver (`resolveScanPayload`) composes the
      // alsoHoldsTicket flag separately via `repos.tickets.findByEventAndHuman`
      // because that lookup is needed only for ticket↔volunteer cross-context
      // enrichment, not for the volunteer search/check-in flow itself.
      alsoHoldsTicket: false,
    });
  }

  return sortCandidates(candidates, now);
}

function classifyWindow(
  now: Date,
  startsAt: Date,
  endsAt: Date,
): "before" | "within" | "after" {
  const t = now.getTime();
  if (t < startsAt.getTime() - EARLY_WINDOW_MS) return "before";
  if (t > endsAt.getTime() + LATE_WINDOW_MS) return "after";
  return "within";
}

function describeWindow(
  now: Date,
  startsAt: Date,
  endsAt: Date,
  window: "before" | "within" | "after",
): string {
  const minutesBetween = (a: Date, b: Date) =>
    Math.max(1, Math.round((b.getTime() - a.getTime()) / 60000));

  if (window === "before") {
    const minutes = minutesBetween(now, startsAt);
    return `Shift starts in ${formatDuration(minutes)}`;
  }
  if (window === "after") {
    const minutes = minutesBetween(endsAt, now);
    return `Shift ended ${formatDuration(minutes)} ago`;
  }
  if (now.getTime() < startsAt.getTime()) {
    const minutes = minutesBetween(now, startsAt);
    return `Shift starts in ${formatDuration(minutes)}`;
  }
  if (now.getTime() > endsAt.getTime()) {
    const minutes = minutesBetween(endsAt, now);
    return `Shift ended ${formatDuration(minutes)} ago`;
  }
  return "Shift in progress";
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  if (remaining === 0) return `${hours} h`;
  return `${hours} h ${remaining} min`;
}

function formatFallbackShiftLabel(shift: VolunteerShiftRecord): string {
  return `${shift.startsAt.toISOString()} – ${shift.endsAt.toISOString()}`;
}

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  const safeLocal = local && local.length > 1 ? `${local[0]}***` : "***";
  return `${safeLocal}@${domain}`;
}

function sortCandidates(
  candidates: VolunteerCheckInCandidate[],
  now: Date,
): VolunteerCheckInCandidate[] {
  const t = now.getTime();
  const earlyCutoff = EARLY_WINDOW_MS;

  const bucket = (c: VolunteerCheckInCandidate): number => {
    const start = new Date(c.shiftStartAt).getTime();
    const end = new Date(c.shiftEndAt).getTime();
    if (t >= start && t <= end) return 0; // currently in progress
    if (start > t && start - t <= earlyCutoff) return 1; // imminent
    return 2;
  };

  return [...candidates].sort((a, b) => {
    const ba = bucket(a);
    const bb = bucket(b);
    if (ba !== bb) return ba - bb;
    const sa = new Date(a.shiftStartAt).getTime();
    const sb = new Date(b.shiftStartAt).getTime();
    return sa - sb;
  });
}
