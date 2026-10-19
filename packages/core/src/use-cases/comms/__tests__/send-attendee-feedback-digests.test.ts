import { describe, expect, it, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type {
  CompletedEventOrders,
  FeedbackRequestRecord,
  NotificationDigestLogRecord,
  NotificationDigestsRepo,
  NotificationDigestSubscriptionRecord,
} from "@th/ports/repos/notification-digests";
import type { EventRecord } from "@th/ports/repos/events";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { NotifyInput, NotifyOutput } from "../../comms/notify";

import { sendAttendeeFeedbackDigests } from "../send-attendee-feedback-digests";

const FIXED_NOW = new Date("2024-05-01T12:00:00Z");
const EVENT_ID = "6153a80e-1f32-45b1-9e23-2a8e5da28f87";
const ORG_ID = "4bd72d3e-8bd2-4b49-8c92-3cef0f2a4d4d";
const ORDER_ID_ONE = "11111111-1111-4111-8111-111111111111";
const ORDER_ID_TWO = "22222222-2222-4222-8222-222222222222";
const HUMAN_ID_ONE = "33333333-3333-4333-8333-333333333333";
const HUMAN_ID_TWO = "44444444-4444-4444-8444-444444444444";

function buildClock(): ClockPort {
  return {
    now: vi.fn(() => new Date(FIXED_NOW)),
  };
}

function buildNotify(overrides?: Partial<NotifyOutput>) {
  const impl = async (input: NotifyInput): Promise<NotifyOutput> => {
    const base = {
      ok: true as const,
      variant: input.variant,
      category: "marketing" as const,
      scope: input.scope ?? ({ kind: "GLOBAL" } as const),
      inApp: {
        status: "skipped" as const,
        reason: "renderer_omitted" as const,
      },
      push: { status: "skipped" as const, reason: "renderer_omitted" as const },
      email: { status: "sent" as const },
      sms: { status: "skipped" as const, reason: "renderer_omitted" as const },
    } satisfies NotifyOutput;

    return { ...base, ...(overrides ?? {}) } as NotifyOutput;
  };

  return vi.fn(impl);
}

function buildEventRecord(
  status: EventRecord["status"] = "COMPLETED",
): EventRecord {
  return {
    id: EVENT_ID,
    orgId: "4bd72d3e-8bd2-4b49-8c92-3cef0f2a4d4d",
    humanId: "9c2ff9d5-5d77-4fad-b46f-0530f4c41b8d",
    title: "Test Event",
    status,
    visibility: "PUBLIC",
    gateType: "NONE",
    locationMode: "EXACT",
    locationRadiusMeters: null,
    locationLabel: null,
    addressRevealAt: null,
    addressRevealPreset: null,
    startsAt: new Date("2024-04-30T16:00:00Z"),
    endsAt: new Date("2024-04-30T20:00:00Z"),
    placeId: null,
    savedLocationId: null,
    categoryId: null,
    addressText: null,
    lat: null,
    lng: null,
    slug: null,
    shortId: null,
    regionCode: null,
    publishedAt: new Date("2024-04-01T00:00:00Z"),
    agreementPrimaryId: "agreement-1",
    agreementResaleId: null,
    defaultLocale: "en-US",
    listingPriority: null,
    passwordHash: null,
    passwordUpdatedAt: null,
    waitlistStatus: "DISABLED",
    waitlistPublishAt: null,
    waitlistDescription: null,
    waitlistCap: null,
    payoutTermsId: null,
    resalePayoutTermsId: null,
    placeLayoutId: null,
    currency: null,
  };
}

function buildRepos(options: {
  event?: EventRecord;
  completedOrders?: CompletedEventOrders[];
  subscriptions?: Record<string, NotificationDigestSubscriptionRecord | null>;
  notifyFn: (input: NotifyInput) => Promise<NotifyOutput>;
  /** Humans whose email is verified; default every Human (B2). */
  verifiedIds?: string[];
  verifiedLookupError?: Error;
}) {
  const eventRecord = options.event ?? buildEventRecord();
  const completedOrders = options.completedOrders ?? [];
  const subscriptions = options.subscriptions ?? {};

  const eventsRepo = {
    getById: vi.fn(async () => eventRecord),
  };

  const orderToHuman = new Map<string, string>();

  const ensureFeedbackRequest = vi.fn(
    async (input: {
      eventId: string;
      orderId: string;
      humanId: string;
      sendAfter: Date;
      channel: "EMAIL";
      metadata?: Record<string, unknown> | null;
    }) => {
      orderToHuman.set(input.orderId, input.humanId);
      return {
        id: input.orderId,
        eventId: input.eventId,
        orderId: input.orderId,
        humanId: input.humanId,
        status: "SCHEDULED",
        channel: input.channel,
        sendAfter: input.sendAfter,
        sentAt: null,
        respondedAt: null,
        payloadHash: null,
      } satisfies FeedbackRequestRecord;
    },
  );

  const markFeedbackSent = vi.fn(
    async (input: { requestId: string; sentAt: Date; payloadHash: string }) => {
      const humanId = orderToHuman.get(input.requestId) ?? HUMAN_ID_ONE;
      return {
        id: input.requestId,
        eventId: eventRecord.id,
        orderId: input.requestId,
        humanId,
        status: "SENT",
        channel: "EMAIL",
        sendAfter: FIXED_NOW,
        sentAt: input.sentAt,
        respondedAt: null,
        payloadHash: input.payloadHash,
      } satisfies FeedbackRequestRecord;
    },
  );

  const recordDigestLog = vi.fn(
    async (input: {
      humanId: string;
      orgId?: string | null;
      eventId?: string | null;
      digestType: string;
      channel: string;
      payloadHash: string;
      templateKey: string;
      metadata?: Record<string, unknown> | null;
      sentAt: Date;
    }) =>
      ({
        id: `log-${input.payloadHash}`,
        humanId: input.humanId,
        orgId: input.orgId ?? null,
        eventId: input.eventId ?? null,
        digestType:
          input.digestType as NotificationDigestLogRecord["digestType"],
        channel: input.channel as NotificationDigestLogRecord["channel"],
        payloadHash: input.payloadHash,
        templateKey: input.templateKey,
        metadata: input.metadata ?? null,
        sentAt: input.sentAt,
      }) satisfies NotificationDigestLogRecord,
  );

  const notificationDigestsRepo: NotificationDigestsRepo = {
    listOrganizerMetrics: vi.fn(),
    listUpcomingEvents: vi.fn(),
    listCompletedEventOrders: vi.fn(async () => completedOrders),
    listAttendeeFeedbackDue: vi.fn(),
    markFeedbackSent,
    ensureFeedbackRequest,
    recordDigestLog,
    findDigestLogByHash: vi.fn(),
    getSubscription: vi.fn(
      async (humanId: string) => subscriptions[humanId] ?? null,
    ),
    upsertSubscription: vi.fn(),
  } as unknown as NotificationDigestsRepo;

  const txRepos = {
    events: eventsRepo,
    notificationDigests: notificationDigestsRepo,
  } as unknown as TxRepos;

  const humansRepo = {
    listEmailVerifiedIds: vi.fn(async (ids: string[]) => {
      if (options.verifiedLookupError) throw options.verifiedLookupError;
      if (!options.verifiedIds) return ids;
      return ids.filter((id) => options.verifiedIds!.includes(id));
    }),
  };

  const repos: Repos = {
    tx: async <T>(fn: (tx: TxRepos) => Promise<T>) => fn(txRepos),
    events: eventsRepo as unknown as Repos["events"],
    humans: humansRepo as unknown as Repos["humans"],
    notificationDigests:
      notificationDigestsRepo as unknown as Repos["notificationDigests"],
  } as Repos;

  return {
    repos,
    ensureFeedbackRequest,
    markFeedbackSent,
    recordDigestLog,
    eventsRepo,
    notificationDigestsRepo,
    humansRepo,
    notify: options.notifyFn,
  };
}

describe("sendAttendeeFeedbackDigests", () => {
  it("queues requests and sends due feedback emails", async () => {
    const notify = buildNotify();

    const completedOrders: CompletedEventOrders[] = [
      {
        eventId: EVENT_ID,
        orgId: ORG_ID,
        eventTitle: "Test Event",
        eventEndsAt: new Date("2024-04-30T20:00:00Z"),
        organizerName: "Ticket Org",
        attendees: [
          {
            orderId: ORDER_ID_ONE,
            humanId: HUMAN_ID_ONE,
            humanEmail: "attendee1@example.com",
            humanName: "Attendee One",
            sendAfter: new Date("2024-05-01T08:00:00Z"),
          },
          {
            orderId: ORDER_ID_TWO,
            humanId: HUMAN_ID_TWO,
            humanEmail: "attendee2@example.com",
            humanName: "Attendee Two",
            sendAfter: new Date("2024-05-02T08:00:00Z"),
          },
        ],
      },
    ];

    const { repos, markFeedbackSent, recordDigestLog } = buildRepos({
      completedOrders,
      notifyFn: notify,
    });

    const result = await sendAttendeeFeedbackDigests(
      {
        repos,
        clock: buildClock(),
        notify,
      },
      { eventId: EVENT_ID },
    );

    expect(result).toEqual({
      eventId: EVENT_ID,
      requestsQueued: 2,
      requestsSent: 1,
      requestsSkipped: 0,
      sendFailures: 0,
    });

    expect(notify).toHaveBeenCalledTimes(1);
    expect(markFeedbackSent).toHaveBeenCalledTimes(1);
    expect(recordDigestLog).toHaveBeenCalledTimes(1);

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: HUMAN_ID_ONE,
        variant: "event.attendee-feedback-request",
        scope: { kind: "EVENT", eventId: EVENT_ID },
      }),
    );
  });

  it("skips unsubscribed attendees", async () => {
    const notify = buildNotify();

    const completedOrders: CompletedEventOrders[] = [
      {
        eventId: EVENT_ID,
        orgId: ORG_ID,
        eventTitle: "Test Event",
        eventEndsAt: new Date("2024-04-30T20:00:00Z"),
        organizerName: "Ticket Org",
        attendees: [
          {
            orderId: ORDER_ID_ONE,
            humanId: HUMAN_ID_ONE,
            humanEmail: "attendee1@example.com",
            humanName: "Attendee One",
            sendAfter: new Date("2024-05-01T08:00:00Z"),
          },
        ],
      },
    ];

    const subscription: NotificationDigestSubscriptionRecord = {
      humanId: HUMAN_ID_ONE,
      digestType: "ATTENDEE_FEEDBACK",
      subscribed: false,
      unsubscribedAt: new Date("2024-01-01T00:00:00Z"),
      reason: "opt-out",
      consecutiveIgnored: 0,
      lastDigestSentAt: null,
    };

    const { repos, ensureFeedbackRequest } = buildRepos({
      completedOrders,
      notifyFn: notify,
      subscriptions: {
        [HUMAN_ID_ONE]: subscription,
      },
    });

    const result = await sendAttendeeFeedbackDigests(
      {
        repos,
        clock: buildClock(),
        notify,
      },
      { eventId: EVENT_ID },
    );

    expect(result).toEqual({
      eventId: EVENT_ID,
      requestsQueued: 0,
      requestsSent: 0,
      requestsSkipped: 1,
      sendFailures: 0,
    });

    expect(ensureFeedbackRequest).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("throws when event is not completed", async () => {
    const notify = buildNotify();

    const { repos } = buildRepos({
      event: buildEventRecord("PUBLISHED"),
      completedOrders: [],
      notifyFn: notify,
    });

    await expect(
      sendAttendeeFeedbackDigests(
        {
          repos,
          clock: buildClock(),
          notify,
        },
        { eventId: EVENT_ID },
      ),
    ).rejects.toMatchObject({ code: "EVENT_NOT_COMPLETED" });
  });

  // B2 (account squatting through guest checkout): the digest reaches a
  // ticket holder, and tickets attach BY EMAIL. Email still goes to everyone;
  // in-app, push and SMS only to accounts that proved their inbox.
  describe("verified recipients only for in-app and push (B2)", () => {
    const EMAIL_ONLY = {
      inApp: { enabled: false },
      push: { enabled: false },
      sms: { enabled: false },
    };
    const bothDue = (): CompletedEventOrders[] => [
      {
        eventId: EVENT_ID,
        orgId: ORG_ID,
        eventTitle: "Test Event",
        eventEndsAt: new Date("2024-04-30T20:00:00Z"),
        organizerName: "Ticket Org",
        attendees: [
          {
            orderId: ORDER_ID_ONE,
            humanId: HUMAN_ID_ONE,
            humanEmail: "attendee1@example.com",
            humanName: "Attendee One",
            sendAfter: new Date("2024-05-01T08:00:00Z"),
          },
          {
            orderId: ORDER_ID_TWO,
            humanId: HUMAN_ID_TWO,
            humanEmail: "attendee2@example.com",
            humanName: "Attendee Two",
            sendAfter: new Date("2024-05-01T08:00:00Z"),
          },
        ],
      },
    ];
    const callFor = (
      notify: ReturnType<typeof buildNotify>,
      humanId: string,
    ) =>
      (notify.mock.calls as unknown as Array<[NotifyInput]>)
        .map((c) => c[0])
        .find((c) => c.humanId === humanId);

    it("a verified holder gets every channel, an unverified one email only", async () => {
      const notify = buildNotify();
      const { repos, humansRepo, markFeedbackSent } = buildRepos({
        completedOrders: bothDue(),
        notifyFn: notify,
        verifiedIds: [HUMAN_ID_ONE],
      });

      const result = await sendAttendeeFeedbackDigests(
        { repos, clock: buildClock(), notify },
        { eventId: EVENT_ID },
      );

      expect(humansRepo.listEmailVerifiedIds).toHaveBeenCalledWith(
        expect.arrayContaining([HUMAN_ID_ONE, HUMAN_ID_TWO]),
      );
      expect(callFor(notify, HUMAN_ID_ONE)?.channels).toBeUndefined();
      expect(callFor(notify, HUMAN_ID_TWO)?.channels).toEqual(EMAIL_ONLY);
      // The email went to both, so both requests are marked sent.
      expect(result.requestsSent).toBe(2);
      expect(markFeedbackSent).toHaveBeenCalledTimes(2);
    });

    it("a failed lookup sends email only to everyone, logs ERROR and reports", async () => {
      const notify = buildNotify();
      const reportError = vi.fn();
      const error = vi.fn();
      const logger = {
        child: () => logger,
        info: vi.fn(),
        warn: vi.fn(),
        error,
        log: vi.fn(),
        withTime: vi.fn(),
      };
      const { repos } = buildRepos({
        completedOrders: bothDue(),
        notifyFn: notify,
        verifiedLookupError: new Error("db down"),
      });

      const result = await sendAttendeeFeedbackDigests(
        {
          repos,
          clock: buildClock(),
          notify,
          logger: logger as never,
          reportError,
        },
        { eventId: EVENT_ID },
      );

      expect(callFor(notify, HUMAN_ID_ONE)?.channels).toEqual(EMAIL_ONLY);
      expect(callFor(notify, HUMAN_ID_TWO)?.channels).toEqual(EMAIL_ONLY);
      expect(result.requestsSent).toBe(2);
      expect(error).toHaveBeenCalledWith(
        "comms.sendAttendeeFeedbackDigests.verified_lookup_failed",
        expect.objectContaining({ eventId: EVENT_ID }),
      );
      expect(reportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: expect.objectContaining({ reason: "verified-lookup-failed" }),
        }),
      );
    });

    it("a throwing reporter does not change the outcome", async () => {
      const notify = buildNotify();
      const { repos } = buildRepos({
        completedOrders: bothDue(),
        notifyFn: notify,
        verifiedLookupError: new Error("db down"),
      });

      const result = await sendAttendeeFeedbackDigests(
        {
          repos,
          clock: buildClock(),
          notify,
          reportError: vi.fn(() => {
            throw new Error("sentry down");
          }),
        },
        { eventId: EVENT_ID },
      );

      expect(result.requestsSent).toBe(2);
    });
  });
});
