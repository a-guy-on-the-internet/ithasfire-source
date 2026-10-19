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

  /**
   * `Place.attendeeReviewsPublic` is `@default(false)` in the schema because
   * in prod it is the venue owner's opt-in. The seed inverts that on purpose:
   * with the gate shut on every seeded venue, the public rating block and the
   * attendee aggregate never render and dev/QA cannot reach them. Asserted on
   * BOTH branches — `update` is what makes a reseed converge an existing row.
   */
  it("publishes attendee reviews on every seeded venue, on reseed too", async () => {
    const upsert = vi.fn(async ({ create }: any) => ({ id: create.id }));
    const prisma = makePrismaStub(upsert) as any;

    await ensurePlaces(prisma, [
      {
        id: "place-3",
        name: "Review Venue",
        address: "789 Loud Ave",
        city: "Nashville",
        region: "TN",
        country: "US",
        postcode: "37203",
        lat: 36.1627,
        lng: -86.7816,
      },
      // Unverified venues are gated out of the directory, but the review
      // switch is independent of verification — it still comes on.
      {
        id: "place-4",
        name: "Unverified Venue",
        address: "1 Quiet Ln",
        city: "Memphis",
        region: "TN",
        country: "US",
        postcode: "38103",
        lat: 35.1495,
        lng: -90.049,
        unverified: true,
      },
    ]);

    for (const call of upsert.mock.calls) {
      const { create, update } = call[0] as any;
      expect(create.attendeeReviewsPublic).toBe(true);
      expect(update.attendeeReviewsPublic).toBe(true);
    }
    expect(upsert).toHaveBeenCalledTimes(2);
  });

  it("honours a fixture that opts out of public attendee reviews", async () => {
    const upsert = vi.fn(async ({ create }: any) => ({ id: create.id }));
    const prisma = makePrismaStub(upsert) as any;

    await ensurePlaces(prisma, [
      {
        id: "place-5",
        name: "Private Feedback Venue",
        address: "2 Closed Ct",
        city: "Austin",
        region: "TX",
        country: "US",
        postcode: "78702",
        lat: 30.2672,
        lng: -97.7431,
        attendeeReviewsPublic: false,
      },
    ]);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ attendeeReviewsPublic: false }),
        update: expect.objectContaining({ attendeeReviewsPublic: false }),
      }),
    );
  });
});
