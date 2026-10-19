import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { makePlaceReviewSessionsRepo } from "../place-review-sessions";
import type { PrismaClientOrTx } from "../types";

// Prisma's upsert on (sessionToken, placeId) is a SELECT-then-INSERT, so two
// concurrent callers for the same pair both miss and both insert. The loser
// used to surface as a 500 ("Unique constraint failed") on a fire-and-forget
// telemetry call. It must resolve to the existing row instead.

const SESSION_TOKEN = "8b6d6c1e-0000-4000-8000-000000000001";
const PLACE_ID = "00000000-0000-4000-8000-00000000d030";

const ROW = {
  id: "session-1",
  sessionToken: SESSION_TOKEN,
  humanId: null,
  placeId: PLACE_ID,
  email: null,
  emailCapturedAt: null,
  lastStepKey: null,
  lastStepAt: null,
  pageReached: 1,
  completedAt: null,
  placeReviewId: null,
  abandonmentEmailSentAt: null,
  recoveryUnsubscribedAt: null,
  incentiveShownAt: null,
  createdAt: new Date("2026-08-10T12:00:00.000Z"),
  updatedAt: new Date("2026-08-10T12:00:00.000Z"),
};

const uniqueViolation = () =>
  new Prisma.PrismaClientKnownRequestError(
    "Unique constraint failed on the fields: (`sessionToken`, `placeId`)",
    { code: "P2002", clientVersion: "test" },
  );

function makePrisma(overrides: {
  upsert: ReturnType<typeof vi.fn>;
  update?: ReturnType<typeof vi.fn>;
}) {
  return {
    placeReviewSession: {
      upsert: overrides.upsert,
      update: overrides.update ?? vi.fn(),
    },
  } as unknown as PrismaClientOrTx;
}

describe("placeReviewSessions.upsert", () => {
  it("returns the row when the upsert wins the race", async () => {
    const upsert = vi.fn(async () => ROW);
    const update = vi.fn();
    const repo = makePlaceReviewSessionsRepo(makePrisma({ upsert, update }));

    const record = await repo.upsert({
      sessionToken: SESSION_TOKEN,
      placeId: PLACE_ID,
    });

    expect(record.id).toBe("session-1");
    expect(update).not.toHaveBeenCalled();
  });

  it("falls back to the update branch when a concurrent insert won", async () => {
    const upsert = vi.fn(async () => {
      throw uniqueViolation();
    });
    const update = vi.fn(async () => ({ ...ROW, humanId: "human-1" }));
    const repo = makePlaceReviewSessionsRepo(makePrisma({ upsert, update }));

    const record = await repo.upsert({
      sessionToken: SESSION_TOKEN,
      placeId: PLACE_ID,
      humanId: "human-1",
    });

    expect(record.humanId).toBe("human-1");
    expect(update).toHaveBeenCalledWith({
      where: {
        sessionToken_placeId: {
          sessionToken: SESSION_TOKEN,
          placeId: PLACE_ID,
        },
      },
      data: { humanId: "human-1" },
    });
  });

  it("still throws anything that is not a unique-constraint collision", async () => {
    const upsert = vi.fn(async () => {
      throw new Prisma.PrismaClientKnownRequestError("place is gone", {
        code: "P2003",
        clientVersion: "test",
      });
    });
    const update = vi.fn();
    const repo = makePlaceReviewSessionsRepo(makePrisma({ upsert, update }));

    await expect(
      repo.upsert({ sessionToken: SESSION_TOKEN, placeId: PLACE_ID }),
    ).rejects.toMatchObject({ code: "P2003" });
    expect(update).not.toHaveBeenCalled();
  });
});
