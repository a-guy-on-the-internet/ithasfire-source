import { describe, expect, it, vi } from "vitest";

import { makePlacesRepo } from "../places";
import type { PrismaClientOrTx } from "../types";

/**
 * The ACCESS FILTER `listAccessibleByHuman` builds — the clause that decides
 * which venues an admin surface is allowed to list.
 *
 * This exists because the admin Places table shipped with `ownedOnly: false`,
 * and that branch ORs `{ verification: "VERIFIED" }` into the filter: the page
 * listed EVERY verified venue on the platform under "Manage your venues".
 * Measured in dev — an org owning zero venues was shown nine, none of them
 * theirs. Nothing could be DONE with them (`requirePlaceOwnership` gates every
 * write and the per-venue inbox), but the listing itself was wrong.
 *
 * The three shapes asserted here are the three the admin has:
 *   - org context      → that org's ownership rows, and nothing else;
 *   - personal context → the actor's own rows OR their orgs';
 *   - pickers          → org-owned only (a venue the person holds personally
 *                        is not one the org can use).
 * The global-verified escape hatch must appear in NONE of them.
 */

const HUMAN_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

function captureWhere() {
  const findMany = vi.fn(async () => []);
  const count = vi.fn(async () => 0);
  const prisma = {
    place: { findMany, count },
    placeOwnership: { findMany: vi.fn(async () => []) },
  } as unknown as PrismaClientOrTx;
  return { prisma, findMany };
}

/** The `ownerships.some(...)` predicate inside the access filter. */
function ownershipPredicate(where: any) {
  const access = where.AND[0];
  return access.ownerships?.some ?? null;
}

describe("makePlacesRepo.listAccessibleByHuman — admin scoping", () => {
  it("ORG context: only that org's ownership rows, never a global-verified branch", async () => {
    const { prisma, findMany } = captureWhere();
    await makePlacesRepo(prisma).listAccessibleByHuman({
      humanId: HUMAN_ID,
      orgIds: [ORG_ID],
      ownedOnly: true,
    });

    const where = findMany.mock.calls[0]![0].where;
    // No `{ verification: "VERIFIED" }` OR-branch anywhere in the access
    // filter — that is the clause that turned this into a directory.
    expect(JSON.stringify(where.AND)).not.toContain("VERIFIED");
    expect(ownershipPredicate(where)).toMatchObject({
      ownerType: "ORGANIZATION",
      ownerId: { in: [ORG_ID] },
      verified: true,
    });
  });

  it("ORG context does NOT fold in venues the actor owns personally", async () => {
    const { prisma, findMany } = captureWhere();
    await makePlacesRepo(prisma).listAccessibleByHuman({
      humanId: HUMAN_ID,
      orgIds: [ORG_ID],
      ownedOnly: true,
    });

    const predicate = ownershipPredicate(findMany.mock.calls[0]![0].where);
    expect(predicate.OR).toBeUndefined();
    expect(JSON.stringify(predicate)).not.toContain(HUMAN_ID);
  });

  it("PERSONAL context: the actor's own rows OR their orgs', still ownership-only", async () => {
    const { prisma, findMany } = captureWhere();
    await makePlacesRepo(prisma).listAccessibleByHuman({
      humanId: HUMAN_ID,
      orgIds: [ORG_ID],
      ownedOnly: true,
      includeActorOwnedWithOrgs: true,
    });

    const where = findMany.mock.calls[0]![0].where;
    expect(JSON.stringify(where.AND)).not.toContain("VERIFIED");
    expect(ownershipPredicate(where).OR).toEqual([
      {
        ownerType: "HUMAN",
        ownerId: HUMAN_ID,
        verified: true,
        revokedAt: null,
      },
      {
        ownerType: "ORGANIZATION",
        ownerId: { in: [ORG_ID] },
        verified: true,
        revokedAt: null,
      },
    ]);
  });

  it("the global-verified branch still exists for genuine directory reads", async () => {
    // `ownedOnly: false` is a real mode (browsing verified venues) — this test
    // pins WHERE it lives, so a future caller has to opt into it explicitly
    // rather than inheriting it from a default.
    const { prisma, findMany } = captureWhere();
    await makePlacesRepo(prisma).listAccessibleByHuman({
      humanId: HUMAN_ID,
      orgIds: [ORG_ID],
      ownedOnly: false,
    });

    const access = findMany.mock.calls[0]![0].where.AND[0];
    expect(access.OR).toEqual([
      { verification: "VERIFIED" },
      expect.objectContaining({ ownerships: expect.anything() }),
    ]);
  });

  it("a REVOKED ownership row grants nothing, in every scope", async () => {
    // `listOwnedBySubject` and `toPlaceRecord` both drop revoked rows; this
    // finder did not, so a revoked owner kept the venue in their Places table
    // after every other surface had let go of it.
    for (const extra of [
      { ownedOnly: true },
      { ownedOnly: true, includeActorOwnedWithOrgs: true },
      // Also on the "show me my unverified stubs" path — `verified` is
      // legitimately relaxed there, `revokedAt` never is.
      { ownedOnly: true, includeOwnedUnverified: true },
    ]) {
      const { prisma, findMany } = captureWhere();
      await makePlacesRepo(prisma).listAccessibleByHuman({
        humanId: HUMAN_ID,
        orgIds: [ORG_ID],
        ...extra,
      });

      const predicate = ownershipPredicate(findMany.mock.calls[0]![0].where);
      const branches = predicate.OR ?? [predicate];
      for (const branch of branches) {
        expect(branch).toMatchObject({ revokedAt: null });
      }
    }
  });

  it("keeps `verified` relaxed for owned-unverified reads (a stub you made is yours)", async () => {
    const { prisma, findMany } = captureWhere();
    await makePlacesRepo(prisma).listAccessibleByHuman({
      humanId: HUMAN_ID,
      orgIds: [ORG_ID],
      ownedOnly: true,
      includeOwnedUnverified: true,
    });

    const predicate = ownershipPredicate(findMany.mock.calls[0]![0].where);
    expect(predicate.verified).toBeUndefined();
  });
});

/**
 * The SEARCH predicate — the street arm is EXACT-only. Inclusion in this list
 * is an answer even when the rows are redacted: matching `address ILIKE` on a
 * venue that withholds its address turns the search box into a substring
 * oracle on the street. Row-level behaviour is pinned against Postgres in
 * `test/integration/places-list-accessible-address-oracle.test.ts`; this pins
 * the clause shape for both scopes that carry it.
 */
describe("makePlacesRepo.listAccessibleByHuman — search never probes a withheld street", () => {
  for (const ownedOnly of [false, true]) {
    it(`ownedOnly=${ownedOnly}: the address arm is guarded by locationMode EXACT`, async () => {
      const { prisma, findMany } = captureWhere();
      await makePlacesRepo(prisma).listAccessibleByHuman({
        humanId: HUMAN_ID,
        orgIds: [ORG_ID],
        ownedOnly,
        query: "  elm st ",
      });

      // `vi.fn(async () => [])` types its calls as `[]`; the repo passes one arg.
      const [args] = findMany.mock.calls[0] as unknown as [{ where: any }];
      const where = args.where;
      const arms = where.OR as Array<Record<string, unknown>>;
      // No bare `address` arm anywhere in the OR.
      expect(arms.some((arm) => "address" in arm)).toBe(false);
      expect(arms).toContainEqual({
        AND: [
          { locationMode: "EXACT" },
          { address: { contains: "elm st", mode: "insensitive" } },
        ],
      });
      // Name and city stay unguarded — a withheld venue publishes both.
      expect(arms).toContainEqual({
        name: { contains: "elm st", mode: "insensitive" },
      });
      expect(arms).toContainEqual({
        city: { contains: "elm st", mode: "insensitive" },
      });
    });
  }
});
