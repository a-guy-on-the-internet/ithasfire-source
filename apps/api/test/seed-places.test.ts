import { describe, expect, it, vi } from "vitest";

import { ensurePlaces } from "../src/scripts/seed/places";

/**
 * Minimal Prisma stub for `ensurePlaces`.
 *
 * These tests assert on the `place.upsert` payload only, but `ensurePlaces`
 * also calls `ensureVenueDefaults`, which touches `space`, `calendar` and
 * `calendarSpace`. Those three models arrived with the venue hierarchy
 * (f42f16b4) and were never added here, so the stub 500'd on
 * `prisma.space.findFirst` of undefined and both tests failed.
 *
 * Stubbed as a whole-surface helper rather than per-test literals so the next
 * model added to the seed path is one edit, not a hunt through every case.
 */
const makePrismaStub = (
  placeUpsert: ReturnType<typeof vi.fn>,
): Record<string, unknown> => ({
  place: { upsert: placeUpsert },
  placeOwnership: { upsert: vi.fn(async () => ({})) },
  // `space` is find-or-create: return null from both lookups so the seed takes
  // the create branch, which is the path a fresh database actually follows.
  space: {
    findUnique: vi.fn(async () => null),
    findFirst: vi.fn(async () => null),
    create: vi.fn(async ({ data }: any) => ({ id: "space-1", ...data })),
  },
  calendar: {
    upsert: vi.fn(async ({ create }: any) => ({
      id: create.id ?? "calendar-1",
      ...create,
    })),
  },
  calendarSpace: { upsert: vi.fn(async () => ({})) },
  event: { updateMany: vi.fn(async () => ({ count: 0 })) },
});

describe("ensurePlaces", () => {
  it("lists verified seed places in the directory by default", async () => {
    const upsert = vi.fn(async ({ create }: any) => ({ id: create.id }));
    const prisma = makePrismaStub(upsert) as any;

    await ensurePlaces(prisma, [
      {
        id: "place-1",
        name: "Seed Venue",
        address: "123 Main St",
        city: "Austin",
        region: "TX",
        country: "US",
        postcode: "78701",
        lat: 30.2672,
        lng: -97.7431,
      },
    ]);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          listedInDirectory: true,
          verification: "VERIFIED",
        }),
        update: expect.objectContaining({
          listedInDirectory: true,
          verification: "VERIFIED",
        }),
      }),
    );
  });

  it("keeps explicitly unverified seed places out of the directory", async () => {
    const upsert = vi.fn(async ({ create }: any) => ({ id: create.id }));
    const prisma = makePrismaStub(upsert) as any;

    await ensurePlaces(prisma, [
      {
        id: "place-2",
        name: "Hidden Venue",
        address: "456 Side St",
        city: "New York",
        region: "NY",
        country: "US",
        postcode: "10001",
        lat: 40.7128,
        lng: -74.006,
        unverified: true,
      },
    ]);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          listedInDirectory: false,
          verification: "UNVERIFIED",
        }),
        update: expect.objectContaining({
          listedInDirectory: false,
          verification: "UNVERIFIED",
        }),
      }),
    );
  });
});
