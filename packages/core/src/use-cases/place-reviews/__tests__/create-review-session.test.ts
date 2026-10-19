import { describe, it, expect, vi } from "vitest";
import { createReviewSession } from "../create-review-session";

const PLACE_ID = "aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION_TOKEN = "bbbb2222-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SESSION_ID = "cccc3333-cccc-4ccc-8ccc-cccccccccccc";

function makeDeps(placeExists = true) {
  return {
    repos: {
      places: {
        getById: vi
          .fn()
          .mockResolvedValue(
            placeExists
              ? { id: PLACE_ID, name: "Test Venue", communityReviewsEnabled: true }
              : null,
          ),
      },
      placeReviewSessions: {
        upsert: vi.fn().mockResolvedValue({
          id: SESSION_ID,
          sessionToken: SESSION_TOKEN,
          placeId: PLACE_ID,
          humanId: null,
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
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      },
    },
  };
}

describe("createReviewSession", () => {
  it("creates a session and returns the sessionId", async () => {
    const deps = makeDeps();
    const result = await createReviewSession(deps, {
      sessionToken: SESSION_TOKEN,
      placeId: PLACE_ID,
    });

    expect(result.sessionId).toBe(SESSION_ID);
    expect(deps.repos.placeReviewSessions.upsert).toHaveBeenCalledWith({
      sessionToken: SESSION_TOKEN,
      placeId: PLACE_ID,
      humanId: undefined,
    });
  });

  it("throws not_found when place does not exist", async () => {
    const deps = makeDeps(false);
    await expect(
      createReviewSession(deps, {
        sessionToken: SESSION_TOKEN,
        placeId: PLACE_ID,
      }),
    ).rejects.toMatchObject({ code: "PLACE_NOT_FOUND" });
  });

  it("passes humanId when provided", async () => {
    const deps = makeDeps();
    const humanId = "dddd4444-dddd-4ddd-8ddd-dddddddddddd";
    await createReviewSession(deps, {
      sessionToken: SESSION_TOKEN,
      placeId: PLACE_ID,
      humanId,
    });

    expect(deps.repos.placeReviewSessions.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ humanId }),
    );
  });
});

// ── The performer-review switch (venue-track-record-and-review-switch FR-002) ─

describe("createReviewSession — Place.communityReviewsEnabled", () => {
  function depsWithPlace(place: Record<string, unknown> | null) {
    const deps = makeDeps();
    deps.repos.places.getById.mockResolvedValue(place);
    return deps;
  }

  it("refuses with PLACE_COMMUNITY_REVIEWS_DISABLED when the switch is off, and creates NO session", async () => {
    const deps = depsWithPlace({
      id: PLACE_ID,
      name: "Fishbowl House",
      communityReviewsEnabled: false,
    });

    await expect(
      createReviewSession(deps, {
        sessionToken: SESSION_TOKEN,
        placeId: PLACE_ID,
      }),
    ).rejects.toMatchObject({ code: "PLACE_COMMUNITY_REVIEWS_DISABLED" });

    expect(deps.repos.placeReviewSessions.upsert).not.toHaveBeenCalled();
  });

  it("treats a record that cannot establish the switch as CLOSED (fail closed)", async () => {
    const deps = depsWithPlace({ id: PLACE_ID, name: "Unknown-switch venue" });

    await expect(
      createReviewSession(deps, {
        sessionToken: SESSION_TOKEN,
        placeId: PLACE_ID,
      }),
    ).rejects.toMatchObject({ code: "PLACE_COMMUNITY_REVIEWS_DISABLED" });
    expect(deps.repos.placeReviewSessions.upsert).not.toHaveBeenCalled();
  });

  it("starts the session when the switch is on", async () => {
    const deps = depsWithPlace({
      id: PLACE_ID,
      name: "Test Venue",
      communityReviewsEnabled: true,
    });

    const result = await createReviewSession(deps, {
      sessionToken: SESSION_TOKEN,
      placeId: PLACE_ID,
    });

    expect(result.sessionId).toBe(SESSION_ID);
    expect(deps.repos.placeReviewSessions.upsert).toHaveBeenCalledOnce();
  });
});
