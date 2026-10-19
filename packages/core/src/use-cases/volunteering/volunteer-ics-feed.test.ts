import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import type { VolunteerFeedSignupRecord } from "@th/ports/repos/volunteering";

import {
  exportMyVolunteeringIcs,
  getMyVolunteerIcsFeedToken,
  rotateMyVolunteerIcsFeedToken,
} from "./volunteer-ics-feed";
import type { VolunteerIcsFeedDeps } from "./volunteer-ics-feed";

// ── Constants ────────────────────────────────────────────────────────────────

const HUMAN_ID = "00000000-0000-4000-8000-000000000001";
const SIGNUP_EVENT = "00000000-0000-4000-8000-000000000002";
const SIGNUP_ASK = "00000000-0000-4000-8000-000000000003";
const SIGNUP_PENDING = "00000000-0000-4000-8000-000000000004";
const ASK_ID = "00000000-0000-4000-8000-000000000005";
const EVENT_ID = "00000000-0000-4000-8000-000000000006";
const EXISTING_TOKEN = "existing-token-existing-token-existing-token";
const NOW = new Date("2026-07-02T12:00:00.000Z");

// ── Fixtures ─────────────────────────────────────────────────────────────────

const eventRow: VolunteerFeedSignupRecord = {
  signupId: SIGNUP_EVENT,
  status: "APPROVED",
  source: "EVENT_SHIFT",
  title: "Night Market",
  roleName: "Door",
  shiftLabel: "Evening doors",
  startsAt: new Date("2026-08-02T00:00:00.000Z"),
  endsAt: new Date("2026-08-02T04:30:00.000Z"),
  eventId: EVENT_ID,
  eventSlug: "night-market",
  eventTimezone: "America/New_York",
  addressText: "123 Main St, Somewhere",
  askId: null,
};

const askRow: VolunteerFeedSignupRecord = {
  signupId: SIGNUP_ASK,
  status: "CHECKED_IN",
  source: "ASK_WINDOW",
  title: "Standing bar crew",
  roleName: "Bar",
  shiftLabel: null,
  startsAt: new Date("2026-08-10T18:00:00.000Z"),
  endsAt: null,
  eventId: null,
  eventSlug: null,
  eventTimezone: null,
  addressText: null,
  askId: ASK_ID,
};

// ── Mock builders ────────────────────────────────────────────────────────────

function makeMintDeps(existingToken: string | null) {
  const txRepos = {
    volunteering: {
      getVolunteerIcsFeedToken: vi.fn(async () => existingToken),
      // Set-if-absent: true = this call won the mint.
      setVolunteerIcsFeedToken: vi.fn(async () => true),
      // Unconditional overwrite: true = the human row exists.
      replaceVolunteerIcsFeedToken: vi.fn(async () => true),
    },
    audit: { log: vi.fn(async () => undefined) },
  };
  const deps: VolunteerIcsFeedDeps = {
    repos: {
      tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
        fn(txRepos as unknown as TxRepos),
      ),
    } as unknown as Repos,
    clock: { now: () => NOW },
    appBaseUrl: "https://test.local",
  };
  return { deps, txRepos };
}

/**
 * The event behind `eventRow`: EXPLICITLY EXACT with no venue. LOCATION now
 * goes through the holder-address gate, which fails closed on a missing
 * `locationMode`, so a fixture without it would test the locked path.
 */
const exactEvent = {
  id: EVENT_ID,
  locationMode: "EXACT",
  locationRadiusMeters: null,
  addressRevealAt: null,
  addressRevealPreset: null,
  placeId: null,
  addressText: "123 Main St, Somewhere",
  locality: null,
  region: null,
  locationLabel: null,
  lat: null,
  lng: null,
};

function makeFeedDeps(
  overrides: Record<string, unknown> = {},
  repoOverrides: Record<string, unknown> = {},
) {
  const volunteering = {
    findHumanIdByIcsFeedToken: vi.fn(async () => HUMAN_ID),
    listUpcomingSignupsForFeed: vi.fn(async () => [eventRow, askRow]),
    ...overrides,
  };
  const events = {
    findManyByIds: vi.fn(async (ids: string[]) =>
      ids.includes(EVENT_ID) ? [exactEvent] : [],
    ),
  };
  const places = { getById: vi.fn(async () => null) };
  const deps: VolunteerIcsFeedDeps = {
    repos: { volunteering, events, places, ...repoOverrides } as unknown as Repos,
    clock: { now: () => NOW },
    appBaseUrl: "https://test.local",
  };
  return { deps, volunteering };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("getMyVolunteerIcsFeedToken", () => {
  it("mints a 32-byte base64url token on first subscribe and audits the mint", async () => {
    const { deps, txRepos } = makeMintDeps(null);

    const result = await getMyVolunteerIcsFeedToken(deps, {
      actorHumanId: HUMAN_ID,
    });

    expect(result.minted).toBe(true);
    expect(result.feedToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(
      (txRepos.volunteering as any).setVolunteerIcsFeedToken,
    ).toHaveBeenCalledWith(HUMAN_ID, result.feedToken);
    const auditCall = (txRepos.audit as any).log.mock.calls[0][0];
    expect(auditCall).toMatchObject({
      entity: "human",
      entityId: HUMAN_ID,
      action: "volunteer_ics_feed_token_minted",
    });
    // Never log the bearer secret.
    expect(JSON.stringify(auditCall.data)).not.toContain(result.feedToken);
  });

  it("is idempotent: an existing token is returned, never rotated", async () => {
    const { deps, txRepos } = makeMintDeps(EXISTING_TOKEN);

    const result = await getMyVolunteerIcsFeedToken(deps, {
      actorHumanId: HUMAN_ID,
    });

    expect(result).toEqual({ feedToken: EXISTING_TOKEN, minted: false });
    expect(
      (txRepos.volunteering as any).setVolunteerIcsFeedToken,
    ).not.toHaveBeenCalled();
    expect((txRepos.audit as any).log).not.toHaveBeenCalled();
  });

  it("losing a concurrent first-subscribe race returns the WINNER's token, not the dead losing candidate", async () => {
    const { deps, txRepos } = makeMintDeps(null);
    const WINNER_TOKEN = "winner-token-winner-token-winner-token-win";
    // Set-if-absent lost: someone else committed a token between our
    // pre-read (null) and our write.
    (txRepos.volunteering as any).setVolunteerIcsFeedToken.mockResolvedValue(
      false,
    );
    (txRepos.volunteering as any).getVolunteerIcsFeedToken
      .mockResolvedValueOnce(null) // initial get-or-mint read
      .mockResolvedValueOnce(WINNER_TOKEN); // post-lost-race re-read

    const result = await getMyVolunteerIcsFeedToken(deps, {
      actorHumanId: HUMAN_ID,
    });

    expect(result).toEqual({ feedToken: WINNER_TOKEN, minted: false });
    // The loser never audits a mint it didn't perform.
    expect((txRepos.audit as any).log).not.toHaveBeenCalled();
  });

  it("404s when the set-if-absent write lands zero rows and no token exists (no such human)", async () => {
    const { deps, txRepos } = makeMintDeps(null);
    (txRepos.volunteering as any).setVolunteerIcsFeedToken.mockResolvedValue(
      false,
    );
    // Both reads see no token — the human row doesn't exist.
    (txRepos.volunteering as any).getVolunteerIcsFeedToken.mockResolvedValue(
      null,
    );

    await expect(
      getMyVolunteerIcsFeedToken(deps, { actorHumanId: HUMAN_ID }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "human_not_found" });
    expect((txRepos.audit as any).log).not.toHaveBeenCalled();
  });
});

describe("rotateMyVolunteerIcsFeedToken", () => {
  it("unconditionally overwrites an existing token with a fresh one and audits the rotation", async () => {
    const { deps, txRepos } = makeMintDeps(EXISTING_TOKEN);

    const result = await rotateMyVolunteerIcsFeedToken(deps, {
      actorHumanId: HUMAN_ID,
    });

    // Fresh 32-byte base64url token — same format as the mint path —
    // and NEVER the previous token (rotation must break old URLs).
    expect(result.minted).toBe(true);
    expect(result.feedToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.feedToken).not.toBe(EXISTING_TOKEN);
    // The unconditional replace ran with the acting human's id; the
    // set-if-absent mint write is never involved.
    expect(
      (txRepos.volunteering as any).replaceVolunteerIcsFeedToken,
    ).toHaveBeenCalledWith(HUMAN_ID, result.feedToken);
    expect(
      (txRepos.volunteering as any).setVolunteerIcsFeedToken,
    ).not.toHaveBeenCalled();
    const auditCall = (txRepos.audit as any).log.mock.calls[0][0];
    expect(auditCall).toMatchObject({
      entity: "human",
      entityId: HUMAN_ID,
      action: "volunteer_ics_feed_token_rotated",
    });
    // Never log the bearer secret.
    expect(JSON.stringify(auditCall.data)).not.toContain(result.feedToken);
  });

  it("mints a token even when none existed (rotate-before-subscribe)", async () => {
    const { deps, txRepos } = makeMintDeps(null);

    const result = await rotateMyVolunteerIcsFeedToken(deps, {
      actorHumanId: HUMAN_ID,
    });

    expect(result.minted).toBe(true);
    expect(result.feedToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(
      (txRepos.volunteering as any).replaceVolunteerIcsFeedToken,
    ).toHaveBeenCalledWith(HUMAN_ID, result.feedToken);
  });

  it("consecutive rotations mint distinct tokens", async () => {
    const { deps } = makeMintDeps(EXISTING_TOKEN);

    const first = await rotateMyVolunteerIcsFeedToken(deps, {
      actorHumanId: HUMAN_ID,
    });
    const second = await rotateMyVolunteerIcsFeedToken(deps, {
      actorHumanId: HUMAN_ID,
    });

    expect(second.feedToken).not.toBe(first.feedToken);
  });

  it("404s when the unconditional write lands zero rows (no such human)", async () => {
    const { deps, txRepos } = makeMintDeps(null);
    (
      txRepos.volunteering as any
    ).replaceVolunteerIcsFeedToken.mockResolvedValue(false);

    await expect(
      rotateMyVolunteerIcsFeedToken(deps, { actorHumanId: HUMAN_ID }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "human_not_found" });
    expect((txRepos.audit as any).log).not.toHaveBeenCalled();
  });
});

describe("exportMyVolunteeringIcs", () => {
  it("returns a feed with mixed event-shift and ask-window rows", async () => {
    const { deps, volunteering } = makeFeedDeps();

    const result = await exportMyVolunteeringIcs(deps, {
      feedToken: EXISTING_TOKEN,
    });

    expect(volunteering.findHumanIdByIcsFeedToken).toHaveBeenCalledWith(
      EXISTING_TOKEN,
    );
    expect(volunteering.listUpcomingSignupsForFeed).toHaveBeenCalledWith(
      HUMAN_ID,
      NOW,
    );
    expect(result.filename).toBe("my-volunteering.ics");
    expect(result.icsBody).toContain("X-WR-CALNAME:My volunteering");
    // Event-shift row: shift window + venue + event URL.
    expect(result.icsBody).toContain(
      `UID:volunteer-signup-${SIGNUP_EVENT}@ithasfire.com`,
    );
    expect(result.icsBody).toContain("SUMMARY:Night Market — Door");
    expect(result.icsBody).toContain("DTSTART:20260802T000000Z");
    expect(result.icsBody).toContain("LOCATION:123 Main St\\, Somewhere");
    expect(result.icsBody).toContain(
      "URL:https://test.local/events/night-market",
    );
    // Ask-window row: ask title, no location/URL, default 2h DTEND.
    expect(result.icsBody).toContain(
      `UID:volunteer-signup-${SIGNUP_ASK}@ithasfire.com`,
    );
    expect(result.icsBody).toContain("SUMMARY:Standing bar crew — Bar");
    expect(result.icsBody).toContain("DTSTART:20260810T180000Z");
  });

  it("404s an unknown token with no hint", async () => {
    const { deps, volunteering } = makeFeedDeps({
      findHumanIdByIcsFeedToken: vi.fn(async () => null),
    });

    await expect(
      exportMyVolunteeringIcs(deps, { feedToken: "no-such-token-here" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(volunteering.listUpcomingSignupsForFeed).not.toHaveBeenCalled();
  });

  it("defensively drops non-accepted rows even if the adapter leaks them", async () => {
    const { deps } = makeFeedDeps({
      listUpcomingSignupsForFeed: vi.fn(async () => [
        eventRow,
        { ...askRow, signupId: SIGNUP_PENDING, status: "PENDING" },
      ]),
    });

    const result = await exportMyVolunteeringIcs(deps, {
      feedToken: EXISTING_TOKEN,
    });

    expect(result.icsBody).toContain(SIGNUP_EVENT);
    expect(result.icsBody).not.toContain(SIGNUP_PENDING);
  });

  it("produces an empty-but-valid calendar when nothing is upcoming", async () => {
    const { deps } = makeFeedDeps({
      listUpcomingSignupsForFeed: vi.fn(async () => []),
    });

    const result = await exportMyVolunteeringIcs(deps, {
      feedToken: EXISTING_TOKEN,
    });

    expect(result.icsBody).toContain("BEGIN:VCALENDAR");
    expect(result.icsBody).toContain("END:VCALENDAR");
    expect(result.icsBody).not.toContain("BEGIN:VEVENT");
  });
});

// ── LOCATION goes through the holder-address gate ───────────────────────────
//
// The feed used to print the Event row's `addressText` unconditionally. A
// volunteer gets what a ticket holder gets: no street before the reveal, none
// ever for NEVER, the Place's street for a venue that withholds its address.

describe("exportMyVolunteeringIcs — address gate", () => {
  const PLACE_ID = "00000000-0000-4000-8000-000000000007";
  const HOUR = 60 * 60 * 1000;

  /** Owned by VENUE_ORG; accepts community listings venue-wide. */
  const VENUE_ORG = "00000000-0000-4000-8000-0000000000e1";
  const withheldPlace = {
    id: PLACE_ID,
    orgIdsWithAccess: [VENUE_ORG],
    humanIdsWithAccess: [],
    acceptsCommunityListings: true,
    name: "The Blue Door House",
    formattedAddress: "901 Porter Rd",
    city: "Nashville",
    region: "TN",
    postalCode: "37206",
    lat: 36.1862,
    lng: -86.7291,
    locationMode: "OBSCURED",
    locationRadiusMeters: 800,
    locationLabel: "East Nashville",
  };

  async function feedFor(
    eventOverrides: Record<string, unknown>,
    place: unknown = null,
  ) {
    const event = {
      ...exactEvent,
      locality: "Nashville",
      region: "TN",
      ...eventOverrides,
    };
    const { deps } = makeFeedDeps(
      {},
      {
        events: { findManyByIds: vi.fn(async () => [event]) },
        places: { getById: vi.fn(async () => place) },
      },
    );
    return (await exportMyVolunteeringIcs(deps, { feedToken: EXISTING_TOKEN }))
      .icsBody;
  }

  it("NEVER: the coarse area, never the street", async () => {
    const ics = await feedFor({
      locationMode: "OBSCURED",
      addressRevealPreset: "NEVER",
      addressRevealAt: null,
    });
    expect(ics).toContain("LOCATION:Nashville\\, TN");
    expect(ics).not.toContain("123 Main St");
  });

  it("before the reveal: the coarse area, never the street", async () => {
    const ics = await feedFor({
      locationMode: "OBSCURED",
      addressRevealPreset: "DAY_BEFORE",
      addressRevealAt: new Date(NOW.getTime() + 24 * HOUR),
    });
    expect(ics).toContain("LOCATION:Nashville\\, TN");
    expect(ics).not.toContain("123 Main St");
  });

  it("after the reveal at a withheld venue: the Place's street, not the Event projection", async () => {
    const ics = await feedFor(
      {
        // The venue's own show.
        orgId: VENUE_ORG,
        stewardship: "OWNED",
        placeId: PLACE_ID,
        locationMode: "OBSCURED",
        locationRadiusMeters: 800,
        addressRevealPreset: "DAY_BEFORE",
        addressRevealAt: new Date(NOW.getTime() - HOUR),
        addressText: "East Nashville",
      },
      withheldPlace,
    );
    expect(ics).toContain("LOCATION:901 Porter Rd");
    expect(ics).not.toContain("LOCATION:East Nashville");
  });

  it("C1: a community listing at a house that accepts listings: the coarse area, never the street", async () => {
    const ics = await feedFor(
      {
        orgId: null,
        humanId: null,
        stewardship: "COMMUNITY",
        placeId: PLACE_ID,
        locationMode: "OBSCURED",
        locationRadiusMeters: 800,
        addressRevealPreset: "IMMEDIATELY",
        addressRevealAt: new Date(NOW.getTime() - HOUR),
        addressText: "East Nashville",
      },
      withheldPlace,
    );
    expect(ics).toContain("LOCATION:Nashville\\, TN");
    expect(ics).not.toContain("Porter");
  });

  it("an event that no longer resolves gets no LOCATION (fail closed)", async () => {
    const { deps } = makeFeedDeps(
      {},
      { events: { findManyByIds: vi.fn(async () => []) } },
    );
    const ics = (await exportMyVolunteeringIcs(deps, { feedToken: EXISTING_TOKEN }))
      .icsBody;
    expect(ics).not.toContain("LOCATION:");
  });
});
