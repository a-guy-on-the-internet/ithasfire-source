import { randomBytes } from "node:crypto";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { fail } from "@th/errors";

import { generateVenueCalendarFeed, type ICalEvent } from "../../lib/ical";
import { parseInput } from "../../lib/io";
import {
  eventIdsWithAddress,
  gatedRowAddressText,
  loadHolderAddressesForEventIds,
} from "../../lib/location/load-holder-addresses";
import { volunteerMayReceiveAddress } from "../../lib/location/holder-eligibility";
import { VOLUNTEER_ICS_UID_DOMAIN } from "./export-signup-ics";
import {
  exportMyVolunteeringIcsInputSchema,
  getMyVolunteerIcsFeedTokenInputSchema,
  rotateMyVolunteerIcsFeedTokenInputSchema,
} from "./schemas";

// ── Deps ────────────────────────────────────────────────────────────────────

export type VolunteerIcsFeedDeps = {
  repos: Repos;
  clock: ClockPort;
  appBaseUrl: string;
  logger?: LoggerPort;
};

export type GetMyVolunteerIcsFeedTokenOutput = {
  feedToken: string;
  /** True when this call minted the token (first subscribe). */
  minted: boolean;
};

export type ExportMyVolunteeringIcsOutput = {
  icsBody: string;
  filename: string;
};

/** 32-byte base64url secret — the codebase's opaque-token convention
 * (org invites, ticket email transfers, API keys). */
function generateFeedToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Get-or-mint the actor's own "my volunteering" feed token (FR-012 —
 * lazily minted on first subscribe). IDEMPOTENT: an existing token is
 * returned as-is, never rotated — rotating would silently break every
 * calendar app already subscribed. Self-service only: the token grants a
 * standing read of the actor's own schedule, so no one else may mint or
 * read it. Concurrent first-subscribes are race-safe: the mint is a
 * set-if-absent write (`setVolunteerIcsFeedToken` only fills a NULL
 * column and reports whether it won), and a loser re-reads and returns
 * the winner's token — never its own losing candidate, which would be a
 * dead calendar URL forever.
 */
export async function getMyVolunteerIcsFeedToken(
  deps: VolunteerIcsFeedDeps,
  rawInput: unknown,
): Promise<GetMyVolunteerIcsFeedTokenOutput> {
  const input = parseInput(getMyVolunteerIcsFeedTokenInputSchema, rawInput);

  return deps.repos.tx(async (tx) => {
    const existing = await tx.volunteering.getVolunteerIcsFeedToken(
      input.actorHumanId,
    );
    if (existing) {
      return { feedToken: existing, minted: false };
    }

    const token = generateFeedToken();
    const won = await tx.volunteering.setVolunteerIcsFeedToken(
      input.actorHumanId,
      token,
    );
    if (!won) {
      // Lost a concurrent first-subscribe race: the winner's committed
      // token is THE token — re-read and hand it back. (A zero-row write
      // with no token on re-read means the human row doesn't exist.)
      const winner = await tx.volunteering.getVolunteerIcsFeedToken(
        input.actorHumanId,
      );
      if (!winner) {
        throw fail("NOT_FOUND", {
          message: "human_not_found",
          meta: { entity: "human" },
        });
      }
      return { feedToken: winner, minted: false };
    }

    // Audit the mint, never the token value (it's a bearer secret).
    await tx.audit.log({
      entity: "human",
      entityId: input.actorHumanId,
      action: "volunteer_ics_feed_token_minted",
      data: { actorHumanId: input.actorHumanId },
      at: deps.clock.now(),
    });

    return { feedToken: token, minted: true };
  });
}

/**
 * Rotate the actor's own feed token — the escape hatch for a leaked
 * calendar URL. Unlike `getMyVolunteerIcsFeedToken` (idempotent
 * get-or-mint), this UNCONDITIONALLY overwrites whatever token exists
 * (or fills an empty column) with a freshly minted one, so every
 * calendar app subscribed to the old URL breaks on its next poll. The
 * old token stops resolving the moment this commits: the public feed
 * authenticates by looking the token VALUE up
 * (`findHumanIdByIcsFeedToken` — a unique-column equality read), so an
 * overwritten value simply matches no row. Self-service only, same as
 * the mint path: the token grants a standing read of the actor's own
 * schedule, so only the actor may rotate it. Output shape matches the
 * get-or-mint use case so callers can swap URLs in place
 * (`minted: true` — this call always produced a fresh token).
 */
export async function rotateMyVolunteerIcsFeedToken(
  deps: VolunteerIcsFeedDeps,
  rawInput: unknown,
): Promise<GetMyVolunteerIcsFeedTokenOutput> {
  const input = parseInput(rotateMyVolunteerIcsFeedTokenInputSchema, rawInput);

  return deps.repos.tx(async (tx) => {
    const token = generateFeedToken();
    const replaced = await tx.volunteering.replaceVolunteerIcsFeedToken(
      input.actorHumanId,
      token,
    );
    if (!replaced) {
      // Zero rows updated on an unconditional write = the human row
      // doesn't exist (mirrors the mint path's no-such-human branch).
      throw fail("NOT_FOUND", {
        message: "human_not_found",
        meta: { entity: "human" },
      });
    }

    // Audit the rotation, never the token value (it's a bearer secret).
    await tx.audit.log({
      entity: "human",
      entityId: input.actorHumanId,
      action: "volunteer_ics_feed_token_rotated",
      data: { actorHumanId: input.actorHumanId },
      at: deps.clock.now(),
    });

    return { feedToken: token, minted: true };
  });
}

/**
 * Public, token-authenticated "my volunteering" `.ics` feed (FR-012).
 *
 * - Unknown token → uniform NOT_FOUND with no hint (the response must not
 *   distinguish "no such token" from anything else — it's a bearer probe).
 * - Rows come from `listUpcomingSignupsForFeed`, which already scopes to
 *   ACCEPTED (APPROVED | CHECKED_IN) time-bound signups from `now` on; the
 *   status filter here is a defensive belt against adapter drift, not the
 *   primary gate.
 */
export async function exportMyVolunteeringIcs(
  deps: VolunteerIcsFeedDeps,
  rawInput: unknown,
): Promise<ExportMyVolunteeringIcsOutput> {
  const input = parseInput(exportMyVolunteeringIcsInputSchema, rawInput);

  const humanId = await deps.repos.volunteering.findHumanIdByIcsFeedToken(
    input.feedToken,
  );
  if (!humanId) {
    throw fail("NOT_FOUND");
  }

  const now = deps.clock.now();
  const rows = (
    await deps.repos.volunteering.listUpcomingSignupsForFeed(humanId, now)
  ).filter((r) => volunteerMayReceiveAddress(r.status));

  // LOCATION goes through the same gate as a ticket holder's address: no
  // street before the event's reveal, none ever for NEVER (organizers can
  // tell their volunteers directly), and the Place's street — not the Event
  // row's public projection — for a venue that withholds its address. The
  // feed is re-fetched on every calendar poll, so a revealed address shows
  // up on the next poll without anything to push.
  const holderAddresses = await loadHolderAddressesForEventIds({
    repos: deps.repos,
    eventIds: eventIdsWithAddress(rows),
    // Every row survived the accepted-only filter above.
    activeHolder: true,
    now,
  });

  const events: ICalEvent[] = rows.map((r) => ({
    uid: `volunteer-signup-${r.signupId}@${VOLUNTEER_ICS_UID_DOMAIN}`,
    title: `${r.title} — ${r.roleName}`,
    startsAt: r.startsAt,
    endsAt: r.endsAt,
    // A row that carried no location (ask-path rows) still carries none; the
    // gate never ADDS a LOCATION to a VEVENT that had none.
    location: gatedRowAddressText(r, holderAddresses, {
      activeHolder: volunteerMayReceiveAddress(r.status),
    }),
    description: r.shiftLabel ? `Shift: ${r.shiftLabel}` : null,
    url: r.eventSlug ? `${deps.appBaseUrl}/events/${r.eventSlug}` : null,
  }));

  return {
    icsBody: generateVenueCalendarFeed(events, {
      calendarName: "My volunteering",
    }),
    filename: "my-volunteering.ics",
  };
}
