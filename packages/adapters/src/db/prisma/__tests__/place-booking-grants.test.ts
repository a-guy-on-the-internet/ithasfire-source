import { describe, expect, it, vi } from "vitest";

import { makePlaceBookingGrantsRepo } from "../place-booking-grants";
import type { PrismaClientOrTx } from "../types";

/**
 * Query-shape + mapping coverage for the PlaceBookingGrant adapter
 * (holds-without-a-request FR-002 / FR-003 / FR-004). DB-backed behaviour
 * (the active rule end to end, CAS, the grantee XOR CHECK) lives in
 * test/integration/holds-without-a-request.test.ts and
 * test/integration/venue-confirmation.test.ts.
 */

const NOW = new Date("2026-10-15T10:00:00.000Z");

const ROW = {
  id: "grant-1",
  placeId: "place-1",
  calendarId: null as string | null,
  humanId: "human-1" as string | null,
  granteeHumanId: "human-1" as string | null,
  granteeOrgId: null as string | null,
  canPlaceHolds: true,
  canCreateEvents: true,
  grantedByHumanId: "owner-1",
  expiresAt: null as Date | null,
  revokedAt: null as Date | null,
  acceptedAt: new Date("2026-10-01T10:00:00.000Z") as Date | null,
  declinedAt: null as Date | null,
  expiryWarnedAt: null as Date | null,
  createdAt: new Date("2026-10-01T10:00:00.000Z"),
};

/** The ACTIVE rule, as every active read must put it in the WHERE. */
const ACTIVE = {
  acceptedAt: { not: null },
  declinedAt: null,
  revokedAt: null,
  OR: [{ expiresAt: null }, { expiresAt: { gt: NOW } }],
};

function grantsPrisma(row: unknown = ROW) {
  const findFirst = vi.fn(async () => row);
  const findUnique = vi.fn(async () => row);
  const findMany = vi.fn(async () => [row]);
  const create = vi.fn(async () => row);
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const calendarFindUnique = vi.fn(async () => ({ placeId: "place-1" }));
  const prisma = {
    placeBookingGrant: { findFirst, findUnique, findMany, create, updateMany },
    calendar: { findUnique: calendarFindUnique },
  } as unknown as PrismaClientOrTx;
  return { prisma, findFirst, findUnique, findMany, create, updateMany, calendarFindUnique };
}

describe("placeBookingGrants mapping", () => {
  it("maps a person grantee and every lifecycle stamp; never the deprecated capability columns (H3)", async () => {
    const { prisma } = grantsPrisma();
    expect(await makePlaceBookingGrantsRepo(prisma).getForPlace({ id: "grant-1", placeId: "place-1" })).toEqual({
      id: "grant-1",
      placeId: "place-1",
      calendarId: null,
      grantee: { kind: "person", humanId: "human-1" },
      grantedByHumanId: "owner-1",
      expiresAt: null,
      revokedAt: null,
      acceptedAt: ROW.acceptedAt,
      declinedAt: null,
      expiryWarnedAt: null,
      createdAt: ROW.createdAt,
    });
  });

  it("maps an org grantee (humanId null)", async () => {
    const { prisma } = grantsPrisma({
      ...ROW,
      humanId: null,
      granteeHumanId: null,
      granteeOrgId: "org-1",
    });
    expect(await makePlaceBookingGrantsRepo(prisma).getForPlace({ id: "grant-1", placeId: "place-1" })).toMatchObject({
      grantee: { kind: "org", orgId: "org-1" },
    });
  });

  it("falls back to the deprecated humanId for a row the backfill missed", async () => {
    const { prisma } = grantsPrisma({ ...ROW, granteeHumanId: null });
    expect(await makePlaceBookingGrantsRepo(prisma).getForPlace({ id: "grant-1", placeId: "place-1" })).toMatchObject({
      grantee: { kind: "person", humanId: "human-1" },
    });
  });

  it.each([
    ["both an org and a person", { granteeOrgId: "org-1" }],
    ["no grantee", { humanId: null, granteeHumanId: null }],
  ])("throws on a row with %s (XOR CHECK breach)", async (_label, over) => {
    const { prisma } = grantsPrisma({ ...ROW, ...over });
    await expect(makePlaceBookingGrantsRepo(prisma).getForPlace({ id: "grant-1", placeId: "place-1" })).rejects.toThrow(
      /place_booking_grant_grantee_shape/,
    );
  });
});

describe("placeBookingGrants active reads", () => {
  it("findActiveForActor matches grantee IN the caller's people OR orgs, ACTIVE, in scope", async () => {
    const { prisma, findFirst } = grantsPrisma();
    await makePlaceBookingGrantsRepo(prisma).findActiveForActor({
      placeId: "place-1",
      calendarId: "cal-1",
      humanIds: ["human-1", "principal-1"],
      orgIds: ["org-1"],
      now: NOW,
    });
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        placeId: "place-1",
        ...ACTIVE,
        AND: [
          {
            AND: [
              {
                OR: [
                  { granteeHumanId: { in: ["human-1", "principal-1"] } },
                  { granteeOrgId: { in: ["org-1"] } },
                ],
              },
            ],
          },
          { AND: [{ OR: [{ calendarId: null }, { calendarId: "cal-1" }] }] },
        ],
      },
      orderBy: [
        { calendarId: { sort: "asc", nulls: "first" } },
        { createdAt: "asc" },
        { id: "asc" },
      ],
    });
  });

  it("findActiveForActor / listForGrantee with no people and no orgs match nothing without a read", async () => {
    const { prisma, findFirst, findMany } = grantsPrisma();
    const repo = makePlaceBookingGrantsRepo(prisma);
    expect(
      await repo.findActiveForActor({ placeId: "place-1", humanIds: [], orgIds: [], now: NOW }),
    ).toBeNull();
    expect(await repo.listForGrantee({ humanIds: [], orgIds: [], now: NOW })).toEqual([]);
    expect(findFirst).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });

  it("listActiveForActor is findActiveForActor's match and order, every row; no people and no orgs → [] without a read", async () => {
    const { prisma, findFirst, findMany } = grantsPrisma();
    const repo = makePlaceBookingGrantsRepo(prisma);
    const input = {
      placeId: "place-1",
      calendarId: "cal-1",
      humanIds: ["human-1", "principal-1"],
      orgIds: ["org-1"],
      now: NOW,
    };
    expect((await repo.listActiveForActor(input)).map((g) => g.id)).toEqual([
      "grant-1",
    ]);
    await repo.findActiveForActor(input);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0]).toEqual(findFirst.mock.calls[0]);
    expect(
      await repo.listActiveForActor({ placeId: "place-1", humanIds: [], orgIds: [], now: NOW }),
    ).toEqual([]);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("listForGrantee lists pending and active grants (not declined, revoked or expired)", async () => {
    const { prisma, findMany } = grantsPrisma();
    await makePlaceBookingGrantsRepo(prisma).listForGrantee({
      humanIds: ["human-1"],
      orgIds: [],
      now: NOW,
    });
    expect(findMany).toHaveBeenCalledWith({
      where: {
        declinedAt: null,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: NOW } }],
        AND: [{ AND: [{ OR: [{ granteeHumanId: { in: ["human-1"] } }] }] }],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
  });
});

describe("placeBookingGrants writes", () => {
  it("create gives a pending person grant, dual-writing humanId and granteeHumanId", async () => {
    const { prisma, create } = grantsPrisma();
    await makePlaceBookingGrantsRepo(prisma).create({
      placeId: "place-1",
      grantee: { kind: "person", humanId: "human-1" },
      grantedByHumanId: "owner-1",
    });
    expect(create).toHaveBeenCalledWith({
      data: {
        placeId: "place-1",
        calendarId: null,
        granteeOrgId: null,
        granteeHumanId: "human-1",
        humanId: "human-1",
        grantedByHumanId: "owner-1",
        expiresAt: null,
        acceptedAt: null,
      },
    });
  });

  it("create gives an org grant with humanId null, and honours a fixture's acceptedAt", async () => {
    const { prisma, create } = grantsPrisma();
    await makePlaceBookingGrantsRepo(prisma).create({
      placeId: "place-1",
      grantee: { kind: "org", orgId: "org-1" },
      grantedByHumanId: "owner-1",
      acceptedAt: NOW,
    });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        granteeOrgId: "org-1",
        granteeHumanId: null,
        humanId: null,
        acceptedAt: NOW,
      }),
    });
  });

  it("create / update refuse a calendar of another place", async () => {
    const { prisma, calendarFindUnique, create, updateMany } = grantsPrisma();
    calendarFindUnique.mockResolvedValue({ placeId: "place-2" });
    const repo = makePlaceBookingGrantsRepo(prisma);
    await expect(
      repo.create({
        placeId: "place-1",
        calendarId: "cal-x",
        grantee: { kind: "org", orgId: "org-1" },
        grantedByHumanId: "owner-1",
      }),
    ).rejects.toMatchObject({ code: "grant_calendar_place_mismatch" });
    await expect(
      repo.update({ id: "grant-1", placeId: "place-1", now: new Date(), calendarId: "cal-x" }),
    ).rejects.toMatchObject({ code: "grant_calendar_place_mismatch" });
    expect(create).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("accept / decline CAS on still pending, unexpired, AND the caller's grantee sets; the loser gets not_pending, a missing id not_found", async () => {
    const { prisma, updateMany, findFirst } = grantsPrisma();
    const repo = makePlaceBookingGrantsRepo(prisma);
    const me = { humanIds: ["human-1"], orgIds: ["org-1"], now: NOW };
    const GRANTEE = {
      AND: [
        {
          OR: [
            { granteeHumanId: { in: ["human-1"] } },
            { granteeOrgId: { in: ["org-1"] } },
          ],
        },
      ],
    };
    await repo.accept({ id: "grant-1", ...me });
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "grant-1",
        acceptedAt: null,
        declinedAt: null,
        revokedAt: null,
        // Unexpired at `now`: a lapsed pending grant can never be accepted.
        OR: [{ expiresAt: null }, { expiresAt: { gt: NOW } }],
        ...GRANTEE,
      },
      data: { acceptedAt: NOW },
    });
    // The read-back is grantee-scoped too, so a mismatch is not_found.
    expect(findFirst).toHaveBeenCalledWith({ where: { id: "grant-1", ...GRANTEE } });
    await repo.decline({ id: "grant-1", ...me });
    expect(updateMany).toHaveBeenLastCalledWith({
      where: {
        id: "grant-1",
        acceptedAt: null,
        declinedAt: null,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: NOW } }],
        ...GRANTEE,
      },
      data: { declinedAt: NOW },
    });
    updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(repo.accept({ id: "grant-1", ...me })).rejects.toMatchObject({
      code: "conflict",
      message: "place_booking_grant_not_pending",
    });
    // Someone else's grant (or a missing id): neither query matches.
    updateMany.mockResolvedValueOnce({ count: 0 });
    findFirst.mockResolvedValueOnce(null);
    await expect(repo.decline({ id: "nope", ...me })).rejects.toMatchObject({
      code: "not_found",
      message: "place_booking_grant_not_found",
    });
  });

  it("lockPlace takes the place's transaction advisory lock, key bound as a parameter", async () => {
    const executeRaw = vi.fn(async () => 1);
    const repo = makePlaceBookingGrantsRepo({ $executeRaw: executeRaw } as unknown as PrismaClientOrTx);
    await repo.lockPlace("place-1");
    expect(executeRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = executeRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    expect(strings.join("?")).toBe("SELECT pg_advisory_xact_lock(hashtext(?))");
    expect(values).toEqual(["place_booking_grants:place-1"]);
  });

  it("accept / decline with no people and no orgs are not_found without a read or a write", async () => {
    const { prisma, updateMany, findFirst } = grantsPrisma();
    const repo = makePlaceBookingGrantsRepo(prisma);
    const nobody = { id: "grant-1", humanIds: [], orgIds: [], now: NOW };
    await expect(repo.accept(nobody)).rejects.toMatchObject({ code: "not_found" });
    await expect(repo.decline(nobody)).rejects.toMatchObject({ code: "not_found" });
    expect(updateMany).not.toHaveBeenCalled();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("getForGrantee reads the grant only for the caller's people or orgs; no sets → null without a read", async () => {
    const { prisma, findFirst } = grantsPrisma();
    const repo = makePlaceBookingGrantsRepo(prisma);
    await repo.getForGrantee({ id: "grant-1", humanIds: ["human-1"], orgIds: ["org-1"] });
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        id: "grant-1",
        AND: [
          { OR: [{ granteeHumanId: { in: ["human-1"] } }, { granteeOrgId: { in: ["org-1"] } }] },
        ],
      },
    });
    findFirst.mockClear();
    expect(await repo.getForGrantee({ id: "grant-1", humanIds: [], orgIds: [] })).toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("getForPlace reads the grant only at its place", async () => {
    const { prisma, findFirst } = grantsPrisma();
    const repo = makePlaceBookingGrantsRepo(prisma);
    await repo.getForPlace({ id: "grant-1", placeId: "place-1" });
    expect(findFirst).toHaveBeenCalledWith({ where: { id: "grant-1", placeId: "place-1" } });
    findFirst.mockResolvedValueOnce(null);
    expect(await repo.getForPlace({ id: "grant-1", placeId: "place-2" })).toBeNull();
  });

  it("update is scoped to the place and a live grant; moving expiresAt clears the warning stamp", async () => {
    const { prisma, updateMany } = grantsPrisma();
    const repo = makePlaceBookingGrantsRepo(prisma);
    const expiresAt = new Date("2026-12-01T00:00:00.000Z");
    const now = new Date("2026-10-01T00:00:00.000Z");
    // Live only: unrevoked, undeclined, not expired at `now`.
    const live = {
      id: "grant-1",
      placeId: "place-1",
      revokedAt: null,
      declinedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    };
    await repo.update({ id: "grant-1", placeId: "place-1", now, expiresAt });
    expect(updateMany).toHaveBeenCalledWith({
      where: live,
      data: { expiresAt, expiryWarnedAt: null },
    });
    await repo.update({ id: "grant-1", placeId: "place-1", now, calendarId: null });
    expect(updateMany).toHaveBeenLastCalledWith({
      where: live,
      data: { calendarId: null },
    });
    updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await repo.update({ id: "grant-1", placeId: "place-2", now, expiresAt: null })).toBeNull();
  });

  it("revoke is scoped to the place, CAS on not yet revoked; null when nothing matched", async () => {
    const { prisma, updateMany } = grantsPrisma();
    const repo = makePlaceBookingGrantsRepo(prisma);
    await repo.revoke({ id: "grant-1", placeId: "place-1", now: NOW });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "grant-1", placeId: "place-1", revokedAt: null },
      data: { revokedAt: NOW },
    });
    updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await repo.revoke({ id: "grant-1", placeId: "place-1", now: NOW })).toBeNull();
  });

  it("listForPlace hides revoked and declined grants unless includeEnded", async () => {
    const { prisma, findMany } = grantsPrisma();
    const repo = makePlaceBookingGrantsRepo(prisma);
    await repo.listForPlace({ placeId: "place-1" });
    expect(findMany).toHaveBeenCalledWith({
      where: { placeId: "place-1", revokedAt: null, declinedAt: null },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    await repo.listForPlace({ placeId: "place-1", includeEnded: true });
    expect(findMany).toHaveBeenLastCalledWith({
      where: { placeId: "place-1" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
  });

  it("listExpiring reads accepted, unrevoked grants expiring by the cutoff, soonest first; markExpiryWarned is a once-only CAS", async () => {
    const { prisma, findMany, updateMany } = grantsPrisma();
    const repo = makePlaceBookingGrantsRepo(prisma);
    const cutoff = new Date("2026-10-22T10:00:00.000Z");
    await repo.listExpiring({ expiresBefore: cutoff, unwarnedOnly: true, limit: 50 });
    expect(findMany).toHaveBeenCalledWith({
      where: {
        acceptedAt: { not: null },
        declinedAt: null,
        revokedAt: null,
        expiresAt: { not: null, lte: cutoff },
        expiryWarnedAt: null,
      },
      orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
      take: 50,
    });
    const readExpiry = new Date("2026-10-20T10:00:00.000Z");
    expect(
      await repo.markExpiryWarned({ id: "grant-1", expiresAt: readExpiry, now: NOW }),
    ).toBe(true);
    // The date the job read is in the CAS: a moved expiry is not stamped.
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "grant-1", expiryWarnedAt: null, expiresAt: readExpiry },
      data: { expiryWarnedAt: NOW },
    });
    updateMany.mockResolvedValueOnce({ count: 0 });
    expect(
      await repo.markExpiryWarned({ id: "grant-1", expiresAt: readExpiry, now: NOW }),
    ).toBe(false);
  });
});
