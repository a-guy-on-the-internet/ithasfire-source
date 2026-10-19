import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { makeSpacesRepo } from "../spaces";
import type { PrismaClientOrTx } from "../types";

/**
 * Unit coverage for the Spaces adapter's one piece of real logic: translating a
 * retire that the DATABASE refused into a typed domain error.
 *
 * `Calendar.primarySpaceId` carries a composite FK onto `Space(id, status)`
 * whose status leg is CHECK-pinned to ACTIVE (owner ruling 2026-09-24, migration
 * 20260924120000_calendar_primary_space), so `UPDATE "Space" SET status =
 * 'RETIRED'` on a space some calendar names as its primary raises a
 * referenced-side FK violation — P2003. The venue admin must not see Postgres
 * wording, so `setStatus` maps it to
 * `CANNOT_RETIRE_LAST_ACTIVE_SPACE_ON_CALENDAR`.
 *
 * The mapping must be EXACT on the constraint name. Both `Space` and `Calendar`
 * carry other FKs (`Space_placeId_fkey`, `Calendar_placeId_fkey`,
 * `CalendarSpace_spaceId_fkey`, …), and a substring guess at "Space" or
 * "Calendar" would swallow every one of them — reporting "a calendar blocks
 * this" for a failure that had nothing to do with calendars. Half these cases
 * exist to pin that down.
 *
 * What this file deliberately does NOT claim: that the FK serializes anything.
 * A mocked `update` has no transaction and no second session. That proof lives
 * in test/integration/calendar-primary-space-race.test.ts, against real
 * Postgres.
 *
 * (This file previously covered `lockCalendarSpaceGuard`, the place-scoped
 * advisory lock that guarded the same invariant cooperatively. The 2026-09-24
 * ruling replaced it with the constraint above and deleted the lock.)
 */

const PRIMARY_SPACE_FK = "Calendar_primarySpaceId_primarySpaceStatus_fkey";

/**
 * A P2003 as the DRIVER-ADAPTER engine shapes it — the only engine this repo
 * runs. The constraint name lives inside `originalMessage`, verbatim Postgres
 * wording, nested under `meta.driverAdapterError.cause`.
 */
function fkViolation(constraintName: string) {
  return new Prisma.PrismaClientKnownRequestError(
    "Foreign key constraint violated",
    {
      code: "P2003",
      clientVersion: "test",
      meta: {
        driverAdapterError: {
          cause: {
            originalMessage: `update or delete on table "Space" violates foreign key constraint "${constraintName}" on table "Calendar"`,
          },
        },
      },
    },
  );
}

/** The same P2003 as the CLASSIC engine shapes it (`meta.field_name`). */
function fkViolationClassicShape(constraintName: string) {
  return new Prisma.PrismaClientKnownRequestError(
    "Foreign key constraint violated",
    {
      code: "P2003",
      clientVersion: "test",
      meta: { field_name: constraintName },
    },
  );
}

function repoThatThrows(error: unknown) {
  const update = vi.fn(async () => {
    throw error;
  });
  return {
    repo: makeSpacesRepo({ space: { update } } as unknown as PrismaClientOrTx),
    update,
  };
}

describe("makeSpacesRepo.setStatus – primary-space FK translation", () => {
  it("maps the primary-space FK violation to CANNOT_RETIRE_LAST_ACTIVE_SPACE_ON_CALENDAR", async () => {
    const { repo } = repoThatThrows(fkViolation(PRIMARY_SPACE_FK));

    await expect(
      repo.setStatus({ id: "space-1", status: "RETIRED" }),
    ).rejects.toMatchObject({
      code: "CANNOT_RETIRE_LAST_ACTIVE_SPACE_ON_CALENDAR",
      meta: { spaceId: "space-1", calendars: [], raced: true },
    });
  });

  it("recognises the constraint in the classic engine's meta shape too", async () => {
    const { repo } = repoThatThrows(fkViolationClassicShape(PRIMARY_SPACE_FK));

    await expect(
      repo.setStatus({ id: "space-1", status: "RETIRED" }),
    ).rejects.toMatchObject({
      code: "CANNOT_RETIRE_LAST_ACTIVE_SPACE_ON_CALENDAR",
    });
  });

  it("keeps meta.calendars EMPTY — the refusal cannot name what it never read", async () => {
    // Reaching this branch means a race, not a guard failure: `setSpaceStatus`
    // already refused every calendar it could see and named them. The
    // referencing rows are not in the Postgres error, and re-reading them after
    // an aborted statement would report a state nobody observed. An empty array
    // is the honest answer, and the reason `raced: true` rides along.
    const { repo } = repoThatThrows(fkViolation(PRIMARY_SPACE_FK));

    const error = await repo
      .setStatus({ id: "space-1", status: "RETIRED" })
      .then(
        () => null,
        (e: unknown) => e as { meta?: { calendars?: unknown } },
      );

    expect(error?.meta?.calendars).toEqual([]);
  });

  it("does NOT swallow a P2003 on a DIFFERENT foreign key", async () => {
    // `Space_placeId_fkey` firing means the place is gone, not that a calendar
    // objects. Reporting it as a calendar blocker would send a venue admin to
    // the wrong screen.
    const original = fkViolation("Space_placeId_fkey");
    const { repo } = repoThatThrows(original);

    await expect(
      repo.setStatus({ id: "space-1", status: "RETIRED" }),
    ).rejects.toBe(original);
  });

  it("does NOT swallow a P2003 whose message merely mentions Calendar", async () => {
    const original = fkViolation("CalendarSpace_spaceId_fkey");
    const { repo } = repoThatThrows(original);

    await expect(
      repo.setStatus({ id: "space-1", status: "RETIRED" }),
    ).rejects.toBe(original);
  });

  it("does NOT swallow a non-P2003 error naming the same constraint", async () => {
    const original = new Prisma.PrismaClientKnownRequestError("nope", {
      code: "P2025",
      clientVersion: "test",
      meta: { field_name: PRIMARY_SPACE_FK },
    });
    const { repo } = repoThatThrows(original);

    await expect(
      repo.setStatus({ id: "space-1", status: "RETIRED" }),
    ).rejects.toBe(original);
  });

  it("rethrows a plain Error untouched", async () => {
    const original = new Error("connection reset");
    const { repo } = repoThatThrows(original);

    await expect(
      repo.setStatus({ id: "space-1", status: "RETIRED" }),
    ).rejects.toBe(original);
  });

  it("returns the DTO on the happy path (and never leaks the Prisma model)", async () => {
    const row = {
      id: "space-1",
      placeId: "place-1",
      name: "Patio",
      capacity: null,
      sortOrder: 1,
      status: "RETIRED",
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
      updatedAt: new Date("2026-09-24T00:00:00.000Z"),
      // A column the DTO must NOT carry through.
      internalOnly: "leak",
    };
    const update = vi.fn(async () => row);
    const repo = makeSpacesRepo({
      space: { update },
    } as unknown as PrismaClientOrTx);

    const result = await repo.setStatus({ id: "space-1", status: "RETIRED" });

    expect(result).toEqual({
      id: "space-1",
      placeId: "place-1",
      name: "Patio",
      capacity: null,
      sortOrder: 1,
      status: "RETIRED",
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
    expect(result).not.toHaveProperty("internalOnly");
  });
});
