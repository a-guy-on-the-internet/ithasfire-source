import { describe, expect, it, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { MailerPort } from "@th/ports/comms/mailer";
import type {
  AttendeeReviewDigestCandidate,
  NotificationDigestSubscriptionRecord,
  NotificationDigestLogRecord,
} from "@th/ports/repos/notification-digests";

import {
  sendAttendeeReviewDigests,
  startOfUtcWeekKey,
  type SendAttendeeReviewDigestsDeps,
} from "../send-attendee-review-digests";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const SECRET = "test-unsubscribe-secret";
const BASE_URL = "https://ithasfire.com";
const HUMAN = "11111111-1111-4111-8111-111111111111";
const EVENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EVENT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DAY_MS = 24 * 60 * 60 * 1000;

function makeCandidate(
  overrides?: Partial<AttendeeReviewDigestCandidate>,
): AttendeeReviewDigestCandidate {
  return {
    humanId: HUMAN,
    humanEmail: "fan@example.com",
    humanName: "Fan",
    shows: [
      {
        eventId: EVENT_A,
        eventTitle: "Loud Night",
        placeName: "The Basement",
        eventEndsAt: new Date("2026-07-10T04:00:00Z"),
      },
      {
        eventId: EVENT_B,
        eventTitle: "Quiet Morning",
        placeName: null,
        eventEndsAt: new Date("2026-07-12T04:00:00Z"),
      },
    ],
    ...overrides,
  };
}

type SubState = {
  subscribed: boolean;
  consecutiveIgnored: number;
  lastDigestSentAt: Date | null;
};

/**
 * In-memory NotificationDigests fake covering only the methods the digest
 * sender touches. `reviewedAt` models the human's latest AttendeeReview time
 * (drives the FR-004a re-engagement reset).
 */
function makeFakeRepo(opts: {
  candidates: AttendeeReviewDigestCandidate[];
  subscription?: SubState;
  reviewedAt?: Date | null;
  onRecordDigestSent?: () => void;
}) {
  const subs = new Map<string, SubState>();
  if (opts.subscription) subs.set(HUMAN, { ...opts.subscription });
  const logs = new Set<string>();
  let reviewedAt = opts.reviewedAt ?? null;

  const repo = {
    listAttendeeReviewDigestCandidates: vi.fn(
      async (): Promise<AttendeeReviewDigestCandidate[]> => opts.candidates,
    ),
    getSubscription: vi.fn(
      async (
        humanId: string,
      ): Promise<NotificationDigestSubscriptionRecord | null> => {
        const s = subs.get(humanId);
        if (!s) return null;
        return {
          humanId,
          digestType: "ATTENDEE_FEEDBACK",
          subscribed: s.subscribed,
          consecutiveIgnored: s.consecutiveIgnored,
          lastDigestSentAt: s.lastDigestSentAt,
        };
      },
    ),
    hasAttendeeReviewSince: vi.fn(
      async (input: { humanId: string; since: Date }): Promise<boolean> =>
        reviewedAt !== null && reviewedAt.getTime() > input.since.getTime(),
    ),
    findDigestLogByHash: vi.fn(
      async (input: {
        payloadHash: string;
      }): Promise<NotificationDigestLogRecord | null> =>
        logs.has(input.payloadHash)
          ? ({ payloadHash: input.payloadHash } as NotificationDigestLogRecord)
          : null,
    ),
    recordDigestLog: vi.fn(
      async (input: {
        payloadHash: string;
      }): Promise<NotificationDigestLogRecord> => {
        if (logs.has(input.payloadHash)) {
          throw new Error("unique constraint (digestType,channel,payloadHash)");
        }
        logs.add(input.payloadHash);
        return { payloadHash: input.payloadHash } as NotificationDigestLogRecord;
      },
    ),
    recordDigestSent: vi.fn(
      async (input: {
        humanId: string;
        sentAt: Date;
      }): Promise<NotificationDigestSubscriptionRecord> => {
        opts.onRecordDigestSent?.();
        const s = subs.get(input.humanId) ?? {
          subscribed: true,
          consecutiveIgnored: 0,
          lastDigestSentAt: null,
        };
        s.consecutiveIgnored += 1;
        s.lastDigestSentAt = input.sentAt;
        subs.set(input.humanId, s);
        return {
          humanId: input.humanId,
          digestType: "ATTENDEE_FEEDBACK",
          subscribed: s.subscribed,
          consecutiveIgnored: s.consecutiveIgnored,
          lastDigestSentAt: s.lastDigestSentAt,
        };
      },
    ),
    resetConsecutiveIgnored: vi.fn(
      async (input: { humanId: string }): Promise<void> => {
        const s = subs.get(input.humanId);
        if (s) s.consecutiveIgnored = 0;
      },
    ),
  };

  return {
    repo,
    subs,
    logs,
    setReviewedAt: (d: Date | null) => {
      reviewedAt = d;
    },
  };
}

function makeMailer(): MailerPort & { send: ReturnType<typeof vi.fn> } {
  const send = vi.fn(async () => ({
    result: { success: true } as never,
  }));
  return {
    send,
    sendBatch: vi.fn(async () => ({ results: [] }) as never),
    health: vi.fn(async () => ({ status: "ok" }) as never),
  } as MailerPort & { send: ReturnType<typeof vi.fn> };
}

function makeClock(now: Date): ClockPort {
  return { now: vi.fn(() => new Date(now)) };
}

function makeDeps(args: {
  repo: ReturnType<typeof makeFakeRepo>["repo"];
  mailer: MailerPort;
  now: Date;
  reportError?: SendAttendeeReviewDigestsDeps["reportError"];
}): SendAttendeeReviewDigestsDeps {
  return {
    repos: { notificationDigests: args.repo } as never,
    mailer: args.mailer,
    clock: makeClock(args.now),
    appBaseUrl: BASE_URL,
    unsubscribeSecret: SECRET,
    reportError: args.reportError,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("sendAttendeeReviewDigests", () => {
  it("sends ONE digest listing every un-reviewed show, with unsubscribe link", async () => {
    const fake = makeFakeRepo({ candidates: [makeCandidate()] });
    const mailer = makeMailer();
    const now = new Date("2026-07-16T16:00:00Z");

    const result = await sendAttendeeReviewDigests(
      makeDeps({ repo: fake.repo, mailer, now }),
    );

    expect(result).toMatchObject({ candidates: 1, sent: 1, suppressed: 0 });
    expect(mailer.send).toHaveBeenCalledTimes(1);

    const call = mailer.send.mock.calls[0]![0];
    // Lists both shows + per-show review links.
    expect(call.text).toContain("Loud Night");
    expect(call.text).toContain("Quiet Morning");
    expect(call.text).toContain(`${BASE_URL}/review-event/${EVENT_A}`);
    expect(call.text).toContain(`${BASE_URL}/review-event/${EVENT_B}`);
    // Calm-honest promises (FR-007).
    expect(call.text).toContain("weekly");
    expect(call.text).toContain("aggregate");
    expect(call.text.toLowerCase()).toContain("without your name");
    // One-click unsubscribe: footer link + List-Unsubscribe headers (FR-005).
    expect(call.text).toContain(`${BASE_URL}/unsubscribe?kind=review-prompts`);
    expect(call.headers?.["List-Unsubscribe"]).toMatch(
      /^<https:\/\/ithasfire\.com\/unsubscribe\?kind=review-prompts.+>$/,
    );
    expect(call.headers?.["List-Unsubscribe-Post"]).toBe(
      "List-Unsubscribe=One-Click",
    );

    // Counter bumped for the send (FR-004c).
    expect(fake.subs.get(HUMAN)?.consecutiveIgnored).toBe(1);
  });

  it("is idempotent per (human, week): a same-week re-run sends nothing new", async () => {
    const fake = makeFakeRepo({ candidates: [makeCandidate()] });
    const mailer = makeMailer();
    const now = new Date("2026-07-16T16:00:00Z");

    const first = await sendAttendeeReviewDigests(
      makeDeps({ repo: fake.repo, mailer, now }),
    );
    const second = await sendAttendeeReviewDigests(
      makeDeps({ repo: fake.repo, mailer, now }),
    );

    expect(first.sent).toBe(1);
    expect(second.sent).toBe(0);
    expect(second.alreadySent).toBe(1);
    expect(mailer.send).toHaveBeenCalledTimes(1);
  });

  it("hard opt-out (subscribed=false) suppresses email; in-app is untouched", async () => {
    const fake = makeFakeRepo({
      candidates: [makeCandidate()],
      subscription: {
        subscribed: false,
        consecutiveIgnored: 0,
        lastDigestSentAt: null,
      },
    });
    const mailer = makeMailer();
    const now = new Date("2026-07-16T16:00:00Z");

    const result = await sendAttendeeReviewDigests(
      makeDeps({ repo: fake.repo, mailer, now }),
    );

    expect(result).toMatchObject({ sent: 0, suppressed: 1 });
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it("skips a human with no email address", async () => {
    const fake = makeFakeRepo({
      candidates: [makeCandidate({ humanEmail: null })],
    });
    const mailer = makeMailer();
    const now = new Date("2026-07-16T16:00:00Z");

    const result = await sendAttendeeReviewDigests(
      makeDeps({ repo: fake.repo, mailer, now }),
    );

    expect(result).toMatchObject({ sent: 0, skippedNoEmail: 1 });
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it("NFR-001: 3-strike ladder over weeks — send, send, send, skip; review resets", async () => {
    const fake = makeFakeRepo({ candidates: [makeCandidate()] });
    const mailer = makeMailer();

    // A weekly run each Thursday — distinct week buckets so idempotency never
    // blocks the next legitimate send.
    const weeks = [
      new Date("2026-07-02T16:00:00Z"),
      new Date("2026-07-09T16:00:00Z"),
      new Date("2026-07-16T16:00:00Z"),
      new Date("2026-07-23T16:00:00Z"),
    ];

    const outcomes: Array<"sent" | "suppressed"> = [];
    for (const now of weeks) {
      const r = await sendAttendeeReviewDigests(
        makeDeps({ repo: fake.repo, mailer, now }),
      );
      outcomes.push(r.sent === 1 ? "sent" : "suppressed");
    }

    expect(outcomes).toEqual(["sent", "sent", "sent", "suppressed"]);
    expect(mailer.send).toHaveBeenCalledTimes(3);
    expect(fake.subs.get(HUMAN)?.consecutiveIgnored).toBe(3);

    // Human reviews something AFTER the 3rd digest → next run resets + re-sends.
    fake.setReviewedAt(new Date("2026-07-24T10:00:00Z"));
    const reengaged = await sendAttendeeReviewDigests(
      makeDeps({ repo: fake.repo, mailer, now: new Date("2026-07-30T16:00:00Z") }),
    );

    expect(reengaged).toMatchObject({ sent: 1, reengaged: 1 });
    expect(mailer.send).toHaveBeenCalledTimes(4);
    // Counter reset to 0 then bumped to 1 by this send.
    expect(fake.subs.get(HUMAN)?.consecutiveIgnored).toBe(1);
  });

  it("isolates a per-human failure and reports it (guarded reporter)", async () => {
    const fake = makeFakeRepo({ candidates: [makeCandidate()] });
    const mailer = makeMailer();
    mailer.send.mockRejectedValueOnce(new Error("smtp down"));
    const now = new Date("2026-07-16T16:00:00Z");

    // A throwing reporter must never change behaviour.
    const reportError = vi.fn(() => {
      throw new Error("sentry exploded");
    });

    const result = await sendAttendeeReviewDigests(
      makeDeps({ repo: fake.repo, mailer, now, reportError }),
    );

    expect(result.failed).toBe(1);
    expect(result.sent).toBe(0);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("startOfUtcWeekKey buckets a whole ISO week to its Monday", () => {
    // 2026-07-16 is a Thursday; its ISO-week Monday is 2026-07-13.
    expect(startOfUtcWeekKey(new Date("2026-07-16T16:00:00Z"))).toBe(
      "2026-07-13",
    );
    expect(startOfUtcWeekKey(new Date("2026-07-13T00:00:00Z"))).toBe(
      "2026-07-13",
    );
    expect(startOfUtcWeekKey(new Date("2026-07-19T23:59:59Z"))).toBe(
      "2026-07-13",
    );
    // Next week rolls to the following Monday.
    expect(startOfUtcWeekKey(new Date("2026-07-20T00:00:00Z"))).toBe(
      "2026-07-20",
    );
  });
});
