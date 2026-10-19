import { describe, expect, it, vi } from "vitest";

import type { AgreementRecord } from "@th/ports/repos/agreements";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import type { EventRecord } from "@th/ports/repos/events";

import {
  declineBookingRequestAct,
  joinBookingRequestAct,
  passBookingRequestAct,
  confirmBookingRequestAct,
  type AnswerBookingRequestActDeps,
} from "../answer-booking-request-act";
import { getBookingRequestActInvite } from "../get-booking-request-act-invite";
import { listBookingRequestMessages } from "../messages/list-messages";
import type { ListBookingRequestMessagesDeps } from "../messages/list-messages";
import { listBookingLineupSuggestions } from "../../event-humans/list-booking-lineup-suggestions";
import type { ListBookingLineupSuggestionsDeps } from "../../event-humans/list-booking-lineup-suggestions";
import {
  ACTOR_ID,
  AGREEMENT_ID,
  EVENT_ID,
  NOW,
  PLACE_ID,
  REQUEST_ID,
  buildAgreementRecord,
  buildBookingRequestRecord,
  buildPlaceRecord,
  buildStageEventRecord,
  ledgerOf,
  systemEntriesFor,
  withTx,
} from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// A tagged GROUP on a bill (lineup-booking-requests v3, L17 / L14 / L19 /
// FR-003 / FR-008 / FR-013): answered by its editors, read by its editors,
// suggested to the event editor by orgId — plus the consent invariants
// (NFR-002) the v3 changes touch: positions never reveal a hidden act, and a
// pass never reaches the venue.
//
// ACTOR_ID is the SENDER (a human). GROUP_ID is the tagged band; EDITOR_ID
// edits it (ADMIN), VIEWER_ID is only a VIEWER member, STRANGER_ID is nobody.
// ─────────────────────────────────────────────────────────────────────────────

const GROUP_ID = "6a6a6a6a-6a6a-46a6-86a6-6a6a6a6a6a6a";
const SECOND_GROUP_ID = "6b6b6b6b-6b6b-46b6-86b6-6b6b6b6b6b6b";
const EDITOR_ID = "e1e1e1e1-0000-4000-8000-000000000001";
const VIEWER_ID = "e1e1e1e1-0000-4000-8000-000000000002";
const STRANGER_ID = "e1e1e1e1-0000-4000-8000-000000000003";
const PENDING_ARTIST_ID = "e1e1e1e1-0000-4000-8000-000000000004";
const PASSED_ARTIST_ID = "e1e1e1e1-0000-4000-8000-000000000005";
const VENUE_OWNER_ID = "13131313-1313-4131-8131-131313131313";
const VENUE_ORG_ID = "19191919-1919-4191-8191-191919191919";

const MEMBERSHIPS: Record<string, string> = {
  [`${GROUP_ID}:${EDITOR_ID}`]: "ADMIN",
  [`${GROUP_ID}:${VIEWER_ID}`]: "VIEWER",
  [`${SECOND_GROUP_ID}:${EDITOR_ID}`]: "EDITOR",
  [`${VENUE_ORG_ID}:${VENUE_OWNER_ID}`]: "ADMIN",
};

type BuildOptions = {
  request?: BookingRequestRecord;
  agreement?: AgreementRecord | null;
  events?: EventRecord[];
};

function buildDeps(options: BuildOptions = {}) {
  const request = options.request ?? buildBookingRequestRecord();
  const agreement = options.agreement ?? null;
  const events = options.events ?? [];

  const bookingRequests = {
    getById: vi.fn(async (id: string) => (id === request.id ? request : null)),
    findByAgreementId: vi.fn(async (id: string) =>
      request.agreementId === id ? request : null,
    ),
  };
  const lineup: Array<{
    id: string;
    eventId: string;
    humanId: string | null;
    orgId: string | null;
  }> = [];
  const authz = {
    getOrgMembership: vi.fn(
      async ({ orgId, humanId }: { orgId: string; humanId: string }) => {
        const role = MEMBERSHIPS[`${orgId}:${humanId}`];
        return role ? { orgId, humanId, role } : null;
      },
    ),
    getOrgMemberships: vi.fn(
      async ({ orgIds, humanId }: { orgIds: string[]; humanId: string }) =>
        orgIds
          .map((orgId) => ({ orgId, humanId, role: MEMBERSHIPS[`${orgId}:${humanId}`] }))
          .filter((membership) => membership.role),
    ),
    getPlaceAccessContext: vi.fn(async () => ({
      owningOrgIds: [],
      verifiedHumanOwnerIds: [VENUE_OWNER_ID],
    })),
  };
  const place = buildPlaceRecord({ humanIdsWithAccess: [VENUE_OWNER_ID] });

  const repos = withTx({
    bookingRequests,
    agreements: {
      getById: vi.fn(async (id: string) => (agreement?.id === id ? agreement : null)),
      findByLinkedEventId: vi.fn(async (eventId: string) =>
        agreement && (agreement.eventId === eventId || agreement.draftEventId === eventId)
          ? agreement
          : null,
      ),
    },
    events: {
      getById: vi.fn(async (id: string) => events.find((event) => event.id === id) ?? null),
    },
    eventHumans: {
      listByEvent: vi.fn(async (eventId: string) =>
        lineup.filter((row) => row.eventId === eventId),
      ),
    },
    humans: {
      getByIds: vi.fn(async (ids: string[]) =>
        ids.map((id) => ({
          id,
          name:
            id === ACTOR_ID
              ? "Sam Sender"
              : id === PENDING_ARTIST_ID
                ? "Pending Pat"
                : id === PASSED_ARTIST_ID
                  ? "Passed Paz"
                  : "Someone",
          status: "ACTIVE",
        })),
      ),
    },
    organizations: {
      getByIds: vi.fn(async (ids: string[]) =>
        ids.map((id) => ({
          id,
          name: id === GROUP_ID ? "Paper Moth" : id === SECOND_GROUP_ID ? "Junco" : "Org",
          status: "ACTIVE",
        })),
      ),
    },
    entityPages: {
      getByOwners: vi.fn(async (ownerType: string, ids: string[]) =>
        ownerType === "ORGANIZATION" && ids.includes(GROUP_ID)
          ? [
              {
                id: "page-moth",
                ownerType,
                ownerId: GROUP_ID,
                slug: "paper-moth",
                displayName: null,
                visibility: "PUBLIC",
              },
            ]
          : [],
      ),
      getByOwner: vi.fn(async () => null),
    },
    audit: { log: vi.fn(async () => {}) },
    places: { getById: vi.fn(async (id: string) => (id === PLACE_ID ? place : null)) },
    authz,
  });

  const deps = {
    repos: repos as unknown as AnswerBookingRequestActDeps["repos"],
    clock: { now: () => NOW },
  } satisfies AnswerBookingRequestActDeps;
  const acts = repos.bookingRequests as unknown as AnswerBookingRequestActDeps["repos"]["bookingRequests"];

  return {
    deps,
    repos,
    acts,
    /** Model the mint / the editor putting a row on the event lineup. */
    putOnLineup: (row: { humanId?: string; orgId?: string }) => {
      lineup.push({
        id: crypto.randomUUID(),
        eventId: EVENT_ID,
        humanId: row.humanId ?? null,
        orgId: row.orgId ?? null,
      });
    },
  };
}

/** SELF, a pending artist, the GROUP, a passed artist, free text. */
async function seedBill(acts: AnswerBookingRequestActDeps["repos"]["bookingRequests"]) {
  await acts.addActs(REQUEST_ID, [
    { source: "SELF", sortOrder: 0 },
    { source: "TAGGED", actOwnerType: "human", actOwnerId: PENDING_ARTIST_ID, sortOrder: 1 },
    {
      source: "TAGGED",
      actOwnerType: "organization",
      actOwnerId: GROUP_ID,
      sortOrder: 2,
      role: "OTHER",
      customRoleLabel: "Backing band",
    },
    { source: "TAGGED", actOwnerType: "human", actOwnerId: PASSED_ARTIST_ID, sortOrder: 3 },
    { source: "EXTERNAL", externalName: "The Weeds", sortOrder: 4 },
  ]);
  await acts.setActConfirmation({
    bookingRequestId: REQUEST_ID,
    actOwnerType: "human",
    actOwnerId: PASSED_ARTIST_ID,
    expectedFrom: "PENDING",
    to: "DECLINED",
    respondedAt: NOW,
  });
}

const groupAct = (acts: AnswerBookingRequestActDeps["repos"]["bookingRequests"]) =>
  acts.getActForOwner({
    bookingRequestId: REQUEST_ID,
    actOwnerType: "organization",
    actOwnerId: GROUP_ID,
  });

const asEditor = (overrides: Record<string, unknown> = {}) => ({
  actorHumanId: EDITOR_ID,
  bookingRequestId: REQUEST_ID,
  asOrgId: GROUP_ID,
  ...overrides,
});

/**
 * An accepted request whose agreement anchors a LIVE draft event that has
 * already STARTED — so a join attaches nothing by itself (v3 FR-010 late
 * join only lands on an upcoming event; that path has its own suite,
 * `answer-booking-request-act-late-join.test.ts`) and these tests put the
 * group on the lineup by hand, the way the mint or the editor does.
 */
const STARTED_AT = new Date("2026-06-01T00:00:00.000Z");
function minted() {
  return {
    request: buildBookingRequestRecord({ status: "ACCEPTED", agreementId: AGREEMENT_ID }),
    agreement: buildAgreementRecord({ draftEventId: EVENT_ID }),
    events: [
      buildStageEventRecord({
        id: EVENT_ID,
        status: "DRAFT",
        startsAt: STARTED_AT,
      }) as EventRecord,
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Answering (FR-003, L14, L17, L19)
// ─────────────────────────────────────────────────────────────────────────────

describe("joinAct / passAct — the v3 names", () => {
  it("are the same functions as the v2 confirm / decline", () => {
    expect(joinBookingRequestAct).toBe(confirmBookingRequestAct);
    expect(passBookingRequestAct).toBe(declineBookingRequestAct);
  });
});

describe("a tagged GROUP is answered by its editors (v3 L17)", () => {
  it("an editor joins AS the group: the group's row goes CONFIRMED; the ledger names the group and is authored by the editor", async () => {
    const { deps, repos, acts } = buildDeps();
    await seedBill(acts);

    const result = await joinBookingRequestAct(deps, asEditor());

    expect(result).toMatchObject({ confirmation: "CONFIRMED", changed: true });
    expect(await groupAct(acts)).toMatchObject({ confirmation: "CONFIRMED", respondedAt: NOW });
    expect(systemEntriesFor(repos, REQUEST_ID)).toEqual([
      expect.objectContaining({
        systemKind: "booking_request.act_confirmed",
        systemData: { actId: result.actId, actName: "Paper Moth" },
        authorHumanId: EDITOR_ID,
      }),
    ]);
  });

  it("a VIEWER member, a stranger, and an editor of ANOTHER group all get the same not-found — nothing written", async () => {
    const { deps, repos, acts } = buildDeps();
    await seedBill(acts);

    for (const attempt of [
      asEditor({ actorHumanId: VIEWER_ID }),
      asEditor({ actorHumanId: STRANGER_ID }),
      // EDITOR edits SECOND_GROUP, which is not on this bill.
      asEditor({ asOrgId: SECOND_GROUP_ID }),
    ]) {
      await expect(joinBookingRequestAct(deps, attempt)).rejects.toMatchObject({
        code: "BOOKING_REQUEST_NOT_FOUND",
      });
    }
    expect(await groupAct(acts)).toMatchObject({ confirmation: "PENDING" });
    expect(systemEntriesFor(repos, REQUEST_ID)).toEqual([]);
  });

  it("without asOrgId the editor answers only as THEMSELVES — the group's spot is not theirs to take implicitly", async () => {
    const { deps, acts } = buildDeps();
    await seedBill(acts);

    await expect(
      joinBookingRequestAct(deps, { actorHumanId: EDITOR_ID, bookingRequestId: REQUEST_ID }),
    ).rejects.toMatchObject({ code: "BOOKING_REQUEST_NOT_FOUND" });
    expect(await groupAct(acts)).toMatchObject({ confirmation: "PENDING" });
  });

  it("a pass carries its reason onto the SENDER-ONLY ledger entry (L19) and is final", async () => {
    const { deps, repos, acts } = buildDeps();
    await seedBill(acts);

    const result = await passBookingRequestAct(
      deps,
      asEditor({ declineReason: "  We're <i>touring</i> that week " }),
    );

    expect(result).toMatchObject({ confirmation: "DECLINED", changed: true });
    expect(await groupAct(acts)).toMatchObject({ declineReason: "We're touring that week" });
    expect(systemEntriesFor(repos, REQUEST_ID)).toEqual([
      expect.objectContaining({
        systemKind: "booking_request.act_declined",
        systemData: {
          actId: result.actId,
          actName: "Paper Moth",
          reason: "We're touring that week",
        },
      }),
    ]);
    // Final: "Count me in" after a pass is refused.
    await expect(joinBookingRequestAct(deps, asEditor())).rejects.toMatchObject({
      code: "ACT_ALREADY_DECLINED",
    });
  });

  it("joined, then LEAVES before the night is booked: allowed, recorded as a pass with `left: true` — and final", async () => {
    const { deps, repos, acts } = buildDeps();
    await seedBill(acts);
    await joinBookingRequestAct(deps, asEditor());

    const left = await passBookingRequestAct(deps, asEditor({ declineReason: "Lost our drummer" }));

    expect(left).toMatchObject({ confirmation: "DECLINED", changed: true });
    const entries = systemEntriesFor(repos, REQUEST_ID);
    expect(entries.at(-1)).toMatchObject({
      systemKind: "booking_request.act_declined",
      systemData: { actId: left.actId, actName: "Paper Moth", reason: "Lost our drummer", left: true },
    });
    await expect(joinBookingRequestAct(deps, asEditor())).rejects.toMatchObject({
      code: "ACT_ALREADY_DECLINED",
    });
  });

  it("once the night is booked and the GROUP is on the lineup (by orgId), leaving is refused with on_lineup", async () => {
    const { deps, acts, putOnLineup } = buildDeps(minted());
    await seedBill(acts);
    await joinBookingRequestAct(deps, asEditor());
    putOnLineup({ orgId: GROUP_ID });

    await expect(passBookingRequestAct(deps, asEditor())).rejects.toMatchObject({
      code: "INVALID_STATUS",
      meta: { reason: "on_lineup" },
    });
    expect(await groupAct(acts)).toMatchObject({ confirmation: "CONFIRMED" });
  });

  it("the editor on the lineup as a PERSON does not block the GROUP leaving — only the group's own orgId row does", async () => {
    const { deps, acts, putOnLineup } = buildDeps(minted());
    await seedBill(acts);
    await joinBookingRequestAct(deps, asEditor());
    // The editor HIMSELF is on the lineup as a person — not the group.
    putOnLineup({ humanId: EDITOR_ID });

    await expect(passBookingRequestAct(deps, asEditor())).resolves.toMatchObject({
      confirmation: "DECLINED",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The invite read (FR-013)
// ─────────────────────────────────────────────────────────────────────────────

describe("getBookingRequestActInvite — groups and positions (v3 FR-013)", () => {
  it("an editor reads the GROUP's invite: answering as the group, its role + label, positions dense among what they see, no total", async () => {
    const { deps, acts } = buildDeps();
    await seedBill(acts);

    const invite = await getBookingRequestActInvite(deps, {
      actorHumanId: EDITOR_ID,
      bookingRequestId: REQUEST_ID,
    });

    expect(invite.answeringAs).toEqual({
      ownerType: "organization",
      ownerId: GROUP_ID,
      displayName: "Paper Moth",
      href: "/orgs/paper-moth",
    });
    // Stored order: SELF 0, pending 1, GROUP 2, passed 3, free text 4. The
    // editor sees SELF, their group and the free text: 0, 1, 2 — never "3rd"
    // (which would reveal the hidden invited act ahead of them).
    expect(invite.myAct).toMatchObject({
      confirmation: "PENDING",
      role: "OTHER",
      customRoleLabel: "Backing band",
      sortOrder: 1,
    });
    expect(invite.otherActs.map((act) => [act.source, act.displayName, act.sortOrder])).toEqual([
      ["SELF", "Sam Sender", 0],
      ["EXTERNAL", "The Weeds", 2],
    ]);
    // Neither the invited nor the passed artist is named, and no count of
    // the bill rides along.
    const wire = JSON.stringify(invite);
    expect(wire).not.toContain("Pending Pat");
    expect(wire).not.toContain("Passed Paz");
    expect(wire).not.toContain(PENDING_ARTIST_ID);
    expect(wire).not.toMatch(/total|count/i);
    expect(invite).toMatchObject({ canConfirm: true, canDecline: true });
    expect(invite.identities).toHaveLength(1);
  });

  it("a viewer who answers for several identities gets all of them, each saying which is which — themselves first", async () => {
    const { deps, acts } = buildDeps();
    await acts.addActs(REQUEST_ID, [
      { source: "SELF", sortOrder: 0 },
      { source: "TAGGED", actOwnerType: "organization", actOwnerId: SECOND_GROUP_ID, sortOrder: 1 },
      { source: "TAGGED", actOwnerType: "organization", actOwnerId: GROUP_ID, sortOrder: 2 },
      { source: "TAGGED", actOwnerType: "human", actOwnerId: EDITOR_ID, sortOrder: 3, role: "DJ" },
    ]);
    // They already joined as SECOND_GROUP.
    await joinBookingRequestAct(deps, asEditor({ asOrgId: SECOND_GROUP_ID }));

    const invite = await getBookingRequestActInvite(deps, {
      actorHumanId: EDITOR_ID,
      bookingRequestId: REQUEST_ID,
    });

    expect(
      invite.identities.map((spot) => [
        spot.answeringAs.ownerType,
        spot.answeringAs.ownerId,
        spot.myAct.confirmation,
        spot.myAct.sortOrder,
        spot.canConfirm,
      ]),
    ).toEqual([
      ["human", EDITOR_ID, "PENDING", 3, true],
      ["organization", SECOND_GROUP_ID, "CONFIRMED", 1, false],
      ["organization", GROUP_ID, "PENDING", 2, true],
    ]);
    // The top-level fields mirror the primary spot (the person).
    expect(invite.answeringAs.ownerId).toBe(EDITOR_ID);
    expect(invite.myAct).toMatchObject({ role: "DJ", sortOrder: 3 });
    expect(invite.otherActs.map((act) => act.source)).toEqual(["SELF"]);
  });

  it("a VIEWER member of the group and a stranger get not-found", async () => {
    const { deps, acts } = buildDeps();
    await seedBill(acts);
    for (const actorHumanId of [VIEWER_ID, STRANGER_ID]) {
      await expect(
        getBookingRequestActInvite(deps, { actorHumanId, bookingRequestId: REQUEST_ID }),
      ).rejects.toMatchObject({ code: "BOOKING_REQUEST_NOT_FOUND" });
    }
  });

  it("after the night is booked with the group on the lineup, leaving shows on_lineup", async () => {
    const { deps, acts, putOnLineup } = buildDeps(minted());
    await seedBill(acts);
    await joinBookingRequestAct(deps, asEditor());
    putOnLineup({ orgId: GROUP_ID });

    await expect(
      getBookingRequestActInvite(deps, { actorHumanId: EDITOR_ID, bookingRequestId: REQUEST_ID }),
    ).resolves.toMatchObject({
      eventMinted: true,
      canDecline: false,
      declineBlockedReason: "on_lineup",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The thread, ACT side (FR-008 for groups) + its history (removed acts)
// ─────────────────────────────────────────────────────────────────────────────

describe("thread ACT side for a tagged group", () => {
  const listAs = (
    repos: unknown,
    actorHumanId: string,
    side: "ACT" | "VENUE" = "ACT",
  ) =>
    listBookingRequestMessages(
      { repos: repos as ListBookingRequestMessagesDeps["repos"] },
      { actorHumanId, bookingRequestId: REQUEST_ID, side },
    );

  it("an editor of a JOINED group reads it; before the group joins, and as a VIEWER member, they cannot", async () => {
    const { deps, repos, acts } = buildDeps();
    await seedBill(acts);

    await expect(listAs(repos, EDITOR_ID)).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });

    await joinBookingRequestAct(deps, asEditor());

    await expect(listAs(repos, EDITOR_ID)).resolves.toMatchObject({
      items: [expect.objectContaining({ systemKind: "booking_request.act_confirmed" })],
    });
    await expect(listAs(repos, VIEWER_ID)).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    await expect(listAs(repos, STRANGER_ID)).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("a group that joined and was later REMOVED keeps its 'joined' line for the venue (true history) but reads nothing any more", async () => {
    const { deps, repos, acts } = buildDeps();
    await seedBill(acts);
    const joined = await joinBookingRequestAct(deps, asEditor());
    await acts.softRemoveAct({ bookingRequestId: REQUEST_ID, actId: joined.actId, at: NOW });

    const venue = await listAs(repos, VENUE_OWNER_ID, "VENUE");
    expect(venue.items.map((row) => row.systemKind)).toEqual(["booking_request.act_confirmed"]);
    // Off the bill → off the ACT side.
    await expect(listAs(repos, EDITOR_ID)).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("restored and re-joined: the venue reads ONE 'joined' line — the latest", async () => {
    const { deps, repos, acts } = buildDeps();
    await seedBill(acts);
    const first = await joinBookingRequestAct(deps, asEditor());
    await acts.softRemoveAct({ bookingRequestId: REQUEST_ID, actId: first.actId, at: NOW });
    await acts.restoreAct({ bookingRequestId: REQUEST_ID, actId: first.actId, sortOrder: 2, invitedAt: NOW });
    await joinBookingRequestAct(deps, asEditor());

    const all = [...ledgerOf(repos).rows.values()].filter(
      (row) => row.systemKind === "booking_request.act_confirmed",
    );
    expect(all).toHaveLength(2);
    expect(all.map((row) => row.systemData?.actId)).toEqual([first.actId, first.actId]);

    const venue = await listAs(repos, VENUE_OWNER_ID, "VENUE");
    const lines = venue.items.filter((row) => row.systemKind === "booking_request.act_confirmed");
    expect(lines.map((row) => row.id)).toEqual([all[1]!.id]);
  });

  it("a group that joined and then LEFT: its 'joined' line is gone from the venue's thread (FR-004)", async () => {
    const { deps, repos, acts } = buildDeps();
    await seedBill(acts);
    const joined = await joinBookingRequestAct(deps, asEditor());
    await passBookingRequestAct(deps, asEditor());

    const venue = await listAs(repos, VENUE_OWNER_ID, "VENUE");
    expect(venue.items).toEqual([]);
    expect(JSON.stringify(venue)).not.toContain(joined.actId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suggestions on the event's lineup step (FR-006 / L18)
// ─────────────────────────────────────────────────────────────────────────────

describe("listBookingLineupSuggestions — groups (v3 L18)", () => {
  const suggestionsFor = (repos: unknown) =>
    listBookingLineupSuggestions(
      {
        repos: repos as ListBookingLineupSuggestionsDeps["repos"],
        authz: { hasStaffRole: vi.fn(async () => ({ allowed: false })) },
      },
      { actorHumanId: VENUE_OWNER_ID, eventId: EVENT_ID },
    );

  const ownedByVenue = () => {
    const fixture = minted();
    return {
      ...fixture,
      events: [
        buildStageEventRecord({
          id: EVENT_ID,
          status: "DRAFT",
          orgId: VENUE_ORG_ID,
          stewardship: "OWNED",
        } as Partial<EventRecord> & { id: string }) as EventRecord,
      ],
    };
  };

  it("suggests an invited or joined GROUP by orgId (with its label), never a passed act", async () => {
    const { repos, acts } = buildDeps(ownedByVenue());
    await seedBill(acts);

    const result = await suggestionsFor(repos);

    expect(result.suggestions.map((s) => [s.humanId, s.orgId, s.confirmation])).toEqual([
      [PENDING_ARTIST_ID, null, "PENDING"],
      [null, GROUP_ID, "PENDING"],
    ]);
    expect(result.suggestions[1]).toMatchObject({
      displayName: "Paper Moth",
      href: "/orgs/paper-moth",
      role: "OTHER",
      customRoleLabel: "Backing band",
    });
  });

  it("a group already on the lineup (same orgId) is not suggested again", async () => {
    const { repos, acts, putOnLineup } = buildDeps(ownedByVenue());
    await seedBill(acts);
    putOnLineup({ orgId: GROUP_ID });

    const result = await suggestionsFor(repos);
    expect(result.suggestions.map((s) => s.orgId)).toEqual([null]);
  });
});
