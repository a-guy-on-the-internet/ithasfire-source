import { describe, expect, it } from "vitest";

import { createFakePlaceBookingGrantsRepo } from "../place-booking-grants";

// The fake must answer as the adapter does (place-booking-grants.ts and
// test/integration/holds-without-a-request.test.ts), or core suites pass
// against rules production does not have.

const PLACE = "33333333-3333-4333-8333-333333333333";
const OTHER_PLACE = "34343434-3434-4343-8343-343434343434";
const CAL_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CAL_B = "cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd";
const HUMAN = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const OWNER = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-10-15T12:00:00.000Z");

describe("createFakePlaceBookingGrantsRepo", () => {
  it("seeds are accepted by default; create is pending and grants nothing until accepted", async () => {
    const repo = createFakePlaceBookingGrantsRepo();
    const seeded = repo.seed({ placeId: PLACE, humanId: HUMAN });
    expect(seeded.acceptedAt).toEqual(seeded.createdAt);
    expect(seeded.grantee).toEqual({ kind: "person", humanId: HUMAN });

    const repo2 = createFakePlaceBookingGrantsRepo();
    const created = await repo2.create({
      placeId: PLACE,
      grantee: { kind: "org", orgId: ORG },
      grantedByHumanId: OWNER,
    });
    expect(created).toMatchObject({ acceptedAt: null });
    // H3: one grant means all of it — the record carries no capability flags.
    expect(created).not.toHaveProperty("canPlaceHolds");
    expect(created).not.toHaveProperty("canCreateEvents");
    const actor = { placeId: PLACE, humanIds: [], orgIds: [ORG], now: NOW };
    expect(await repo2.findActiveForActor(actor)).toBeNull();
    await repo2.accept({ id: created.id, humanIds: [], orgIds: [ORG], now: NOW });
    expect((await repo2.findActiveForActor(actor))?.id).toBe(created.id);
  });

  it("accept / decline only from pending; a missing id is not_found", async () => {
    const repo = createFakePlaceBookingGrantsRepo();
    const me = { humanIds: [HUMAN], orgIds: [], now: NOW };
    const g = await repo.create({ placeId: PLACE, grantee: { kind: "person", humanId: HUMAN }, grantedByHumanId: OWNER });
    await repo.decline({ id: g.id, ...me });
    await expect(repo.accept({ id: g.id, ...me })).rejects.toMatchObject({ message: "place_booking_grant_not_pending" });
    await expect(repo.decline({ id: "nope", ...me })).rejects.toMatchObject({ code: "not_found" });
  });

  it("accept / decline refuse a pending grant past its expiry at `now` (not_pending) and leave it pending", async () => {
    const repo = createFakePlaceBookingGrantsRepo();
    const me = { humanIds: [HUMAN], orgIds: [], now: NOW };
    const lapsed = repo.seed({ placeId: PLACE, humanId: HUMAN, acceptedAt: null, expiresAt: NOW });
    await expect(repo.accept({ id: lapsed.id, ...me })).rejects.toMatchObject({
      message: "place_booking_grant_not_pending",
    });
    await expect(repo.decline({ id: lapsed.id, ...me })).rejects.toMatchObject({
      message: "place_booking_grant_not_pending",
    });
    expect(repo.rows.get(lapsed.id)).toMatchObject({ acceptedAt: null, declinedAt: null });
    const later = repo.seed({
      placeId: PLACE,
      humanId: HUMAN,
      acceptedAt: null,
      expiresAt: new Date(NOW.getTime() + 1),
    });
    expect((await repo.accept({ id: later.id, ...me })).acceptedAt).toEqual(NOW);
  });

  it("accept / decline are grantee-scoped: another person's or org's grant is not_found and stays pending", async () => {
    const repo = createFakePlaceBookingGrantsRepo();
    const STRANGER = "55555555-5555-4555-8555-555555555555";
    const OTHER_ORG = "66666666-6666-4666-8666-666666666666";
    const personGrant = await repo.create({ placeId: PLACE, grantee: { kind: "person", humanId: HUMAN }, grantedByHumanId: OWNER });
    const orgGrant = await repo.create({ placeId: PLACE, grantee: { kind: "org", orgId: ORG }, grantedByHumanId: OWNER });
    for (const who of [
      { humanIds: [STRANGER], orgIds: [] },
      { humanIds: [STRANGER], orgIds: [OTHER_ORG] },
      { humanIds: [], orgIds: [] },
      // Sets are typed: an org id among the people does not answer its grant.
      { humanIds: [ORG], orgIds: [] },
    ]) {
      for (const id of [personGrant.id, orgGrant.id]) {
        await expect(repo.accept({ id, ...who, now: NOW })).rejects.toMatchObject({
          code: "not_found",
          message: "place_booking_grant_not_found",
        });
        await expect(repo.decline({ id, ...who, now: NOW })).rejects.toMatchObject({ code: "not_found" });
      }
    }
    expect(repo.rows.get(personGrant.id)).toMatchObject({ acceptedAt: null, declinedAt: null });
    expect(repo.rows.get(orgGrant.id)).toMatchObject({ acceptedAt: null, declinedAt: null });
    expect((await repo.accept({ id: personGrant.id, humanIds: [HUMAN], orgIds: [], now: NOW })).acceptedAt).toEqual(NOW);
    expect((await repo.decline({ id: orgGrant.id, humanIds: [STRANGER], orgIds: [ORG], now: NOW })).declinedAt).toEqual(NOW);
    // Answered: a stranger still reads not_found, never not_pending.
    await expect(
      repo.accept({ id: personGrant.id, humanIds: [STRANGER], orgIds: [], now: NOW }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("getForPlace reads a grant only at its place", async () => {
    const repo = createFakePlaceBookingGrantsRepo();
    const g = repo.seed({ placeId: PLACE, humanId: HUMAN });
    expect((await repo.getForPlace({ id: g.id, placeId: PLACE }))?.id).toBe(g.id);
    expect(await repo.getForPlace({ id: g.id, placeId: OTHER_PLACE })).toBeNull();
    expect(await repo.getForPlace({ id: "nope", placeId: PLACE })).toBeNull();
  });

  it("findActiveForActor matches by grantee kind (an org id among the people never matches), whole-place first", async () => {
    const repo = createFakePlaceBookingGrantsRepo();
    repo.seed({ placeId: PLACE, grantee: { kind: "org", orgId: HUMAN } });
    expect(await repo.findActiveForActor({ placeId: PLACE, humanIds: [HUMAN], orgIds: [], now: NOW })).toBeNull();

    const scoped = repo.seed({ placeId: PLACE, calendarId: CAL_A, humanId: HUMAN, createdAt: new Date("2026-01-01") });
    const find = (calendarId: string | null) =>
      repo.findActiveForActor({ placeId: PLACE, calendarId, humanIds: [HUMAN], orgIds: [], now: NOW });
    expect((await find(CAL_A))?.id).toBe(scoped.id);
    expect(await find(CAL_B)).toBeNull();
    expect(await find(null)).toBeNull();
    const whole = repo.seed({ placeId: PLACE, humanId: HUMAN, createdAt: new Date("2026-02-01") });
    expect((await find(CAL_A))?.id).toBe(whole.id);
  });

  it("listActiveForActor returns every match in findActiveForActor's order, and nothing inactive or elsewhere", async () => {
    const repo = createFakePlaceBookingGrantsRepo();
    const scoped = repo.seed({ placeId: PLACE, calendarId: CAL_A, humanId: HUMAN, createdAt: new Date("2026-01-01") });
    const org = repo.seed({ placeId: PLACE, grantee: { kind: "org", orgId: ORG }, createdAt: new Date("2026-03-01") });
    const whole = repo.seed({ placeId: PLACE, humanId: HUMAN, createdAt: new Date("2026-02-01") });
    repo.seed({ placeId: OTHER_PLACE, humanId: HUMAN });
    repo.seed({ placeId: PLACE, humanId: HUMAN, revokedAt: NOW });
    repo.seed({ placeId: PLACE, humanId: HUMAN, acceptedAt: null });
    const input = { placeId: PLACE, calendarId: CAL_A, humanIds: [HUMAN], orgIds: [ORG], now: NOW };
    const listed = await repo.listActiveForActor(input);
    expect(listed.map((g) => g.id)).toEqual([whole.id, org.id, scoped.id]);
    expect((await repo.findActiveForActor(input))?.id).toBe(listed[0]!.id);
    expect(await repo.listActiveForActor({ ...input, humanIds: [], orgIds: [] })).toEqual([]);
  });

  it("expired, revoked and declined grants are inactive", async () => {
    const repo = createFakePlaceBookingGrantsRepo();
    repo.seed({ placeId: PLACE, humanId: HUMAN, expiresAt: new Date(NOW.getTime() - 1) });
    repo.seed({ placeId: PLACE, humanId: HUMAN, revokedAt: NOW });
    repo.seed({ placeId: PLACE, humanId: HUMAN, acceptedAt: null, declinedAt: NOW });
    expect(await repo.findActiveForActor({ placeId: PLACE, humanIds: [HUMAN], orgIds: [], now: NOW })).toBeNull();
    expect(await repo.listForGrantee({ humanIds: [HUMAN], orgIds: [], now: NOW })).toEqual([]);
  });

  it("update / revoke are place-scoped and skip revoked grants; a new expiry clears the warning stamp", async () => {
    const repo = createFakePlaceBookingGrantsRepo({ calendarPlace: (id) => (id === CAL_A ? PLACE : OTHER_PLACE) });
    const g = repo.seed({ placeId: PLACE, humanId: HUMAN, expiryWarnedAt: NOW });
    expect(await repo.update({ id: g.id, placeId: OTHER_PLACE, expiresAt: null })).toBeNull();
    await expect(repo.update({ id: g.id, placeId: PLACE, calendarId: CAL_B })).rejects.toMatchObject({
      code: "grant_calendar_place_mismatch",
    });
    const expiresAt = new Date("2026-11-01T00:00:00.000Z");
    expect(await repo.update({ id: g.id, placeId: PLACE, expiresAt })).toMatchObject({ expiresAt, expiryWarnedAt: null });
    expect(await repo.revoke({ id: g.id, placeId: OTHER_PLACE, now: NOW })).toBeNull();
    expect((await repo.revoke({ id: g.id, placeId: PLACE, now: NOW }))?.revokedAt).toEqual(NOW);
    expect(await repo.revoke({ id: g.id, placeId: PLACE, now: NOW })).toBeNull();
    expect(await repo.update({ id: g.id, placeId: PLACE, expiresAt: null })).toBeNull();
    expect(await repo.listForPlace({ placeId: PLACE })).toEqual([]);
    expect((await repo.listForPlace({ placeId: PLACE, includeEnded: true })).map((r) => r.id)).toEqual([g.id]);
  });

  it("listExpiring reads accepted grants due by the cutoff, soonest first; markExpiryWarned is once only", async () => {
    const repo = createFakePlaceBookingGrantsRepo();
    const later = repo.seed({ placeId: PLACE, humanId: HUMAN, expiresAt: new Date("2026-10-20") });
    const sooner = repo.seed({ placeId: PLACE, humanId: HUMAN, expiresAt: new Date("2026-10-18") });
    repo.seed({ placeId: PLACE, humanId: HUMAN, expiresAt: new Date("2026-10-19"), acceptedAt: null });
    repo.seed({ placeId: PLACE, humanId: HUMAN, expiresAt: new Date("2026-12-01") });
    const due = (unwarnedOnly: boolean) =>
      repo.listExpiring({ expiresBefore: new Date("2026-10-22"), unwarnedOnly, limit: 10 });
    expect((await due(true)).map((g) => g.id)).toEqual([sooner.id, later.id]);
    const soonerAt = new Date("2026-10-18");
    // A run that read another date (the expiry moved) does not stamp.
    expect(await repo.markExpiryWarned({ id: sooner.id, expiresAt: new Date("2026-10-17"), now: NOW })).toBe(false);
    expect(await repo.markExpiryWarned({ id: sooner.id, expiresAt: soonerAt, now: NOW })).toBe(true);
    expect(await repo.markExpiryWarned({ id: sooner.id, expiresAt: soonerAt, now: NOW })).toBe(false);
    expect((await due(true)).map((g) => g.id)).toEqual([later.id]);
    expect((await due(false)).map((g) => g.id)).toEqual([sooner.id, later.id]);
  });
});
