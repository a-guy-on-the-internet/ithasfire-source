import { Prisma } from "@prisma/client";
import type {
  FeedbackRequest,
  NotificationDigestLog,
  NotificationDigestSubscription,
  OrgRole,
} from "@prisma/client";

import type {
  AttendeeFeedbackCandidate,
  AttendeeReviewDigestCandidate,
  AttendeeReviewDigestShow,
  CompletedEventOrders,
  FeedbackRequestRecord,
  NotificationDigestChannel,
  NotificationDigestLogRecord,
  NotificationDigestSubscriptionRecord,
  NotificationDigestType,
  OrganizerDigestMetrics,
  OrganizerUpcomingEvent,
  NotificationDigestsRepo,
} from "@th/ports/repos/notification-digests";

import type { PrismaClientOrTx } from "./types";

const ORGANIZER_ROLES: OrgRole[] = ["OWNER", "ADMIN", "FINANCE"];
const SUCCEEDED_ORDER_STATUS = "SUCCEEDED";
const HOURS_24_IN_MS = 24 * 60 * 60 * 1000;

function normalizeMetadata(
  value: Prisma.JsonValue | null,
): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function toFeedbackRecord(record: FeedbackRequest): FeedbackRequestRecord {
  return {
    id: record.id,
    eventId: record.eventId,
    orderId: record.orderId,
    humanId: record.humanId,
    status: record.status,
    channel: record.channel,
    sendAfter: record.sendAfter,
    sentAt: record.sentAt,
    respondedAt: record.respondedAt,
    payloadHash: record.payloadHash,
  };
}

function toDigestLogRecord(
  record: NotificationDigestLog,
): NotificationDigestLogRecord {
  return {
    id: record.id,
    humanId: record.humanId,
    orgId: record.orgId,
    eventId: record.eventId,
    digestType: record.digestType,
    channel: record.channel,
    payloadHash: record.payloadHash,
    templateKey: record.templateKey,
    metadata: normalizeMetadata(record.metadata),
    sentAt: record.sentAt,
  };
}

function toSubscriptionRecord(
  record: NotificationDigestSubscription,
): NotificationDigestSubscriptionRecord {
  return {
    humanId: record.humanId,
    digestType: record.digestType,
    subscribed: record.subscribed,
    unsubscribedAt: record.unsubscribedAt,
    reason: record.reason,
    consecutiveIgnored: record.consecutiveIgnored,
    lastDigestSentAt: record.lastDigestSentAt,
  };
}

const PROMPTABLE_EVENT_STATUSES = ["PUBLISHED", "COMPLETED"] as const;

function coalesceSendAfter(
  eventEndsAt: Date | null,
  eventStartsAt: Date | null,
  fallback: Date,
): Date {
  if (eventEndsAt) {
    return new Date(eventEndsAt.getTime() + HOURS_24_IN_MS);
  }
  if (eventStartsAt) {
    return new Date(eventStartsAt.getTime() + HOURS_24_IN_MS);
  }
  return new Date(fallback.getTime() + HOURS_24_IN_MS);
}

export function makeNotificationDigestsRepo(
  p: PrismaClientOrTx,
): NotificationDigestsRepo {
  async function listOrganizerMetrics(input: {
    windowStart: Date;
    windowEnd: Date;
    limit?: number;
  }): Promise<OrganizerDigestMetrics[]> {
    const orders = await p.order.findMany({
      where: {
        status: SUCCEEDED_ORDER_STATUS,
        occurredAt: {
          gte: input.windowStart,
          lt: input.windowEnd,
        },
        event: {
          orgId: { not: null },
        },
      },
      select: {
        id: true,
        eventId: true,
        amountGrossCents: true,
        feesPlatformCents: true,
        occurredAt: true,
        event: {
          select: {
            id: true,
            title: true,
            startsAt: true,
            endsAt: true,
            orgId: true,
            org: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
        items: {
          where: { kind: "ticket" },
          select: {
            qty: true,
            amountCents: true,
          },
        },
      },
    });

    const aggregates = new Map<
      string,
      {
        orgId: string;
        orgName: string;
        totals: {
          ticketsSold: number;
          grossRevenueCents: number;
          platformFeesCents: number;
        };
        recentEvents: Map<
          string,
          {
            eventId: string;
            title: string;
            startsAt: Date;
            endsAt: Date | null;
            ticketsSold: number;
            grossRevenueCents: number;
          }
        >;
      }
    >();

    for (const order of orders) {
      const event = order.event;
      if (!event || !event.orgId || !event.org) continue;
      const orgId = event.orgId;
      const ticketsSold = order.items.reduce((sum, item) => sum + item.qty, 0);
      const orgEntry = aggregates.get(orgId) ?? {
        orgId,
        orgName: event.org.name,
        totals: { ticketsSold: 0, grossRevenueCents: 0, platformFeesCents: 0 },
        recentEvents: new Map(),
      };

      orgEntry.totals.ticketsSold += ticketsSold;
      orgEntry.totals.grossRevenueCents += order.amountGrossCents;
      orgEntry.totals.platformFeesCents += order.feesPlatformCents;

      const eventEntry = orgEntry.recentEvents.get(event.id) ?? {
        eventId: event.id,
        title: event.title,
        startsAt: event.startsAt,
        endsAt: event.endsAt ?? null,
        ticketsSold: 0,
        grossRevenueCents: 0,
      };
      eventEntry.ticketsSold += ticketsSold;
      eventEntry.grossRevenueCents += order.amountGrossCents;
      orgEntry.recentEvents.set(event.id, eventEntry);

      aggregates.set(orgId, orgEntry);
    }

    if (aggregates.size === 0) {
      return [];
    }

    const orgIds = Array.from(aggregates.keys());

    const members = await p.orgMember.findMany({
      where: {
        orgId: { in: orgIds },
        role: { in: ORGANIZER_ROLES },
      },
      select: {
        orgId: true,
        human: {
          select: {
            id: true,
            name: true,
            authUser: {
              select: {
                email: true,
              },
            },
          },
        },
      },
    });

    const upcomingEvents = await listUpcomingEvents({
      orgIds,
      referenceTime: input.windowEnd,
      limitPerOrg: 5,
    });

    const upcomingMap = new Map<string, OrganizerUpcomingEvent[]>();
    for (const event of upcomingEvents) {
      const bucket = upcomingMap.get(event.orgId) ?? [];
      bucket.push(event);
      upcomingMap.set(event.orgId, bucket);
    }

    const response: OrganizerDigestMetrics[] = [];

    for (const aggregate of aggregates.values()) {
      const recipients = members
        .filter(
          (member) =>
            member.orgId === aggregate.orgId &&
            member.human &&
            member.human.authUser?.email,
        )
        .map((member) => ({
          humanId: member.human!.id,
          email: member.human!.authUser!.email,
          name: member.human!.name,
        }));

      const recentEvents = Array.from(aggregate.recentEvents.values()).sort(
        (a, b) => a.startsAt.getTime() - b.startsAt.getTime(),
      );

      response.push({
        orgId: aggregate.orgId,
        orgName: aggregate.orgName,
        recipients,
        windowStart: input.windowStart,
        windowEnd: input.windowEnd,
        totals: aggregate.totals,
        recentEvents,
        upcomingEvents: upcomingMap.get(aggregate.orgId) ?? [],
      });
    }

    response.sort(
      (a, b) => b.totals.grossRevenueCents - a.totals.grossRevenueCents,
    );

    if (typeof input.limit === "number" && input.limit > 0) {
      return response.slice(0, input.limit);
    }

    return response;
  }

  async function listUpcomingEvents(input: {
    orgIds: string[];
    referenceTime: Date;
    limitPerOrg?: number;
  }): Promise<OrganizerUpcomingEvent[]> {
    if (input.orgIds.length === 0) {
      return [];
    }
    const events = await p.event.findMany({
      where: {
        orgId: { in: input.orgIds },
        status: { in: ["PUBLISHED", "COMPLETED"] },
        startsAt: { gte: input.referenceTime },
      },
      orderBy: { startsAt: "asc" },
      select: {
        id: true,
        orgId: true,
        title: true,
        startsAt: true,
        endsAt: true,
        ticketTypes: {
          select: {
            capacity: true,
          },
        },
      },
    });

    const perOrgLimit = input.limitPerOrg ?? 5;
    const grouped = new Map<string, OrganizerUpcomingEvent[]>();

    for (const event of events) {
      if (!event.orgId) continue;
      const ticketsOnSale = event.ticketTypes.reduce(
        (sum, type) => sum + (type.capacity ?? 0),
        0,
      );
      const entry: OrganizerUpcomingEvent = {
        orgId: event.orgId,
        eventId: event.id,
        title: event.title,
        startsAt: event.startsAt,
        endsAt: event.endsAt ?? null,
        ticketsOnSale,
      };
      const bucket = grouped.get(event.orgId) ?? [];
      if (bucket.length < perOrgLimit) {
        bucket.push(entry);
        grouped.set(event.orgId, bucket);
      }
    }

    return Array.from(grouped.values()).flat();
  }

  async function listCompletedEventOrders(input: {
    windowStart: Date;
    windowEnd: Date;
  }): Promise<CompletedEventOrders[]> {
    const events = await p.event.findMany({
      where: {
        endsAt: {
          gte: input.windowStart,
          lt: input.windowEnd,
        },
        status: { in: ["PUBLISHED", "COMPLETED"] },
      },
      select: {
        id: true,
        title: true,
        startsAt: true,
        endsAt: true,
        orgId: true,
        org: {
          select: {
            name: true,
          },
        },
        orders: {
          where: {
            status: SUCCEEDED_ORDER_STATUS,
          },
          select: {
            id: true,
            buyer: {
              select: {
                id: true,
                name: true,
                authUser: {
                  select: {
                    email: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    return events.map<CompletedEventOrders>((event) => {
      const attendees = new Map<
        string,
        {
          orderId: string;
          humanId: string;
          humanEmail: string | null;
          humanName: string | null;
          sendAfter: Date;
        }
      >();

      for (const order of event.orders) {
        if (!order.buyer) continue;
        if (attendees.has(order.buyer.id)) continue;
        const fallback = event.endsAt ?? event.startsAt ?? input.windowEnd;

        attendees.set(order.buyer.id, {
          orderId: order.id,
          humanId: order.buyer.id,
          humanEmail: order.buyer.authUser?.email ?? null,
          humanName: order.buyer.name,
          sendAfter: coalesceSendAfter(
            event.endsAt ?? null,
            event.startsAt ?? null,
            fallback,
          ),
        });
      }

      return {
        eventId: event.id,
        orgId: event.orgId ?? null,
        eventTitle: event.title,
        eventEndsAt: event.endsAt ?? null,
        organizerName: event.org?.name ?? null,
        attendees: Array.from(attendees.values()),
      };
    });
  }

  async function listAttendeeFeedbackDue(input: {
    now: Date;
    limit?: number;
  }): Promise<AttendeeFeedbackCandidate[]> {
    const requests = await p.feedbackRequest.findMany({
      where: {
        status: { in: ["PENDING", "SCHEDULED"] },
        sendAfter: { lte: input.now },
      },
      orderBy: { sendAfter: "asc" },
      take: input.limit ?? 200,
      include: {
        event: {
          select: {
            title: true,
            endsAt: true,
            org: {
              select: { name: true },
            },
          },
        },
        human: {
          select: {
            id: true,
            name: true,
            authUser: {
              select: { email: true },
            },
          },
        },
      },
    });

    return requests.map(
      (request): AttendeeFeedbackCandidate => ({
        requestId: request.id,
        humanId: request.humanId,
        humanEmail: request.human?.authUser?.email ?? null,
        humanName: request.human?.name ?? null,
        eventId: request.eventId,
        eventTitle: request.event?.title ?? "",
        eventEndsAt: request.event?.endsAt ?? null,
        organizerName: request.event?.org?.name ?? null,
        orderId: request.orderId,
        channel: request.channel,
        sendAfter: request.sendAfter,
      }),
    );
  }

  async function ensureFeedbackRequest(input: {
    eventId: string;
    orderId: string;
    humanId: string;
    channel: NotificationDigestChannel;
    sendAfter: Date;
    metadata?: Record<string, unknown> | null;
  }): Promise<FeedbackRequestRecord> {
    const metadata =
      input.metadata === undefined || input.metadata === null
        ? Prisma.JsonNull
        : (input.metadata as Prisma.InputJsonValue);

    const record = await p.feedbackRequest.upsert({
      where: {
        orderId_humanId: {
          orderId: input.orderId,
          humanId: input.humanId,
        },
      },
      update: {
        channel: input.channel,
        sendAfter: input.sendAfter,
        metadata,
        status: "SCHEDULED",
      },
      create: {
        eventId: input.eventId,
        orderId: input.orderId,
        humanId: input.humanId,
        channel: input.channel,
        sendAfter: input.sendAfter,
        status: "SCHEDULED",
        metadata,
      },
    });

    return toFeedbackRecord(record);
  }

  async function markFeedbackSent(input: {
    requestId: string;
    sentAt: Date;
    payloadHash: string;
  }): Promise<FeedbackRequestRecord> {
    const record = await p.feedbackRequest.update({
      where: { id: input.requestId },
      data: {
        status: "SENT",
        sentAt: input.sentAt,
        payloadHash: input.payloadHash,
      },
      include: { event: true },
    });

    return toFeedbackRecord(record);
  }

  async function recordDigestLog(input: {
    humanId: string;
    orgId?: string | null;
    eventId?: string | null;
    digestType: NotificationDigestType;
    channel: NotificationDigestChannel;
    payloadHash: string;
    templateKey: string;
    metadata?: Record<string, unknown> | null;
    sentAt: Date;
  }): Promise<NotificationDigestLogRecord> {
    const metadata =
      input.metadata === undefined || input.metadata === null
        ? Prisma.JsonNull
        : (input.metadata as Prisma.InputJsonValue);

    const record = await p.notificationDigestLog.create({
      data: {
        humanId: input.humanId,
        orgId: input.orgId ?? null,
        eventId: input.eventId ?? null,
        digestType: input.digestType,
        channel: input.channel,
        payloadHash: input.payloadHash,
        templateKey: input.templateKey,
        metadata,
        sentAt: input.sentAt,
      },
    });
    return toDigestLogRecord(record);
  }

  async function findDigestLogByHash(input: {
    digestType: NotificationDigestType;
    channel: NotificationDigestChannel;
    payloadHash: string;
  }): Promise<NotificationDigestLogRecord | null> {
    const record = await p.notificationDigestLog.findUnique({
      where: {
        digestType_channel_payloadHash: {
          digestType: input.digestType,
          channel: input.channel,
          payloadHash: input.payloadHash,
        },
      },
    });
    return record ? toDigestLogRecord(record) : null;
  }

  async function getSubscription(
    humanId: string,
    digestType: NotificationDigestType,
  ): Promise<NotificationDigestSubscriptionRecord | null> {
    const record = await p.notificationDigestSubscription.findUnique({
      where: {
        humanId_digestType: {
          humanId,
          digestType,
        },
      },
    });
    return record ? toSubscriptionRecord(record) : null;
  }

  async function upsertSubscription(input: {
    humanId: string;
    digestType: NotificationDigestType;
    subscribed: boolean;
    reason?: string | null;
    unsubscribedAt?: Date | null;
  }): Promise<NotificationDigestSubscriptionRecord> {
    const record = await p.notificationDigestSubscription.upsert({
      where: {
        humanId_digestType: {
          humanId: input.humanId,
          digestType: input.digestType,
        },
      },
      update: {
        subscribed: input.subscribed,
        reason: input.reason ?? null,
        unsubscribedAt:
          input.unsubscribedAt ?? (input.subscribed ? null : new Date()),
      },
      create: {
        humanId: input.humanId,
        digestType: input.digestType,
        subscribed: input.subscribed,
        reason: input.reason ?? null,
        unsubscribedAt:
          input.unsubscribedAt ?? (input.subscribed ? null : new Date()),
      },
    });

    return toSubscriptionRecord(record);
  }

  async function listAttendeeReviewDigestCandidates(input: {
    now: Date;
    windowMs: number;
    limit?: number;
  }): Promise<AttendeeReviewDigestCandidate[]> {
    const windowStart = new Date(input.now.getTime() - input.windowMs);

    // In-window ended events with >= 1 scanned ticket (mirrors the attendee
    // enqueue candidate query — Event.endsAt is non-nullable).
    const events = await p.event.findMany({
      where: {
        status: { in: [...PROMPTABLE_EVENT_STATUSES] },
        tickets: { some: { status: "SCANNED" } },
        endsAt: { gt: windowStart, lte: input.now },
      },
      select: {
        id: true,
        title: true,
        endsAt: true,
        place: { select: { name: true } },
        tickets: {
          where: { status: "SCANNED" },
          select: { ownerHumanId: true },
          distinct: ["ownerHumanId"],
        },
        attendeeReviews: { select: { humanId: true } },
      },
    });

    // humanId -> shows[]
    const byHuman = new Map<string, AttendeeReviewDigestShow[]>();

    for (const event of events) {
      const eventEnd = event.endsAt;
      const reviewedHumanIds = new Set(
        event.attendeeReviews.map((r) => r.humanId),
      );
      for (const ticket of event.tickets) {
        // Un-reviewed only: a human who already reviewed this event drops out.
        if (reviewedHumanIds.has(ticket.ownerHumanId)) continue;
        const show: AttendeeReviewDigestShow = {
          eventId: event.id,
          eventTitle: event.title,
          placeName: event.place?.name ?? null,
          eventEndsAt: eventEnd,
        };
        const bucket = byHuman.get(ticket.ownerHumanId);
        if (bucket) bucket.push(show);
        else byHuman.set(ticket.ownerHumanId, [show]);
      }
    }

    if (byHuman.size === 0) return [];

    const humanIds = Array.from(byHuman.keys());
    const humans = await p.human.findMany({
      where: { id: { in: humanIds } },
      select: {
        id: true,
        name: true,
        authUser: { select: { email: true } },
      },
    });
    const humanById = new Map(humans.map((h) => [h.id, h]));

    const candidates: AttendeeReviewDigestCandidate[] = [];
    for (const [humanId, shows] of byHuman) {
      const human = humanById.get(humanId);
      // Newest-ended show first for stable, readable copy.
      shows.sort((a, b) => b.eventEndsAt.getTime() - a.eventEndsAt.getTime());
      candidates.push({
        humanId,
        humanEmail: human?.authUser?.email ?? null,
        humanName: human?.name ?? null,
        shows,
      });
    }

    // Stable ordering so a bounded run is deterministic across retries.
    candidates.sort((a, b) => a.humanId.localeCompare(b.humanId));

    if (typeof input.limit === "number" && input.limit > 0) {
      return candidates.slice(0, input.limit);
    }
    return candidates;
  }

  async function hasAttendeeReviewSince(input: {
    humanId: string;
    since: Date;
  }): Promise<boolean> {
    const row = await p.attendeeReview.findFirst({
      where: { humanId: input.humanId, createdAt: { gt: input.since } },
      select: { id: true },
    });
    return row !== null;
  }

  async function recordDigestSent(input: {
    humanId: string;
    digestType: NotificationDigestType;
    sentAt: Date;
  }): Promise<NotificationDigestSubscriptionRecord> {
    const record = await p.notificationDigestSubscription.upsert({
      where: {
        humanId_digestType: {
          humanId: input.humanId,
          digestType: input.digestType,
        },
      },
      update: {
        consecutiveIgnored: { increment: 1 },
        lastDigestSentAt: input.sentAt,
      },
      create: {
        humanId: input.humanId,
        digestType: input.digestType,
        subscribed: true,
        consecutiveIgnored: 1,
        lastDigestSentAt: input.sentAt,
      },
    });
    return toSubscriptionRecord(record);
  }

  async function resetConsecutiveIgnored(input: {
    humanId: string;
    digestType: NotificationDigestType;
  }): Promise<void> {
    // updateMany is a no-op (count 0) when no row exists — the default counter
    // is already 0, so there is nothing to reset.
    await p.notificationDigestSubscription.updateMany({
      where: { humanId: input.humanId, digestType: input.digestType },
      data: { consecutiveIgnored: 0 },
    });
  }

  return {
    listOrganizerMetrics,
    listUpcomingEvents,
    listCompletedEventOrders,
    listAttendeeFeedbackDue,
    markFeedbackSent,
    ensureFeedbackRequest,
    recordDigestLog,
    findDigestLogByHash,
    getSubscription,
    upsertSubscription,
    listAttendeeReviewDigestCandidates,
    hasAttendeeReviewSince,
    recordDigestSent,
    resetConsecutiveIgnored,
  };
}
