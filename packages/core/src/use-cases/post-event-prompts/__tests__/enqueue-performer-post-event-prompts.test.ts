import { describe, expect, it, vi } from "vitest";

import { enqueuePerformerPostEventPrompts } from "../enqueue-performer-post-event-prompts";
import {
  EVENT_ID,
  EVENT_ID_2,
  HUMAN_A,
  HUMAN_B,
  HUMAN_C,
  NOW,
  ORG_ID,
  PLACE_ID,
  makeClock,
  makeFakePostEventPromptsRepo,
  makeGigCandidate,
  makeLogger,
} from "./helpers";

function makeDeps(fake: ReturnType<typeof makeFakePostEventPromptsRepo>) {
  const logger = makeLogger();
  const reportError = vi.fn();
  return {
    deps: {
      repos: { postEventPrompts: fake.repo },
      clock: makeClock(),
      logger: logger as never,
      reportError,
    },
    logger,
    reportError,
  };
}

describe("enqueuePerformerPostEventPrompts", () => {
  it("enqueues one PERFORMER prompt per performer human (lineup ∪ human sender, deduped)", async () => {
    const fake = makeFakePostEventPromptsRepo({
      gigCandidates: [
        makeGigCandidate({
          performerOwnerType: "human",
          performerOwnerId: HUMAN_A,
          // HUMAN_A also on the lineup — must not double-prompt.
          lineupHumanIds: [HUMAN_A, HUMAN_B, HUMAN_C],
        }),
      ],
    });
    const { deps } = makeDeps(fake);

    const result = await enqueuePerformerPostEventPrompts(deps, {});

    expect(result).toMatchObject({ candidates: 1, enqueued: 3, failed: 0 });
    expect(fake.rows).toHaveLength(3);
    expect(new Set(fake.rows.map((r) => r.humanId))).toEqual(
      new Set([HUMAN_A, HUMAN_B, HUMAN_C]),
    );
    for (const row of fake.rows) {
      expect(row).toMatchObject({
        eventId: EVENT_ID,
        placeId: PLACE_ID,
        audience: "PERFORMER",
        status: "PENDING",
      });
    }
  });

  it("passes a bounded lookback window to the candidate query", async () => {
    const fake = makeFakePostEventPromptsRepo();
    const { deps } = makeDeps(fake);

    await enqueuePerformerPostEventPrompts(deps, { lookbackDays: 7 });

    expect(fake.repo.listPerformerGigCandidates).toHaveBeenCalledWith({
      endedAfter: new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000),
      endedBefore: NOW,
    });
  });

  it("is idempotent: a re-run against the same candidates enqueues nothing", async () => {
    const fake = makeFakePostEventPromptsRepo({
      gigCandidates: [
        makeGigCandidate({ lineupHumanIds: [HUMAN_A, HUMAN_B] }),
      ],
    });
    const { deps } = makeDeps(fake);

    const first = await enqueuePerformerPostEventPrompts(deps, {});
    const second = await enqueuePerformerPostEventPrompts(deps, {});

    expect(first.enqueued).toBe(2);
    expect(second.enqueued).toBe(0);
    expect(fake.rows).toHaveLength(2);
  });

  it("skips CANCELLED events even if the candidate query leaked one", async () => {
    const fake = makeFakePostEventPromptsRepo({
      gigCandidates: [
        makeGigCandidate({ eventStatus: "CANCELLED" }),
        makeGigCandidate({
          bookingRequestId: "br-2",
          eventId: EVENT_ID_2,
          performerOwnerType: "organization",
          performerOwnerId: ORG_ID,
          lineupHumanIds: [HUMAN_B],
        }),
      ],
    });
    const { deps } = makeDeps(fake);

    const result = await enqueuePerformerPostEventPrompts(deps, {});

    expect(result).toMatchObject({ skippedIneligible: 1, enqueued: 1 });
    expect(fake.rows.map((r) => r.eventId)).toEqual([EVENT_ID_2]);
  });

  it("skips org-sender gigs with no registered lineup humans (nothing to guess)", async () => {
    const fake = makeFakePostEventPromptsRepo({
      gigCandidates: [
        makeGigCandidate({
          performerOwnerType: "organization",
          performerOwnerId: ORG_ID,
          lineupHumanIds: [],
        }),
      ],
    });
    const { deps } = makeDeps(fake);

    const result = await enqueuePerformerPostEventPrompts(deps, {});

    expect(result).toMatchObject({ skippedNoPerformers: 1, enqueued: 0 });
    expect(fake.rows).toHaveLength(0);
  });

  it("uses the org gig's lineup humans when the sender is an organization", async () => {
    const fake = makeFakePostEventPromptsRepo({
      gigCandidates: [
        makeGigCandidate({
          performerOwnerType: "organization",
          performerOwnerId: ORG_ID,
          lineupHumanIds: [HUMAN_B, HUMAN_C],
        }),
      ],
    });
    const { deps } = makeDeps(fake);

    const result = await enqueuePerformerPostEventPrompts(deps, {});

    expect(result.enqueued).toBe(2);
    // The org id itself must never be enqueued as a humanId.
    expect(fake.rows.map((r) => r.humanId)).not.toContain(ORG_ID);
  });

  it("isolates per-candidate failures: logs, reports to Sentry, keeps sweeping", async () => {
    const fake = makeFakePostEventPromptsRepo({
      gigCandidates: [
        makeGigCandidate({ lineupHumanIds: [HUMAN_A] }),
        makeGigCandidate({
          bookingRequestId: "br-2",
          eventId: EVENT_ID_2,
          performerOwnerType: "organization",
          performerOwnerId: ORG_ID,
          lineupHumanIds: [HUMAN_B],
        }),
      ],
    });
    const boom = new Error("insert exploded");
    (
      fake.repo.createManySkipExisting as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(boom);
    const { deps, logger, reportError } = makeDeps(fake);

    const result = await enqueuePerformerPostEventPrompts(deps, {});

    expect(result).toMatchObject({ failed: 1, enqueued: 1 });
    expect(logger.error).toHaveBeenCalledWith(
      "postEventPrompts.enqueuePerformer.candidate_failed",
      expect.objectContaining({ eventId: EVENT_ID }),
    );
    expect(reportError).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({
        tags: expect.objectContaining({
          useCase: "enqueuePerformerPostEventPrompts",
          eventId: EVENT_ID,
        }),
      }),
    );
  });

  it("a throwing reporter never changes behaviour", async () => {
    const fake = makeFakePostEventPromptsRepo({
      gigCandidates: [makeGigCandidate({ lineupHumanIds: [HUMAN_A] })],
    });
    (
      fake.repo.createManySkipExisting as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("insert exploded"));
    const { deps, reportError } = makeDeps(fake);
    reportError.mockImplementation(() => {
      throw new Error("sentry down");
    });

    await expect(
      enqueuePerformerPostEventPrompts(deps, {}),
    ).resolves.toMatchObject({ failed: 1 });
  });
});
