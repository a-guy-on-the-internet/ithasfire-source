import { describe, expect, it, vi } from "vitest";

import { enqueueAttendeePostEventPrompts } from "../enqueue-attendee-post-event-prompts";
import { enqueuePerformerPostEventPrompts } from "../enqueue-performer-post-event-prompts";
import {
  EVENT_ID,
  EVENT_ID_2,
  HUMAN_A,
  HUMAN_B,
  HUMAN_C,
  PLACE_ID,
  makeAttendeeCandidate,
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

describe("enqueueAttendeePostEventPrompts", () => {
  it("enqueues one ATTENDEE prompt per distinct scanned ticket holder", async () => {
    const fake = makeFakePostEventPromptsRepo({
      attendeeCandidates: [makeAttendeeCandidate()],
      // Duplicate holder id — must collapse to one prompt.
      scannedByEvent: { [EVENT_ID]: [HUMAN_A, HUMAN_B, HUMAN_A] },
    });
    const { deps } = makeDeps(fake);

    const result = await enqueueAttendeePostEventPrompts(deps, {});

    expect(result).toMatchObject({ candidates: 1, enqueued: 2, failed: 0 });
    expect(new Set(fake.rows.map((r) => r.humanId))).toEqual(
      new Set([HUMAN_A, HUMAN_B]),
    );
    for (const row of fake.rows) {
      expect(row).toMatchObject({
        eventId: EVENT_ID,
        placeId: PLACE_ID,
        audience: "ATTENDEE",
        status: "PENDING",
      });
    }
  });

  it("AUDIENCE PRECEDENCE: a human with a PERFORMER prompt never gets the ATTENDEE one", async () => {
    const fake = makeFakePostEventPromptsRepo({
      gigCandidates: [
        makeGigCandidate({ lineupHumanIds: [HUMAN_A] }),
      ],
      attendeeCandidates: [makeAttendeeCandidate()],
      // The performer scanned in too (played AND attended).
      scannedByEvent: { [EVENT_ID]: [HUMAN_A, HUMAN_B] },
    });
    const { deps } = makeDeps(fake);

    // Jobs layer ordering: performer sweep FIRST, then attendee.
    await enqueuePerformerPostEventPrompts(deps, {});
    const result = await enqueueAttendeePostEventPrompts(deps, {});

    expect(result).toMatchObject({ enqueued: 1, excludedPerformers: 1 });
    const attendeeRows = fake.rows.filter((r) => r.audience === "ATTENDEE");
    expect(attendeeRows.map((r) => r.humanId)).toEqual([HUMAN_B]);
    // HUMAN_A holds exactly ONE prompt for the event — the performer one.
    expect(
      fake.rows.filter((r) => r.humanId === HUMAN_A).map((r) => r.audience),
    ).toEqual(["PERFORMER"]);
  });

  it("is idempotent: re-running both sweeps enqueues nothing new", async () => {
    const fake = makeFakePostEventPromptsRepo({
      attendeeCandidates: [makeAttendeeCandidate()],
      scannedByEvent: { [EVENT_ID]: [HUMAN_A, HUMAN_B] },
    });
    const { deps } = makeDeps(fake);

    const first = await enqueueAttendeePostEventPrompts(deps, {});
    const second = await enqueueAttendeePostEventPrompts(deps, {});

    expect(first.enqueued).toBe(2);
    expect(second.enqueued).toBe(0);
    expect(fake.rows).toHaveLength(2);
  });

  it("skips CANCELLED events even if the candidate query leaked one", async () => {
    const fake = makeFakePostEventPromptsRepo({
      attendeeCandidates: [
        makeAttendeeCandidate({ eventStatus: "CANCELLED" }),
        makeAttendeeCandidate({ eventId: EVENT_ID_2 }),
      ],
      scannedByEvent: {
        [EVENT_ID]: [HUMAN_A],
        [EVENT_ID_2]: [HUMAN_C],
      },
    });
    const { deps } = makeDeps(fake);

    const result = await enqueueAttendeePostEventPrompts(deps, {});

    expect(result).toMatchObject({ skippedIneligible: 1, enqueued: 1 });
    expect(fake.rows.map((r) => r.eventId)).toEqual([EVENT_ID_2]);
  });

  it("isolates per-event failures: logs, reports to Sentry, keeps sweeping", async () => {
    const fake = makeFakePostEventPromptsRepo({
      attendeeCandidates: [
        makeAttendeeCandidate(),
        makeAttendeeCandidate({ eventId: EVENT_ID_2 }),
      ],
      scannedByEvent: {
        [EVENT_ID]: [HUMAN_A],
        [EVENT_ID_2]: [HUMAN_B],
      },
    });
    const boom = new Error("scan lookup exploded");
    (
      fake.repo.scannedTicketHolderHumanIds as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(boom);
    const { deps, logger, reportError } = makeDeps(fake);

    const result = await enqueueAttendeePostEventPrompts(deps, {});

    expect(result).toMatchObject({ failed: 1, enqueued: 1 });
    expect(fake.rows.map((r) => r.eventId)).toEqual([EVENT_ID_2]);
    expect(logger.error).toHaveBeenCalledWith(
      "postEventPrompts.enqueueAttendee.candidate_failed",
      expect.objectContaining({ eventId: EVENT_ID }),
    );
    expect(reportError).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({
        tags: expect.objectContaining({
          useCase: "enqueueAttendeePostEventPrompts",
          eventId: EVENT_ID,
        }),
      }),
    );
  });

  it("a throwing reporter never changes behaviour", async () => {
    const fake = makeFakePostEventPromptsRepo({
      attendeeCandidates: [makeAttendeeCandidate()],
      scannedByEvent: { [EVENT_ID]: [HUMAN_A] },
    });
    (
      fake.repo.scannedTicketHolderHumanIds as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("boom"));
    const { deps, reportError } = makeDeps(fake);
    reportError.mockImplementation(() => {
      throw new Error("sentry down");
    });

    await expect(
      enqueueAttendeePostEventPrompts(deps, {}),
    ).resolves.toMatchObject({ failed: 1 });
  });
});
