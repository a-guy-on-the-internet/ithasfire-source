import { describe, expect, it, vi } from "vitest";

import type {
  HumanLineupRow,
  ListLineupsByHumanInput,
} from "@th/ports/repos/event-humans";

import { listMyLineups } from "../list-my-lineups";

const ME = "40000000-0000-4000-8000-000000000004";
const NOW = new Date("2026-09-30T12:00:00.000Z");

let seq = 0;
function lineup(
  startsAtIso: string,
  overrides: Partial<HumanLineupRow> = {},
): HumanLineupRow {
  seq += 1;
  const hex = seq.toString(16).padStart(12, "0");
  const startsAt = new Date(startsAtIso);
  return {
    eventHumanId: `a0000000-0000-4000-8000-${hex}`,
    eventId: `e0000000-0000-4000-8000-${hex}`,
    role: "PERFORMER",
    customRoleLabel: null,
    eventTitle: `Show ${seq}`,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 3 * 3600_000),
    timezone: "America/Chicago",
    status: "PUBLISHED",
    visibility: "PUBLIC",
    stewardship: "OWNED",
    slug: `show-${seq}`,
    orgName: "Acme Presents",
    ownerHumanName: null,
    ownerOrgId: "0a000000-0000-4000-8000-000000000001",
    ownerHumanId: null,
    ...overrides,
  };
}

const ACME_ORG = "0a000000-0000-4000-8000-000000000001";
const SOLO_ORG = "0d000000-0000-4000-8000-000000000004";
const BAND_ORG = "0e000000-0000-4000-8000-000000000005";
const SOMEONE_ELSE = "0f000000-0000-4000-8000-000000000006";

/**
 * Org members by org. Acme has an editor who is not ME; SOLO_ORG's only
 * editor is ME (its other member is a VIEWER, who is not told); BAND_ORG has
 * ME as OWNER plus another ADMIN.
 */
const MEMBERS: Record<string, Array<{ humanId: string; role: string }>> = {
  [ACME_ORG]: [{ humanId: SOMEONE_ELSE, role: "EDITOR" }],
  [SOLO_ORG]: [
    { humanId: ME, role: "OWNER" },
    { humanId: SOMEONE_ELSE, role: "VIEWER" },
  ],
  [BAND_ORG]: [
    { humanId: ME, role: "OWNER" },
    { humanId: SOMEONE_ELSE, role: "ADMIN" },
  ],
};

/**
 * The booking behind some shows: eventId → { agreement link, my act }. The
 * agreement is linked by `eventId` (finalized) unless `draft` is set.
 */
type Booked = {
  eventId: string;
  draft?: boolean;
  direction?: "TO_VENUE" | "TO_PERFORMER";
  act: { source: string; confirmation: string; actOwnerId?: string } | null;
};

/** In-memory twin of the adapter's keyset query. */
function fakeRepo(rows: HumanLineupRow[], booked: Booked[] = []) {
  const listLineupsByHuman = vi.fn(async (input: ListLineupsByHumanInput) => {
    const up = input.when === "upcoming";
    const dir = up ? 1 : -1;
    const cmp = (a: HumanLineupRow, b: { startsAt: Date; eventHumanId: string }) =>
      (a.startsAt.getTime() - b.startsAt.getTime()) * dir ||
      (a.eventHumanId < b.eventHumanId ? -1 : a.eventHumanId > b.eventHumanId ? 1 : 0) * dir;
    return rows
      .filter((r) =>
        up
          ? r.endsAt.getTime() > input.now.getTime()
          : r.endsAt.getTime() <= input.now.getTime(),
      )
      .filter((r) => !input.after || cmp(r, input.after) > 0)
      .sort((a, b) => cmp(a, b))
      .slice(0, input.limit);
  });
  return {
    eventHumans: { listLineupsByHuman },
    volunteering: { listSignupsByHuman: vi.fn(async () => [] as any[]) },
    organizations: {
      listMembers: vi.fn(async ({ orgId }: { orgId: string }) => {
        const items = MEMBERS[orgId] ?? [];
        return { items, total: items.length };
      }),
    },
    agreements: {
      findManyByLinkedEventIds: vi.fn(async (eventIds: readonly string[]) =>
        booked
          .filter((b) => eventIds.includes(b.eventId))
          .map((b) => ({
            id: `ag-${b.eventId}`,
            eventId: b.draft ? null : b.eventId,
            draftEventId: b.draft ? b.eventId : null,
          })),
      ),
    },
    bookingRequests: {
      findManyByAgreementIds: vi.fn(async (ids: readonly string[]) =>
        booked
          .filter((b) => ids.includes(`ag-${b.eventId}`))
          .map((b) => ({
            id: `br-${b.eventId}`,
            agreementId: `ag-${b.eventId}`,
            direction: b.direction ?? "TO_VENUE",
          })),
      ),
      listActsForRequests: vi.fn(async (ids: readonly string[]) =>
        booked
          .filter((b) => b.act && ids.includes(`br-${b.eventId}`))
          .map((b) => ({
            bookingRequestId: `br-${b.eventId}`,
            actOwnerType: "human",
            actOwnerId: b.act!.actOwnerId ?? ME,
            source: b.act!.source,
            confirmation: b.act!.confirmation,
          })),
      ),
    },
  };
}

const deps = (rows: HumanLineupRow[], booked: Booked[] = []) => ({
  repos: fakeRepo(rows, booked) as any,
  clock: { now: () => NOW },
});

describe("listMyLineups", () => {
  const past1 = lineup("2026-09-01T01:00:00.000Z", { status: "COMPLETED" });
  const past2 = lineup("2026-09-20T01:00:00.000Z");
  const draft = lineup("2026-10-10T01:00:00.000Z", {
    status: "DRAFT",
    slug: "draft-slug-must-not-leak",
    role: "OTHER",
    customRoleLabel: "Stage manager",
    orgName: null,
    ownerHumanName: "Sam Rivera",
    ownerOrgId: null,
    ownerHumanId: "0b000000-0000-4000-8000-000000000002",
  });
  const soon = lineup("2026-10-02T01:00:00.000Z", { role: "DJ" });
  const cancelled = lineup("2026-11-01T01:00:00.000Z", { status: "CANCELLED" });
  const all = [past1, past2, draft, soon, cancelled];

  it("lists upcoming first (soonest first), then past (most recent first), drafts included", async () => {
    const out = await listMyLineups(deps(all), { actorHumanId: ME });
    expect(out.items.map((i) => i.eventHumanId)).toEqual([
      soon.eventHumanId,
      draft.eventHumanId,
      cancelled.eventHumanId,
      past2.eventHumanId,
      past1.eventHumanId,
    ]);
    expect(out.nextCursor).toBeNull();
  });

  it("shapes each row for the page", async () => {
    const out = await listMyLineups(deps(all), { actorHumanId: ME });
    const d = out.items.find((i) => i.eventHumanId === draft.eventHumanId)!;
    expect(d).toEqual({
      eventHumanId: draft.eventHumanId,
      eventId: draft.eventId,
      eventTitle: draft.eventTitle,
      startsAt: draft.startsAt,
      endsAt: draft.endsAt,
      timezone: "America/Chicago",
      status: "DRAFT",
      visibility: "PUBLIC",
      role: "OTHER",
      customRoleLabel: "Stage manager",
      roleLabel: "Stage manager",
      organiserName: "Sam Rivera",
      organiserWillBeTold: true,
      hasVolunteerSignup: false,
      passesBookingAct: false,
      // A draft's slug leads nowhere public.
      slug: null,
      isPast: false,
    });
    const s = out.items.find((i) => i.eventHumanId === soon.eventHumanId)!;
    expect(s).toMatchObject({ roleLabel: "DJ", slug: soon.slug, organiserName: "Acme Presents" });
    const p = out.items.find((i) => i.eventHumanId === past1.eventHumanId)!;
    expect(p).toMatchObject({ isPast: true, slug: null });
  });

  it("pages across the upcoming → past boundary without dropping or repeating a row", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const out = await listMyLineups(deps(all), {
        actorHumanId: ME,
        limit: 2,
        cursor,
      });
      seen.push(...out.items.map((i) => i.eventHumanId));
      cursor = out.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(seen).toEqual([
      soon.eventHumanId,
      draft.eventHumanId,
      cancelled.eventHumanId,
      past2.eventHumanId,
      past1.eventHumanId,
    ]);
    expect(pages).toBe(3);
  });

  it("an upcoming page that exactly fills the limit still points at the past", async () => {
    const out = await listMyLineups(deps(all), { actorHumanId: ME, limit: 3 });
    expect(out.items).toHaveLength(3);
    expect(out.nextCursor).not.toBeNull();
    const next = await listMyLineups(deps(all), {
      actorHumanId: ME,
      limit: 3,
      cursor: out.nextCursor,
    });
    expect(next.items.map((i) => i.eventHumanId)).toEqual([
      past2.eventHumanId,
      past1.eventHumanId,
    ]);
    expect(next.nextCursor).toBeNull();
  });

  it("pins `now` in the cursor: an event ending between pages is not listed twice", async () => {
    // `soon` ends at 04:00Z on Oct 2. Page 1 is read before that, page 2
    // after; without the pin `soon` would move to the past phase and repeat.
    const clock = { now: vi.fn(() => NOW) };
    const repo = fakeRepo(all);
    const page1 = await listMyLineups(
      { repos: repo as any, clock },
      { actorHumanId: ME, limit: 1 },
    );
    expect(page1.items.map((i) => i.eventHumanId)).toEqual([soon.eventHumanId]);

    clock.now.mockReturnValue(new Date("2026-10-03T00:00:00.000Z"));
    const seen = [...page1.items.map((i) => i.eventHumanId)];
    let cursor = page1.nextCursor;
    while (cursor) {
      const page = await listMyLineups(
        { repos: repo as any, clock },
        { actorHumanId: ME, limit: 2, cursor },
      );
      seen.push(...page.items.map((i) => i.eventHumanId));
      cursor = page.nextCursor;
    }
    expect(seen).toEqual([
      soon.eventHumanId,
      draft.eventHumanId,
      cancelled.eventHumanId,
      past2.eventHumanId,
      past1.eventHumanId,
    ]);
    for (const [input] of repo.eventHumans.listLineupsByHuman.mock.calls) {
      expect(input.now).toEqual(NOW);
    }
  });

  it("scopes the query to the actor", async () => {
    const d = deps(all);
    await listMyLineups(d, { actorHumanId: ME });
    for (const [input] of d.repos.eventHumans.listLineupsByHuman.mock.calls) {
      expect(input.humanId).toBe(ME);
    }
  });

  it("rejects a forged cursor", async () => {
    await expect(
      listMyLineups(deps(all), { actorHumanId: ME, cursor: "not-a-cursor" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("hasVolunteerSignup: one batched signup read, true only for VOLUNTEER rows with a live signup", async () => {
    const withSignup = lineup("2026-10-20T01:00:00.000Z", { role: "VOLUNTEER" });
    const handAttached = lineup("2026-10-21T01:00:00.000Z", { role: "VOLUNTEER" });
    const withdrawn = lineup("2026-10-22T01:00:00.000Z", { role: "VOLUNTEER" });
    const performerWithSignup = lineup("2026-10-23T01:00:00.000Z");
    const d = deps([withSignup, handAttached, withdrawn, performerWithSignup]);
    d.repos.volunteering.listSignupsByHuman.mockResolvedValue([
      { id: "s1", eventId: withSignup.eventId, status: "APPROVED" },
      { id: "s2", eventId: withdrawn.eventId, status: "WITHDRAWN" },
      { id: "s3", eventId: performerWithSignup.eventId, status: "PENDING" },
    ]);
    const out = await listMyLineups(d, { actorHumanId: ME });
    const flag = (id: string) =>
      out.items.find((i) => i.eventHumanId === id)!.hasVolunteerSignup;
    expect(flag(withSignup.eventHumanId)).toBe(true);
    expect(flag(handAttached.eventHumanId)).toBe(false);
    expect(flag(withdrawn.eventHumanId)).toBe(false);
    expect(flag(performerWithSignup.eventHumanId)).toBe(false);
    expect(d.repos.volunteering.listSignupsByHuman).toHaveBeenCalledTimes(1);

    // No VOLUNTEER row on the page → no read at all.
    const d2 = deps([performerWithSignup]);
    await listMyLineups(d2, { actorHumanId: ME });
    expect(d2.repos.volunteering.listSignupsByHuman).not.toHaveBeenCalled();
  });

  it("organiserWillBeTold is explicit (not derived from organiserName)", async () => {
    const community = lineup("2026-10-20T01:00:00.000Z", {
      stewardship: "COMMUNITY",
      orgName: null,
      ownerOrgId: null,
      ownerHumanId: null,
    });
    const namelessOwner = lineup("2026-10-21T01:00:00.000Z", {
      orgName: null,
      ownerHumanName: null,
      ownerOrgId: null,
      ownerHumanId: "0c000000-0000-4000-8000-000000000003",
    });
    const myOwnEvent = lineup("2026-10-22T01:00:00.000Z", {
      orgName: null,
      ownerHumanName: "Me",
      ownerOrgId: null,
      ownerHumanId: ME,
    });
    const out = await listMyLineups(deps([community, namelessOwner, myOwnEvent]), {
      actorHumanId: ME,
    });
    const item = (id: string) => out.items.find((i) => i.eventHumanId === id)!;
    expect(item(community.eventHumanId)).toMatchObject({ organiserName: null, organiserWillBeTold: false });
    // organiserName is null here too — but someone WILL be told.
    expect(item(namelessOwner.eventHumanId)).toMatchObject({ organiserName: null, organiserWillBeTold: true });
    expect(item(myOwnEvent.eventHumanId)).toMatchObject({ organiserWillBeTold: false });
  });

  it("organiserWillBeTold is exact for org events: false when the caller is the org's ONLY editor", async () => {
    const acme = lineup("2026-10-23T01:00:00.000Z", { ownerOrgId: ACME_ORG });
    const acme2 = lineup("2026-10-24T01:00:00.000Z", { ownerOrgId: ACME_ORG });
    const solo = lineup("2026-10-25T01:00:00.000Z", { ownerOrgId: SOLO_ORG });
    const band = lineup("2026-10-26T01:00:00.000Z", { ownerOrgId: BAND_ORG });
    const personal = lineup("2026-10-27T01:00:00.000Z", {
      ownerOrgId: null,
      ownerHumanId: SOMEONE_ELSE,
    });
    const d = deps([acme, acme2, solo, band, personal]);
    const out = await listMyLineups(d, { actorHumanId: ME });
    const told = (id: string) =>
      out.items.find((i) => i.eventHumanId === id)!.organiserWillBeTold;

    expect(told(acme.eventHumanId)).toBe(true);
    expect(told(acme2.eventHumanId)).toBe(true);
    // ME is the only OWNER/ADMIN/EDITOR; a VIEWER is not a leave recipient.
    expect(told(solo.eventHumanId)).toBe(false);
    // ME edits it, but another admin hears.
    expect(told(band.eventHumanId)).toBe(true);
    expect(told(personal.eventHumanId)).toBe(true);

    // Batched: one membership read per DISTINCT org on the page (Acme twice
    // on the page → read once); none for the personal event.
    const read = d.repos.organizations.listMembers.mock.calls.map(
      ([arg]: [{ orgId: string }]) => arg.orgId,
    );
    expect([...read].sort()).toEqual([ACME_ORG, BAND_ORG, SOLO_ORG].sort());
  });

  it("passesBookingAct: true only for an UPCOMING live show where I am a tagged act that has not passed", async () => {
    const upcoming = lineup("2026-10-28T01:00:00.000Z");
    const upcomingDraftLink = lineup("2026-10-29T01:00:00.000Z", { status: "DRAFT" });
    const pendingAct = lineup("2026-10-30T01:00:00.000Z");
    const past = lineup("2026-09-02T01:00:00.000Z", { status: "COMPLETED" });
    const cancelled = lineup("2026-11-02T01:00:00.000Z", { status: "CANCELLED" });
    const archived = lineup("2026-11-03T01:00:00.000Z", { status: "ARCHIVED" });
    const passed = lineup("2026-11-04T01:00:00.000Z");
    const selfRow = lineup("2026-11-05T01:00:00.000Z");
    const someoneElsesAct = lineup("2026-11-06T01:00:00.000Z");
    const handAttached = lineup("2026-11-07T01:00:00.000Z");
    const toPerformer = lineup("2026-11-08T01:00:00.000Z");
    const notBooked = lineup("2026-11-09T01:00:00.000Z");
    const confirmed = { source: "TAGGED", confirmation: "CONFIRMED" };
    const d = deps(
      [upcoming, upcomingDraftLink, pendingAct, past, cancelled, archived, passed, selfRow, someoneElsesAct, handAttached, toPerformer, notBooked],
      [
        { eventId: upcoming.eventId, act: confirmed },
        { eventId: upcomingDraftLink.eventId, draft: true, act: confirmed },
        { eventId: pendingAct.eventId, act: { source: "TAGGED", confirmation: "PENDING" } },
        { eventId: past.eventId, act: confirmed },
        { eventId: cancelled.eventId, act: confirmed },
        { eventId: archived.eventId, act: confirmed },
        { eventId: passed.eventId, act: { source: "TAGGED", confirmation: "DECLINED" } },
        { eventId: selfRow.eventId, act: { source: "SELF", confirmation: "CONFIRMED" } },
        { eventId: someoneElsesAct.eventId, act: { ...confirmed, actOwnerId: SOMEONE_ELSE } },
        { eventId: handAttached.eventId, act: null },
        { eventId: toPerformer.eventId, direction: "TO_PERFORMER", act: confirmed },
      ],
    );
    const out = await listMyLineups(d, { actorHumanId: ME, limit: 50 });
    const passes = (row: HumanLineupRow) =>
      out.items.find((i) => i.eventHumanId === row.eventHumanId)!.passesBookingAct;

    expect(passes(upcoming)).toBe(true);
    expect(passes(upcomingDraftLink)).toBe(true);
    expect(passes(pendingAct)).toBe(true);
    // Owner ruling: past / cancelled / archived = lineup credit only.
    expect(passes(past)).toBe(false);
    expect(passes(cancelled)).toBe(false);
    expect(passes(archived)).toBe(false);
    for (const row of [passed, selfRow, someoneElsesAct, handAttached, toPerformer, notBooked]) {
      expect(passes(row)).toBe(false);
    }

    // Batched: ONE read each for the whole page; past/dead shows never asked.
    expect(d.repos.agreements.findManyByLinkedEventIds).toHaveBeenCalledTimes(1);
    const asked = d.repos.agreements.findManyByLinkedEventIds.mock.calls[0][0] as string[];
    expect(asked).not.toContain(past.eventId);
    expect(asked).not.toContain(cancelled.eventId);
    expect(asked).not.toContain(archived.eventId);
    expect(d.repos.bookingRequests.findManyByAgreementIds).toHaveBeenCalledTimes(1);
    expect(d.repos.bookingRequests.listActsForRequests).toHaveBeenCalledTimes(1);
  });

  it("passesBookingAct costs no reads when no upcoming live show is on the page", async () => {
    const d = deps([lineup("2026-09-03T01:00:00.000Z", { status: "COMPLETED" })]);
    await listMyLineups(d, { actorHumanId: ME });
    expect(d.repos.agreements.findManyByLinkedEventIds).not.toHaveBeenCalled();
  });

  it("caps the per-org membership reads at 5 in flight", async () => {
    const orgs = Array.from({ length: 12 }, (_, i) => `0a000000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`);
    const rows = orgs.map((orgId, i) =>
      lineup(`2026-12-${String(i + 1).padStart(2, "0")}T01:00:00.000Z`, { ownerOrgId: orgId }),
    );
    const d = deps(rows);
    let inFlight = 0;
    let peak = 0;
    d.repos.organizations.listMembers.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return { items: [], total: 0 };
    });
    await listMyLineups(d, { actorHumanId: ME, limit: 50 });
    expect(d.repos.organizations.listMembers).toHaveBeenCalledTimes(12);
    expect(peak).toBeLessThanOrEqual(5);
    expect(peak).toBeGreaterThan(1);
  });

  it("returns an empty page for someone on no lineup", async () => {
    const d = deps([]);
    const out = await listMyLineups(d, { actorHumanId: ME });
    expect(out).toEqual({ items: [], nextCursor: null });
    expect(d.repos.organizations.listMembers).not.toHaveBeenCalled();
  });
});
