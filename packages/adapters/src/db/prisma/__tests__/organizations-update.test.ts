import { describe, expect, it, vi } from "vitest";

import { makeOrganizationsRepo } from "../organizations";
import type { PrismaClientOrTx } from "../types";

/**
 * `makeOrganizationsRepo.update` builds a Prisma `data` patch for a row with
 * several NULLABLE columns, which needs a three-way distinction:
 *
 *   omit         → leave the column alone
 *   `null`       → clear the column
 *   value        → set the column
 *
 * The trap this suite guards: TypeScript cannot separate `{ contactEmail:
 * undefined }` from `{}` without `exactOptionalPropertyTypes`, so a caller
 * writing `{ x: cond ? v : undefined }` type-checks perfectly. The original
 * `hasOwnProperty` + `?? null` guard read that as "clear the column" and
 * silently wiped it. That is how a name-only org save erased the group's
 * CAN-SPAM mailing address.
 */

const ROW = {
  id: "org-1",
  name: "Acme",
  slug: "acme",
  status: "ACTIVE",
  defaultLocale: "en",
  contactEmail: "hello@acme.test",
  physicalAddress: "123 Main St",
  defaultPrimaryPayoutTermsId: null,
  defaultResalePayoutTermsId: null,
  trustTier: "STANDARD",
  trustBadgeLabel: null,
  trustBadgeIcon: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

function createPrisma() {
  const update = vi.fn(async () => ROW);
  const prisma = { organization: { update } } as unknown as PrismaClientOrTx;
  return { prisma, update };
}

/** The `data` object handed to Prisma. */
async function patchFor(input: Record<string, unknown>) {
  const { prisma, update } = createPrisma();
  await makeOrganizationsRepo(prisma).update(
    input as Parameters<ReturnType<typeof makeOrganizationsRepo>["update"]>[0],
  );
  expect(update).toHaveBeenCalledTimes(1);
  return update.mock.calls[0]![0].data as Record<string, unknown>;
}

/**
 * Assert the column is GENUINELY ABSENT from the Prisma patch. Asserting
 * `toBeUndefined()` would pass against the bug too — Prisma ignores an absent
 * key but WRITES an explicit `null`, and the bug produced `null`, not
 * `undefined`. Key presence is the only assertion that separates them.
 */
function expectUntouched(patch: Record<string, unknown>, ...columns: string[]) {
  for (const column of columns) {
    expect(
      Object.prototype.hasOwnProperty.call(patch, column),
      `expected column "${column}" to be absent from the Prisma patch, got ${JSON.stringify(
        patch[column],
      )}`,
    ).toBe(false);
  }
}

describe("makeOrganizationsRepo.update — omitted columns", () => {
  it("touches nothing but the fields supplied", async () => {
    const patch = await patchFor({ id: "org-1", name: "Renamed", slug: "renamed" });

    expect(patch).toEqual({ name: "Renamed", slug: "renamed" });
    expectUntouched(
      patch,
      "contactEmail",
      "physicalAddress",
      "defaultLocale",
      "defaultPrimaryPayoutTermsId",
      "defaultResalePayoutTermsId",
      "trustBadgeLabel",
      "trustBadgeIcon",
    );
  });

  it("treats an EXPLICIT undefined exactly like an omitted key", async () => {
    // The regression in one assertion. Every nullable column below is present
    // on the input object with the value `undefined` — `hasOwnProperty` is TRUE
    // for all of them — and none may reach the patch.
    const patch = await patchFor({
      id: "org-1",
      name: "Renamed",
      slug: "renamed",
      defaultLocale: undefined,
      contactEmail: undefined,
      physicalAddress: undefined,
      defaultPrimaryPayoutTermsId: undefined,
      defaultResalePayoutTermsId: undefined,
      trustBadgeLabel: undefined,
      trustBadgeIcon: undefined,
    });

    expect(patch).toEqual({ name: "Renamed", slug: "renamed" });
    expectUntouched(
      patch,
      "contactEmail",
      "physicalAddress",
      "defaultLocale",
      "defaultPrimaryPayoutTermsId",
      "defaultResalePayoutTermsId",
      "trustBadgeLabel",
      "trustBadgeIcon",
    );
  });
});

describe("makeOrganizationsRepo.update — explicit null still clears", () => {
  it("writes null for every nullable column passed as null", async () => {
    // The reason the key-presence check exists at all: clearing a field is a
    // real, supported intent and must survive the fix above.
    const patch = await patchFor({
      id: "org-1",
      defaultLocale: null,
      contactEmail: null,
      physicalAddress: null,
      defaultPrimaryPayoutTermsId: null,
      defaultResalePayoutTermsId: null,
      trustBadgeLabel: null,
      trustBadgeIcon: null,
    });

    expect(patch).toEqual({
      defaultLocale: null,
      contactEmail: null,
      physicalAddress: null,
      defaultPrimaryPayoutTermsId: null,
      defaultResalePayoutTermsId: null,
      trustBadgeLabel: null,
      trustBadgeIcon: null,
    });
  });

  it("clears one column without disturbing its neighbours", async () => {
    const patch = await patchFor({ id: "org-1", contactEmail: null });

    expect(patch).toEqual({ contactEmail: null });
    expectUntouched(patch, "physicalAddress", "defaultLocale", "name", "slug");
  });
});

describe("makeOrganizationsRepo.update — values pass through", () => {
  it("sets supplied values verbatim", async () => {
    const patch = await patchFor({
      id: "org-1",
      contactEmail: "new@acme.test",
      physicalAddress: "9 New Road",
      trustTier: "VERIFIED",
    });

    expect(patch).toEqual({
      contactEmail: "new@acme.test",
      physicalAddress: "9 New Road",
      trustTier: "VERIFIED",
    });
    expectUntouched(patch, "name", "slug", "defaultLocale");
  });

  it("targets the row by id via `where`, never through `data`", async () => {
    const { prisma, update } = createPrisma();
    await makeOrganizationsRepo(prisma).update({
      id: "org-1",
      contactEmail: "new@acme.test",
    });

    const call = update.mock.calls[0]![0];
    expect(call.where).toEqual({ id: "org-1" });
    expect(call.data).not.toHaveProperty("id");
  });
});

describe("makeOrganizationsRepo.setDefaultPrimaryPayoutTermsIdIfNull", () => {
  it("guards the write with WHERE defaultPrimaryPayoutTermsId IS NULL and returns true on a 1-match", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const prisma = {
      organization: { updateMany },
    } as unknown as PrismaClientOrTx;

    const won = await makeOrganizationsRepo(
      prisma,
    ).setDefaultPrimaryPayoutTermsIdIfNull({
      id: "org-1",
      payoutTermsId: "pt-1",
    });

    expect(won).toBe(true);
    // The WHERE pins the pointer to NULL — a true compare-and-swap, so a
    // concurrent setter results in a 0-match instead of a silent overwrite.
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "org-1", defaultPrimaryPayoutTermsId: null },
      data: { defaultPrimaryPayoutTermsId: "pt-1" },
    });
  });

  it("returns false on a 0-match (pointer already set by a concurrent transaction)", async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const prisma = {
      organization: { updateMany },
    } as unknown as PrismaClientOrTx;

    const won = await makeOrganizationsRepo(
      prisma,
    ).setDefaultPrimaryPayoutTermsIdIfNull({
      id: "org-1",
      payoutTermsId: "pt-1",
    });

    expect(won).toBe(false);
  });
});
