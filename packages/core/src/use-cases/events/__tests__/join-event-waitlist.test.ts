import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type {
  EventRecord,
  EventWaitlistEntryRecord,
} from "@th/ports/repos/events";

import { joinEventWaitlist } from "../join-event-waitlist";
import type { JoinEventWaitlistDeps } from "../join-event-waitlist";

const EVENT_ID = "7b6da58f-7d44-4c5c-8ae4-930de0a54e5f";
const VIEWER_ID = "5db5598c-9c68-46db-8474-7b77b51ed245";
const NOW = new Date("2025-01-15T12:00:00Z");

function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: EVENT_ID,
    orgId: "560c1f10-7930-4ad6-a6e7-09016c7f4d5e",
    humanId: "6811a997-5cf6-41a6-92d7-8c205b5b6185",
    title: "Future Party",
    status: "PUBLISHED",
    visibility: "PUBLIC",
    gateType: "NONE",
    locationMode: "EXACT",
    locationRadiusMeters: null,
    locationLabel: null,
    addressRevealAt: null,
    addressRevealPreset: null,
    startsAt: new Date("2025-02-01T18:00:00Z"),
    endsAt: null,
    placeId: null,
    savedLocationId: null,
    categoryId: null,
    addressText: "123 Main",
    lat: 37.7749,
    lng: -122.4194,
    slug: "future-party",
    shortId: "FP123",
    regionCode: "US-CA",
    publishedAt: new Date("2025-01-01T00:00:00Z"),
    agreementPrimaryId: "91c5d9f0-7c06-45e7-bf70-9241a2c7a517",
    agreementResaleId: null,
    defaultLocale: "en-US",
    listingPriority: null,
    passwordHash: null,
    passwordUpdatedAt: null,
    waitlistStatus: "OPEN",
    waitlistPublishAt: null,
    waitlistDescription: null,
    waitlistCap: null,
    payoutTermsId: null,
    resalePayoutTermsId: null,
    placeLayoutId: null,
    ...overrides,
  } satisfies EventRecord;
}

function makeDeps(initialEvent?: EventRecord) {
  const event = initialEvent ?? makeEvent();
  const waitlistEntries: EventWaitlistEntryRecord[] = [];
  const makeEntryId = () => randomUUID();

  const repos = {
    events: {
      getById: vi.fn(async (id: string) =>
        id === event.id ? { ...event } : null,
      ),
    },
    eventWaitlists: {
      createEntry: vi.fn(
        async ({
          eventId,
          humanId,
          contactEmail,
          contactPhone,
          source,
          status,
          metadata,
        }) => {
          const record: EventWaitlistEntryRecord = {
            id: makeEntryId(),
            eventId,
            humanId: humanId ?? null,
            contactEmail: contactEmail ?? null,
            contactPhone: contactPhone ?? null,
            source,
            status: status ?? "PENDING",
            metadata: metadata ?? {},
            notifiedAt: null,
            convertedOrderId: null,
            createdAt: new Date(NOW.getTime() + waitlistEntries.length + 1),
            updatedAt: new Date(NOW.getTime() + waitlistEntries.length + 1),
          };
          waitlistEntries.push(record);
          return record;
        },
      ),
      updateEntry: vi.fn(async (input) => {
        const record = waitlistEntries.find(
          (entry) => entry.id === input.entryId,
        );
        if (!record) throw new Error(`no waitlist entry ${input.entryId}`);
        record.status = input.status;
        if (Object.prototype.hasOwnProperty.call(input, "metadata")) {
          record.metadata = input.metadata ?? {};
        }
        record.updatedAt = input.updatedAt;
        return { ...record };
      }),
      findEntry: vi.fn(
        async (input) =>
          waitlistEntries.find((entry) => {
            if (entry.eventId !== input.eventId) return false;
            if (input.humanId && entry.humanId !== input.humanId) return false;
            if (input.contactEmail && entry.contactEmail !== input.contactEmail)
              return false;
            if (input.contactPhone && entry.contactPhone !== input.contactPhone)
              return false;
            return true;
          }) ?? null,
      ),
      listEntries: vi.fn(
        async ({ eventId, statuses, limit = 50, offset = 0 }) => {
          const filtered = waitlistEntries.filter(
            (entry) =>
              entry.eventId === eventId &&
              (!statuses?.length || statuses.includes(entry.status)),
          );
          return filtered.slice(offset, offset + limit);
        },
      ),
    },
  } as unknown as JoinEventWaitlistDeps["repos"];

  const deps: JoinEventWaitlistDeps = {
    repos,
    clock: { now: () => NOW },
    logger: undefined,
  };

  return { deps, event, waitlistEntries } as const;
}

describe("joinEventWaitlist", () => {
  it("creates a new waitlist entry when open", async () => {
    const { deps } = makeDeps();

    const result = await joinEventWaitlist(deps, {
      eventId: EVENT_ID,
      viewerHumanId: VIEWER_ID,
      contactEmail: "viewer@example.com",
      metadata: { ref: "cta" },
    });

    expect(result.alreadyJoined).toBe(false);
    expect(result.entry.humanId).toBe(VIEWER_ID);
    expect(result.entry.metadata).toEqual({ ref: "cta" });
  });

  it("deduplicates existing entries", async () => {
    const { deps } = makeDeps();

    const first = await joinEventWaitlist(deps, {
      eventId: EVENT_ID,
      viewerHumanId: VIEWER_ID,
      contactEmail: "viewer@example.com",
    });
    const second = await joinEventWaitlist(deps, {
      eventId: EVENT_ID,
      viewerHumanId: VIEWER_ID,
      contactEmail: "viewer@example.com",
    });

    expect(first.alreadyJoined).toBe(false);
    expect(second.alreadyJoined).toBe(true);
    expect(second.entry.id).toBe(first.entry.id);
  });

  it("stamps publicJoinedAt on a pre-existing entry — durable proof of independent intent", async () => {
    const { deps, waitlistEntries } = makeDeps();

    // An application WAITLISTED decision created this entry; the applicant
    // then joins via the gate's form. Without the stamp this branch is a
    // pure no-op and a later rescind would DROP an entry they asked for.
    waitlistEntries.push({
      id: "e0000000-0000-4000-8000-00000000000e",
      eventId: EVENT_ID,
      humanId: VIEWER_ID,
      contactEmail: "viewer@example.com",
      contactPhone: null,
      source: "APPLICATION",
      status: "PENDING",
      metadata: { submissionId: "sub-1" },
      notifiedAt: null,
      convertedOrderId: null,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const result = await joinEventWaitlist(deps, {
      eventId: EVENT_ID,
      viewerHumanId: VIEWER_ID,
      contactEmail: "viewer@example.com",
    });

    expect(result.alreadyJoined).toBe(true);
    // Status + existing metadata preserved, marker added.
    expect(deps.repos.eventWaitlists.updateEntry).toHaveBeenCalledWith({
      entryId: "e0000000-0000-4000-8000-00000000000e",
      status: "PENDING",
      metadata: {
        submissionId: "sub-1",
        publicJoinedAt: NOW.toISOString(),
      },
      updatedAt: NOW,
    });
    expect(result.entry.metadata.publicJoinedAt).toBe(NOW.toISOString());
  });

  it("does not re-stamp (or re-write) an already-stamped entry", async () => {
    const { deps } = makeDeps();

    await joinEventWaitlist(deps, {
      eventId: EVENT_ID,
      viewerHumanId: VIEWER_ID,
      contactEmail: "viewer@example.com",
    });
    // First repeat join stamps; the second must be a true no-op write-wise.
    await joinEventWaitlist(deps, {
      eventId: EVENT_ID,
      viewerHumanId: VIEWER_ID,
      contactEmail: "viewer@example.com",
    });
    await joinEventWaitlist(deps, {
      eventId: EVENT_ID,
      viewerHumanId: VIEWER_ID,
      contactEmail: "viewer@example.com",
    });

    expect(deps.repos.eventWaitlists.updateEntry).toHaveBeenCalledTimes(1);
  });

  it("rejects when waitlist is not open", async () => {
    const scheduledEvent = makeEvent({
      waitlistStatus: "SCHEDULED",
      waitlistPublishAt: new Date("2025-02-01T00:00:00Z"),
    });
    const { deps } = makeDeps(scheduledEvent);

    await expect(
      joinEventWaitlist(deps, {
        eventId: EVENT_ID,
        contactEmail: "viewer@example.com",
      }),
    ).rejects.toMatchObject({ code: "WAITLIST_NOT_OPEN" });
  });

  it("rejects when waitlist is full", async () => {
    const cappedEvent = makeEvent({ waitlistCap: 1 });
    const { deps, waitlistEntries } = makeDeps(cappedEvent);
    waitlistEntries.push({
      id: "11111111-2222-4222-8222-222222222222",
      eventId: EVENT_ID,
      humanId: "be854c4d-a031-4f0b-a584-d0dc54b4c9a4",
      contactEmail: "existing@example.com",
      contactPhone: null,
      source: "PUBLIC",
      status: "PENDING",
      metadata: {},
      notifiedAt: null,
      convertedOrderId: null,
      createdAt: new Date(NOW.getTime() - 1000),
      updatedAt: new Date(NOW.getTime() - 1000),
    });

    await expect(
      joinEventWaitlist(deps, {
        eventId: EVENT_ID,
        contactEmail: "viewer@example.com",
      }),
    ).rejects.toMatchObject({ code: "WAITLIST_FULL" });
  });

  it("still returns existing entry even when full", async () => {
    const cappedEvent = makeEvent({ waitlistCap: 1 });
    const { deps, waitlistEntries } = makeDeps(cappedEvent);
    waitlistEntries.push({
      id: "11111111-1111-4111-8111-111111111111",
      eventId: EVENT_ID,
      humanId: VIEWER_ID,
      contactEmail: "viewer@example.com",
      contactPhone: null,
      source: "PUBLIC",
      status: "PENDING",
      metadata: {},
      notifiedAt: null,
      convertedOrderId: null,
      createdAt: new Date(NOW.getTime() - 1000),
      updatedAt: new Date(NOW.getTime() - 1000),
    });

    const result = await joinEventWaitlist(deps, {
      eventId: EVENT_ID,
      viewerHumanId: VIEWER_ID,
      contactEmail: "viewer@example.com",
    });

    expect(result.alreadyJoined).toBe(true);
    expect(result.entry.id).toBe("11111111-1111-4111-8111-111111111111");
  });
});

// ── F8 (2026-09-29 scanner report): anonymous-join abuse controls ─────────
describe("joinEventWaitlist abuse controls", () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

  function makeTurnstile(opts: { enabled: boolean; valid?: boolean }) {
    return {
      enabled: opts.enabled,
      verify: vi.fn(async () => opts.valid ?? true),
    };
  }

  function makeMailingDeps(
    rateLimit: JoinEventWaitlistDeps["rateLimit"],
    extra: Partial<JoinEventWaitlistDeps> = {},
  ) {
    const built = makeDeps(
      makeEvent({ waitlistEmailEnabled: true } as Partial<EventRecord>),
    );
    const mailer = { send: vi.fn(async () => ({ id: "m1" })) };
    const deps: JoinEventWaitlistDeps = {
      ...built.deps,
      mailer: mailer as unknown as JoinEventWaitlistDeps["mailer"],
      publicAppUrl: "https://ithasfire.test",
      rateLimit,
      ...extra,
    };
    return { ...built, deps, mailer };
  }

  const allow = { allowed: true, remaining: 1, retryAfterSeconds: 0 };
  const deny = { allowed: false, remaining: 0, retryAfterSeconds: 60 };

  it("requires a Turnstile token for anonymous joins when enabled", async () => {
    const { deps, waitlistEntries } = makeDeps();
    deps.turnstile = makeTurnstile({ enabled: true });

    await expect(
      joinEventWaitlist(deps, {
        eventId: EVENT_ID,
        contactEmail: "anon@example.com",
      }),
    ).rejects.toMatchObject({ code: "TURNSTILE_TOKEN_REQUIRED" });
    expect(waitlistEntries).toHaveLength(0);
  });

  it("rejects an anonymous join whose Turnstile token fails", async () => {
    const { deps, waitlistEntries } = makeDeps();
    const turnstile = makeTurnstile({ enabled: true, valid: false });
    deps.turnstile = turnstile;

    await expect(
      joinEventWaitlist(deps, {
        eventId: EVENT_ID,
        contactEmail: "anon@example.com",
        turnstileToken: "bad",
        requestIp: "203.0.113.9",
      }),
    ).rejects.toMatchObject({ code: "TURNSTILE_VERIFICATION_FAILED" });
    expect(turnstile.verify).toHaveBeenCalledWith("bad", "203.0.113.9");
    expect(waitlistEntries).toHaveLength(0);
  });

  it("accepts an anonymous join with a valid token", async () => {
    const { deps } = makeDeps();
    deps.turnstile = makeTurnstile({ enabled: true, valid: true });

    const result = await joinEventWaitlist(deps, {
      eventId: EVENT_ID,
      contactEmail: "anon@example.com",
      turnstileToken: "good",
    });
    expect(result.alreadyJoined).toBe(false);
    expect(result.entry.contactEmail).toBe("anon@example.com");
  });

  it("signed-in joins skip Turnstile", async () => {
    const { deps } = makeDeps();
    const turnstile = makeTurnstile({ enabled: true });
    deps.turnstile = turnstile;

    await joinEventWaitlist(deps, {
      eventId: EVENT_ID,
      viewerHumanId: VIEWER_ID,
    });
    expect(turnstile.verify).not.toHaveBeenCalled();
  });

  it("sends the confirmation when both daily budgets allow it", async () => {
    const rateLimit = { consume: vi.fn(async () => allow) };
    const { deps, mailer } = makeMailingDeps(rateLimit);

    await joinEventWaitlist(deps, {
      eventId: EVENT_ID,
      contactEmail: "Fan@Example.com",
    });
    await vi.waitFor(() => expect(mailer.send).toHaveBeenCalledTimes(1));
    const keys = rateLimit.consume.mock.calls.map((c) => c[0]);
    expect(keys[0]).toMatch(/^waitlist:confirm:to:[0-9a-f]{64}$/);
    expect(keys[0]).not.toContain("example.com");
    expect(keys[1]).toBe(`waitlist:confirm:event:${EVENT_ID}`);
    expect(rateLimit.consume).toHaveBeenCalledWith(keys[0], 3, 86_400);
    expect(rateLimit.consume).toHaveBeenCalledWith(keys[1], 200, 86_400);
    // Per-organiser ceiling across all their events (event fixture has orgId).
    expect(keys[2]).toBe(
      "waitlist:confirm:org:560c1f10-7930-4ad6-a6e7-09016c7f4d5e",
    );
    expect(rateLimit.consume).toHaveBeenCalledWith(keys[2], 1000, 86_400);
  });

  it("skips the email once the organiser's daily cap is hit", async () => {
    const rateLimit = {
      consume: vi
        .fn()
        .mockResolvedValueOnce(allow)
        .mockResolvedValueOnce(allow)
        .mockResolvedValueOnce(deny),
    };
    const { deps, mailer } = makeMailingDeps(rateLimit);

    await joinEventWaitlist(deps, {
      eventId: EVENT_ID,
      contactEmail: "fan@example.com",
    });
    await flush();
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it("spends no budget when the event's confirmation email is off", async () => {
    const rateLimit = { consume: vi.fn(async () => allow) };
    const built = makeDeps(
      makeEvent({ waitlistEmailEnabled: false } as Partial<EventRecord>),
    );
    const mailer = { send: vi.fn(async () => ({ id: "m1" })) };
    const deps: JoinEventWaitlistDeps = {
      ...built.deps,
      mailer: mailer as unknown as JoinEventWaitlistDeps["mailer"],
      publicAppUrl: "https://ithasfire.test",
      rateLimit,
    };

    await joinEventWaitlist(deps, {
      eventId: EVENT_ID,
      contactEmail: "fan@example.com",
    });
    await flush();
    expect(rateLimit.consume).not.toHaveBeenCalled();
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it("ignores a client-typed address on a signed-in join", async () => {
    const rateLimit = { consume: vi.fn(async () => allow) };
    const { deps, mailer, waitlistEntries } = makeMailingDeps(rateLimit);

    await joinEventWaitlist(deps, {
      eventId: EVENT_ID,
      viewerHumanId: VIEWER_ID,
      contactEmail: "third-party@example.com",
    });
    await flush();
    expect(waitlistEntries[0]?.contactEmail).toBeNull();
    expect(waitlistEntries[0]?.humanId).toBe(VIEWER_ID);
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it("logs at error AND reports when the confirmation send fails", async () => {
    const rateLimit = { consume: vi.fn(async () => allow) };
    const boom = new Error("smtp down");
    const reportError = vi.fn();
    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      child: () => logger,
    };
    const { deps, mailer } = makeMailingDeps(rateLimit, {
      reportError,
      logger: logger as unknown as JoinEventWaitlistDeps["logger"],
    });
    mailer.send.mockRejectedValueOnce(boom);

    const result = await joinEventWaitlist(deps, {
      eventId: EVENT_ID,
      contactEmail: "fan@example.com",
    });
    expect(result.alreadyJoined).toBe(false);
    await vi.waitFor(() => expect(reportError).toHaveBeenCalledTimes(1));
    const [reported, ctx] = reportError.mock.calls[0]!;
    expect(reported).toBe(boom);
    expect(ctx).toMatchObject({
      tags: { area: "waitlist_confirmation", useCase: "joinEventWaitlist" },
      extra: { eventId: EVENT_ID },
    });
    expect(ctx.extra.entryId).toEqual(expect.any(String));
    expect(logger.error).toHaveBeenCalledWith(
      "joinEventWaitlist.confirmationEmailFailed",
      expect.anything(),
    );
  });

  it("a throwing reporter doesn't escape the fire-and-forget send", async () => {
    const rateLimit = { consume: vi.fn(async () => allow) };
    const { deps, mailer } = makeMailingDeps(rateLimit, {
      reportError: () => {
        throw new Error("sentry down");
      },
    });
    mailer.send.mockRejectedValueOnce(new Error("smtp down"));
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      await joinEventWaitlist(deps, {
        eventId: EVENT_ID,
        contactEmail: "fan@example.com",
      });
      await flush();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("skips the email (but keeps the join) once the recipient cap is hit", async () => {
    const rateLimit = { consume: vi.fn(async () => deny) };
    const { deps, mailer, waitlistEntries } = makeMailingDeps(rateLimit);

    const result = await joinEventWaitlist(deps, {
      eventId: EVENT_ID,
      contactEmail: "victim@example.com",
    });
    await flush();
    expect(result.alreadyJoined).toBe(false);
    expect(waitlistEntries).toHaveLength(1);
    expect(mailer.send).not.toHaveBeenCalled();
    // The per-event budget is not spent on a recipient-capped send.
    expect(rateLimit.consume).toHaveBeenCalledTimes(1);
  });

  it("skips the email once the per-event daily cap is hit", async () => {
    const rateLimit = {
      consume: vi.fn().mockResolvedValueOnce(allow).mockResolvedValueOnce(deny),
    };
    const { deps, mailer } = makeMailingDeps(rateLimit);

    await joinEventWaitlist(deps, {
      eventId: EVENT_ID,
      contactEmail: "fan@example.com",
    });
    await flush();
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it("fails closed and reports when the limiter backend throws", async () => {
    const boom = new Error("redis down");
    const rateLimit = { consume: vi.fn(async () => Promise.reject(boom)) };
    const reportError = vi.fn();
    const { deps, mailer } = makeMailingDeps(rateLimit, { reportError });

    const result = await joinEventWaitlist(deps, {
      eventId: EVENT_ID,
      contactEmail: "fan@example.com",
    });
    await flush();
    expect(result.alreadyJoined).toBe(false);
    expect(mailer.send).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({
        tags: expect.objectContaining({ area: "waitlist_confirmation_cap" }),
      }),
    );
  });

  it("never sends uncapped: no limiter wired means no email", async () => {
    const { deps, mailer } = makeMailingDeps(null);

    await joinEventWaitlist(deps, {
      eventId: EVENT_ID,
      contactEmail: "fan@example.com",
    });
    await flush();
    expect(mailer.send).not.toHaveBeenCalled();
  });
});
