import { describe, expect, it, vi } from "vitest";

import type { PostEventPromptRecord } from "@th/ports/repos/post-event-prompts";

import {
  dispatchPostEventPrompts,
  type DispatchPostEventPromptsDeps,
} from "../dispatch-post-event-prompts";
import {
  EVENT_ID,
  HUMAN_A,
  HUMAN_B,
  NOW,
  PLACE_ID,
  makeClock,
  makeFakePostEventPromptsRepo,
  makeLogger,
} from "./helpers";

const PLACE_NAME = "The End & Friends";

function makePrompt(
  overrides: Partial<PostEventPromptRecord> = {},
): PostEventPromptRecord {
  return {
    id: "prompt-p1",
    eventId: EVENT_ID,
    humanId: HUMAN_A,
    placeId: PLACE_ID,
    audience: "PERFORMER",
    status: "PENDING",
    attempts: 0,
    sentAt: null,
    createdAt: new Date("2026-07-14T14:00:00.000Z"),
    ...overrides,
  };
}

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: EVENT_ID,
    title: "Loud Night",
    status: "PUBLISHED",
    startsAt: new Date("2026-07-12T22:00:00.000Z"),
    endsAt: new Date("2026-07-13T04:00:00.000Z"),
    placeId: PLACE_ID,
    ...overrides,
  };
}

function createDeps(args: {
  fake: ReturnType<typeof makeFakePostEventPromptsRepo>;
  event?: ReturnType<typeof makeEvent> | null;
  place?: { id: string; name: string } | null;
  notify?: DispatchPostEventPromptsDeps["notify"];
  /** B2 verified-email lookup: default everyone verified; "throw" = read fails. */
  verified?: boolean | "throw";
}) {
  const events = {
    getById: vi.fn(async () =>
      args.event === undefined ? makeEvent() : args.event,
    ),
  };
  const places = {
    getById: vi.fn(async () =>
      args.place === undefined
        ? { id: PLACE_ID, name: PLACE_NAME }
        : args.place,
    ),
  };
  const notify = args.notify ?? vi.fn(async () => ({ ok: true }));
  const humans = {
    listEmailVerifiedIds: vi.fn(async (ids: readonly string[]) => {
      if (args.verified === "throw") throw new Error("auth read down");
      return args.verified === false ? [] : [...ids];
    }),
  };
  const logger = makeLogger();
  const reportError = vi.fn();

  const deps: DispatchPostEventPromptsDeps = {
    repos: {
      postEventPrompts: args.fake.repo,
      events,
      places,
      humans,
    } as unknown as DispatchPostEventPromptsDeps["repos"],
    notify,
    clock: makeClock(),
    // Trailing slash on purpose — the drain must trim it when building URLs.
    appBaseUrl: "https://ithasfire.com/",
    logger: logger as never,
    reportError,
  };

  return { deps, notify, events, places, humans, logger, reportError };
}

describe("dispatchPostEventPrompts", () => {
  it("pulls both DISPATCH-ENABLED audiences from the outbox (PERFORMER + ATTENDEE)", async () => {
    const fake = makeFakePostEventPromptsRepo({
      seed: [
        makePrompt({ id: "prompt-perf" }),
        makePrompt({
          id: "prompt-att",
          humanId: HUMAN_B,
          audience: "ATTENDEE",
        }),
      ],
    });
    const { deps, notify } = createDeps({ fake });

    const result = await dispatchPostEventPrompts(deps, { batchLimit: 50 });

    // Both audiences are now dispatched; filtering still happens in the QUERY.
    expect(fake.repo.listPending).toHaveBeenCalledWith({
      limit: 50,
      audiences: ["PERFORMER", "ATTENDEE"],
    });
    expect(result).toMatchObject({ processed: 2, sent: 2 });
    expect(notify).toHaveBeenCalledTimes(2);

    const attendeeRow = fake.rows.find((r) => r.id === "prompt-att")!;
    expect(attendeeRow.status).toBe("SENT");
    expect(attendeeRow.sentAt).toEqual(NOW);
  });

  it("sends in-app + email via notify with the prompt-scoped idempotency key (no channel suffix)", async () => {
    const fake = makeFakePostEventPromptsRepo({
      seed: [makePrompt()],
    });
    const { deps, notify } = createDeps({ fake });

    await dispatchPostEventPrompts(deps, {});

    expect(notify).toHaveBeenCalledWith({
      humanId: HUMAN_A,
      variant: "post-event.performer-review-prompt",
      payload: {
        eventId: EVENT_ID,
        eventTitle: "Loud Night",
        placeId: PLACE_ID,
        placeName: PLACE_NAME,
        reviewUrl:
          "https://ithasfire.com/review-a-place" +
          `?place=${encodeURIComponent(PLACE_NAME)}` +
          `&placeId=${encodeURIComponent(PLACE_ID)}` +
          "&campaign=post-gig-prompt",
      },
      // notify() claims this key itself and derives `{key}:email` /
      // `{key}:sms` internally — passing a channel-suffixed key from here
      // would collide with the parent claim (incident a3fad989).
      idempotencyKey: "post-event-prompt:prompt-p1",
    });

    const row = fake.rows[0]!;
    expect(row.status).toBe("SENT");
    expect(row.sentAt).toEqual(NOW);
  });

  it("re-running the drain sends nothing new (SENT rows are gone from the queue)", async () => {
    const fake = makeFakePostEventPromptsRepo({ seed: [makePrompt()] });
    const { deps, notify } = createDeps({ fake });

    await dispatchPostEventPrompts(deps, {});
    const second = await dispatchPostEventPrompts(deps, {});

    expect(second).toMatchObject({ processed: 0, sent: 0 });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("dead-letters without sending when the event vanished", async () => {
    const fake = makeFakePostEventPromptsRepo({ seed: [makePrompt()] });
    const { deps, notify } = createDeps({ fake, event: null });

    const result = await dispatchPostEventPrompts(deps, {});

    expect(result).toMatchObject({ skipped: 1, sent: 0 });
    expect(notify).not.toHaveBeenCalled();
    expect(fake.rows[0]!.status).toBe("FAILED");
  });

  it("dead-letters without sending when the event was CANCELLED (never solicit a review for a cancelled gig)", async () => {
    const fake = makeFakePostEventPromptsRepo({ seed: [makePrompt()] });
    const { deps, notify } = createDeps({
      fake,
      event: makeEvent({ status: "CANCELLED" }),
    });

    const result = await dispatchPostEventPrompts(deps, {});

    expect(result).toMatchObject({ skipped: 1, sent: 0 });
    expect(notify).not.toHaveBeenCalled();
    expect(fake.rows[0]!.status).toBe("FAILED");
  });

  it("dead-letters without sending when the prompt has no resolvable place", async () => {
    const fake = makeFakePostEventPromptsRepo({
      seed: [makePrompt({ placeId: null })],
    });
    const { deps, notify, places } = createDeps({ fake });

    const result = await dispatchPostEventPrompts(deps, {});

    expect(result).toMatchObject({ skipped: 1, sent: 0 });
    expect(places.getById).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(fake.rows[0]!.status).toBe("FAILED");
  });

  it("retries a failed send, then dead-letters at maxAttempts with a Sentry report", async () => {
    const fake = makeFakePostEventPromptsRepo({ seed: [makePrompt()] });
    const boom = new Error("smtp down");
    const notify = vi.fn(async () => {
      throw boom;
    });
    const { deps, logger, reportError } = createDeps({ fake, notify });

    // maxAttempts 2: first run bumps attempts (retry), second dead-letters.
    const first = await dispatchPostEventPrompts(deps, { maxAttempts: 2 });
    expect(first).toMatchObject({ processed: 1, sent: 0, deadLettered: 0 });
    expect(fake.rows[0]!.status).toBe("PENDING");
    expect(fake.rows[0]!.attempts).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "postEventPrompts.dispatch.retry",
      expect.objectContaining({ promptId: "prompt-p1", attempts: 1 }),
    );

    const second = await dispatchPostEventPrompts(deps, { maxAttempts: 2 });
    expect(second).toMatchObject({ processed: 1, deadLettered: 1 });
    expect(fake.rows[0]!.status).toBe("FAILED");
    expect(logger.error).toHaveBeenCalledWith(
      "postEventPrompts.dispatch.dead_letter",
      expect.objectContaining({ promptId: "prompt-p1", attempts: 2 }),
    );
    expect(reportError).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({
        tags: expect.objectContaining({
          useCase: "dispatchPostEventPrompts",
          promptId: "prompt-p1",
          outcome: "dead_letter",
        }),
      }),
    );
  });

  it("one bad prompt never aborts the batch (unhandled escape is reported)", async () => {
    const fake = makeFakePostEventPromptsRepo({
      seed: [
        makePrompt({ id: "prompt-bad" }),
        makePrompt({ id: "prompt-good", humanId: HUMAN_B }),
      ],
    });
    const boom = new Error("bookkeeping exploded");
    // Even the failure-handling path throws — the outer guard must contain it.
    (
      fake.repo.incrementAttempts as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(boom);
    const notify = vi
      .fn(async () => ({ ok: true }))
      .mockRejectedValueOnce(new Error("send failed"));
    const { deps, reportError } = createDeps({ fake, notify });

    const result = await dispatchPostEventPrompts(deps, {});

    expect(result).toMatchObject({ processed: 2, sent: 1 });
    expect(fake.rows.find((r) => r.id === "prompt-good")!.status).toBe("SENT");
    expect(reportError).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({
        tags: expect.objectContaining({
          useCase: "dispatchPostEventPrompts",
          promptId: "prompt-bad",
        }),
      }),
    );
  });

  it("a throwing reporter never changes behaviour", async () => {
    const fake = makeFakePostEventPromptsRepo({ seed: [makePrompt()] });
    (
      fake.repo.incrementAttempts as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("bookkeeping exploded"));
    const notify = vi.fn(async () => {
      throw new Error("send failed");
    });
    const { deps, reportError } = createDeps({ fake, notify });
    reportError.mockImplementation(() => {
      throw new Error("sentry down");
    });

    await expect(dispatchPostEventPrompts(deps, {})).resolves.toMatchObject({
      processed: 1,
    });
  });

  // ── ATTENDEE audience (attendee-reviews FR-006 / FR-008) ──────────────────

  const DAY_MS = 24 * 60 * 60 * 1000;

  function makeAttendeePrompt(
    overrides: Partial<PostEventPromptRecord> = {},
  ): PostEventPromptRecord {
    return makePrompt({
      id: "prompt-att",
      humanId: HUMAN_B,
      audience: "ATTENDEE",
      ...overrides,
    });
  }

  it("sends the attendee variant to the /review-event deep link with the un-suffixed idempotency key", async () => {
    const fake = makeFakePostEventPromptsRepo({ seed: [makeAttendeePrompt()] });
    const { deps, notify } = createDeps({ fake });

    await dispatchPostEventPrompts(deps, {});

    expect(notify).toHaveBeenCalledWith({
      humanId: HUMAN_B,
      variant: "post-event.attendee-review-prompt",
      payload: {
        eventId: EVENT_ID,
        eventTitle: "Loud Night",
        placeName: PLACE_NAME,
        reviewUrl:
          `https://ithasfire.com/review-event/${EVENT_ID}` +
          "?campaign=post-event-prompt",
      },
      // FR-001: attendee prompt is IN-APP ONLY; email moved to the weekly digest.
      channels: { email: { enabled: false } },
      // notify() derives `{key}:email` / `{key}:sms` — never suffix here.
      idempotencyKey: "post-event-prompt:prompt-att",
    });

    const row = fake.rows[0]!;
    expect(row.status).toBe("SENT");
    expect(row.sentAt).toEqual(NOW);
  });

  it("FR-001: attendee prompt disables email (in-app only); performer keeps email", async () => {
    const fake = makeFakePostEventPromptsRepo({
      seed: [makePrompt(), makeAttendeePrompt()],
    });
    const { deps, notify } = createDeps({ fake });

    await dispatchPostEventPrompts(deps, {});

    const performerCall = notify.mock.calls.find(
      ([arg]) => arg.variant === "post-event.performer-review-prompt",
    )![0];
    const attendeeCall = notify.mock.calls.find(
      ([arg]) => arg.variant === "post-event.attendee-review-prompt",
    )![0];

    // Attendee: email channel forced off → digest owns the email.
    expect(attendeeCall.channels).toEqual({ email: { enabled: false } });
    // Performer: no channel override → notify sends in-app + email as before.
    expect(performerCall.channels).toBeUndefined();
  });

  it("omits placeName when the attendee prompt has no resolvable place (no dead-letter)", async () => {
    const fake = makeFakePostEventPromptsRepo({
      seed: [makeAttendeePrompt({ placeId: null })],
    });
    const { deps, notify, places } = createDeps({ fake });

    const result = await dispatchPostEventPrompts(deps, {});

    expect(places.getById).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: "post-event.attendee-review-prompt",
        payload: {
          eventId: EVENT_ID,
          eventTitle: "Loud Night",
          reviewUrl:
            `https://ithasfire.com/review-event/${EVENT_ID}` +
            "?campaign=post-event-prompt",
        },
        // FR-001: attendee prompt email is off; the weekly digest owns email.
        channels: { email: { enabled: false } },
      }),
    );
    expect(result).toMatchObject({ sent: 1, skipped: 0 });
    expect(fake.rows[0]!.status).toBe("SENT");
  });

  it("dead-letters an attendee prompt whose event vanished (same as performer)", async () => {
    const fake = makeFakePostEventPromptsRepo({ seed: [makeAttendeePrompt()] });
    const { deps, notify } = createDeps({ fake, event: null });

    const result = await dispatchPostEventPrompts(deps, {});

    expect(result).toMatchObject({ skipped: 1, sent: 0 });
    expect(notify).not.toHaveBeenCalled();
    expect(fake.rows[0]!.status).toBe("FAILED");
  });

  it("sends at the age-gate boundary (29 days after the event still ok)", async () => {
    const fake = makeFakePostEventPromptsRepo({ seed: [makeAttendeePrompt()] });
    const endsAt = new Date(NOW.getTime() - 29 * DAY_MS);
    const { deps, notify } = createDeps({
      fake,
      event: makeEvent({ endsAt }),
    });

    const result = await dispatchPostEventPrompts(deps, {});

    expect(result).toMatchObject({ sent: 1, expired: 0 });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(fake.rows[0]!.status).toBe("SENT");
  });

  it("age-gates (dead-letters) an attendee prompt whose review window closed (31 days) without sending", async () => {
    const fake = makeFakePostEventPromptsRepo({ seed: [makeAttendeePrompt()] });
    const endsAt = new Date(NOW.getTime() - 31 * DAY_MS);
    const { deps, notify } = createDeps({
      fake,
      event: makeEvent({ endsAt }),
    });

    const result = await dispatchPostEventPrompts(deps, {});

    expect(result).toMatchObject({ expired: 1, sent: 0, skipped: 0 });
    expect(notify).not.toHaveBeenCalled();
    expect(fake.rows[0]!.status).toBe("FAILED");
  });

  it("falls back to startsAt for the age gate when endsAt is null", async () => {
    const fake = makeFakePostEventPromptsRepo({ seed: [makeAttendeePrompt()] });
    const startsAt = new Date(NOW.getTime() - 31 * DAY_MS);
    const { deps, notify } = createDeps({
      fake,
      event: makeEvent({ endsAt: null, startsAt }),
    });

    const result = await dispatchPostEventPrompts(deps, {});

    expect(result).toMatchObject({ expired: 1, sent: 0 });
    expect(notify).not.toHaveBeenCalled();
    expect(fake.rows[0]!.status).toBe("FAILED");
  });

  it("dispatch-time precedence: dead-letters an ATTENDEE prompt whose human also holds a PERFORMER prompt", async () => {
    const fake = makeFakePostEventPromptsRepo({
      seed: [
        // Same (eventId, humanId), both audiences — a late lineup edit.
        makePrompt({ id: "prompt-perf", humanId: HUMAN_B }),
        makeAttendeePrompt({ id: "prompt-att", humanId: HUMAN_B }),
      ],
    });
    const { deps, notify } = createDeps({ fake });

    const result = await dispatchPostEventPrompts(deps, {});

    // Performer sends; attendee is superseded (dead-lettered, no send).
    expect(result).toMatchObject({ sent: 1, superseded: 1 });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: "post-event.performer-review-prompt",
      }),
    );

    const attendeeRow = fake.rows.find((r) => r.id === "prompt-att")!;
    expect(attendeeRow.status).toBe("FAILED");
    const performerRow = fake.rows.find((r) => r.id === "prompt-perf")!;
    expect(performerRow.status).toBe("SENT");
  });

  it("retries then dead-letters an attendee send failure with a Sentry report", async () => {
    const fake = makeFakePostEventPromptsRepo({ seed: [makeAttendeePrompt()] });
    const boom = new Error("smtp down");
    const notify = vi.fn(async () => {
      throw boom;
    });
    const { deps, reportError } = createDeps({ fake, notify });

    const first = await dispatchPostEventPrompts(deps, { maxAttempts: 1 });
    expect(first).toMatchObject({ deadLettered: 1, sent: 0 });
    expect(fake.rows[0]!.status).toBe("FAILED");
    expect(reportError).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({
        tags: expect.objectContaining({
          useCase: "dispatchPostEventPrompts",
          outcome: "dead_letter",
        }),
      }),
    );
  });
});

describe("dispatchPostEventPrompts — B2: attendee in-app only to a verified account", () => {
  const attendee = (overrides: Partial<PostEventPromptRecord> = {}) =>
    makePrompt({ id: "prompt-att", humanId: HUMAN_B, audience: "ATTENDEE", ...overrides });
  const ALL_OFF = {
    email: { enabled: false },
    inApp: { enabled: false },
    push: { enabled: false },
    sms: { enabled: false },
  };

  it("a verified attendee keeps in-app (email off as always)", async () => {
    const fake = makeFakePostEventPromptsRepo({ seed: [attendee()] });
    const { deps, notify, humans, reportError } = createDeps({ fake, verified: true });
    const out = await dispatchPostEventPrompts(deps, {});
    expect(out.suppressedUnverified).toBe(0);
    expect(humans.listEmailVerifiedIds).toHaveBeenCalledWith([HUMAN_B]);
    expect((notify as any).mock.calls[0][0].channels).toEqual({
      email: { enabled: false },
    });
    expect(fake.rows[0]!.status).toBe("SENT");
    expect(reportError).not.toHaveBeenCalled();
  });

  it("an unverified attendee gets no in-app or push; the prompt still settles", async () => {
    const fake = makeFakePostEventPromptsRepo({ seed: [attendee()] });
    const { deps, notify, reportError } = createDeps({ fake, verified: false });
    const out = await dispatchPostEventPrompts(deps, {});
    expect((notify as any).mock.calls[0][0].channels).toEqual(ALL_OFF);
    expect(fake.rows[0]!.status).toBe("SENT");
    expect(out.suppressedUnverified).toBe(1);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("a failed lookup sends nothing and leaves the prompt retryable; ERROR-logs and reports", async () => {
    const fake = makeFakePostEventPromptsRepo({ seed: [attendee()] });
    const { deps, notify, logger, reportError } = createDeps({ fake, verified: "throw" });
    const out = await dispatchPostEventPrompts(deps, {});
    expect(notify).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "postEventPrompts.dispatch.verified_lookup_failed",
      expect.objectContaining({ promptId: "prompt-att", eventId: EVENT_ID }),
    );
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { useCase: "dispatchPostEventPrompts", reason: "verified-lookup-failed" },
      }),
    );
    expect(fake.rows[0]!.status).toBe("PENDING");
    expect(fake.rows[0]!.attempts).toBe(1);
    expect(out.sent).toBe(0);
    expect(out.suppressedUnverified).toBe(0);
  });

  it("a failed lookup at the last attempt dead-letters (reported)", async () => {
    const fake = makeFakePostEventPromptsRepo({ seed: [attendee({ attempts: 4 })] });
    const { deps, notify, reportError } = createDeps({ fake, verified: "throw" });
    const out = await dispatchPostEventPrompts(deps, {});
    expect(notify).not.toHaveBeenCalled();
    expect(fake.rows[0]!.status).toBe("FAILED");
    expect(out.deadLettered).toBe(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: expect.objectContaining({ outcome: "dead_letter" }) }),
    );
  });

  it("a throwing reporter does not change the outcome", async () => {
    const fake = makeFakePostEventPromptsRepo({ seed: [attendee()] });
    const { deps, notify, reportError } = createDeps({ fake, verified: "throw" });
    reportError.mockImplementation(() => {
      throw new Error("sentry down");
    });
    const out = await dispatchPostEventPrompts(deps, {});
    expect(notify).not.toHaveBeenCalled();
    expect(out.sent).toBe(0);
    expect(fake.rows[0]!.status).toBe("PENDING");
    expect(fake.rows[0]!.attempts).toBe(1);
  });
});

describe("dispatchPostEventPrompts — B2: performer in-app and push only to a verified account", () => {
  const EMAIL_ONLY = {
    inApp: { enabled: false },
    push: { enabled: false },
    sms: { enabled: false },
  };

  it("a verified performer keeps every channel (no override)", async () => {
    const fake = makeFakePostEventPromptsRepo({ seed: [makePrompt()] });
    const { deps, notify, humans, reportError } = createDeps({ fake, verified: true });
    const out = await dispatchPostEventPrompts(deps, {});
    expect(humans.listEmailVerifiedIds).toHaveBeenCalledWith([HUMAN_A]);
    expect((notify as any).mock.calls[0][0]).not.toHaveProperty("channels");
    expect(out.suppressedUnverified).toBe(0);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("an unverified performer gets no in-app or push; counted as suppressed", async () => {
    const fake = makeFakePostEventPromptsRepo({ seed: [makePrompt()] });
    const { deps, notify, logger, reportError } = createDeps({ fake, verified: false });
    const out = await dispatchPostEventPrompts(deps, {});
    expect((notify as any).mock.calls[0][0].channels).toEqual(EMAIL_ONLY);
    expect(fake.rows[0]!.status).toBe("SENT");
    expect(out.suppressedUnverified).toBe(1);
    expect(logger.info).toHaveBeenCalledWith(
      "postEventPrompts.dispatch.in_app_withheld_unverified",
      expect.objectContaining({ promptId: "prompt-p1", audience: "PERFORMER" }),
    );
    expect(reportError).not.toHaveBeenCalled();
  });

  it("a failed lookup sends nothing and leaves the prompt retryable; ERROR-logs and reports", async () => {
    const fake = makeFakePostEventPromptsRepo({ seed: [makePrompt()] });
    const { deps, notify, logger, reportError } = createDeps({ fake, verified: "throw" });
    const out = await dispatchPostEventPrompts(deps, {});
    expect(notify).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "postEventPrompts.dispatch.verified_lookup_failed",
      expect.objectContaining({ promptId: "prompt-p1", eventId: EVENT_ID }),
    );
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { useCase: "dispatchPostEventPrompts", reason: "verified-lookup-failed" },
      }),
    );
    expect(fake.rows[0]!.status).toBe("PENDING");
    expect(fake.rows[0]!.attempts).toBe(1);
    expect(out.sent).toBe(0);
    expect(out.suppressedUnverified).toBe(0);
  });

  it("a failed lookup at the last attempt dead-letters (reported)", async () => {
    const fake = makeFakePostEventPromptsRepo({ seed: [makePrompt({ attempts: 4 })] });
    const { deps, notify, reportError } = createDeps({ fake, verified: "throw" });
    const out = await dispatchPostEventPrompts(deps, {});
    expect(notify).not.toHaveBeenCalled();
    expect(fake.rows[0]!.status).toBe("FAILED");
    expect(out.deadLettered).toBe(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: expect.objectContaining({ outcome: "dead_letter" }) }),
    );
  });

  it("a throwing reporter does not change the outcome", async () => {
    const fake = makeFakePostEventPromptsRepo({ seed: [makePrompt()] });
    const { deps, notify, reportError } = createDeps({ fake, verified: "throw" });
    reportError.mockImplementation(() => {
      throw new Error("sentry down");
    });
    const out = await dispatchPostEventPrompts(deps, {});
    expect(notify).not.toHaveBeenCalled();
    expect(out.sent).toBe(0);
    expect(fake.rows[0]!.status).toBe("PENDING");
    expect(fake.rows[0]!.attempts).toBe(1);
  });
});
