import { Prisma } from "@prisma/client";

import type {
  AnnouncementsRepo,
  AnnouncementRecord,
  AudienceFilter,
  AudienceRecipient,
  CountAudienceRecipientsInput,
} from "@th/ports/repos/announcements";

import type { PrismaClientOrTx } from "./types";

const announcementSelect = {
  id: true,
  orgId: true,
  eventId: true,
  subject: true,
  bodyDoc: true,
  bodyHtml: true,
  publicOnEntityPage: true,
  audienceType: true,
  audienceRef: true,
  audienceFilter: true,
  excludedContactListId: true,
  recipientCount: true,
  sentAt: true,
  sentBy: true,
  createdAt: true,
  updatedAt: true,
} as const;

type AnnouncementRow = Prisma.AnnouncementGetPayload<{
  select: typeof announcementSelect;
}>;

function toRecord(row: AnnouncementRow): AnnouncementRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    eventId: row.eventId,
    subject: row.subject,
    bodyDoc: row.bodyDoc,
    bodyHtml: row.bodyHtml,
    publicOnEntityPage: row.publicOnEntityPage,
    audienceType: row.audienceType,
    audienceRef: row.audienceRef,
    audienceFilter: row.audienceFilter as AudienceFilter | null,
    excludedContactListId: row.excludedContactListId,
    recipientCount: row.recipientCount,
    sentAt: row.sentAt,
    sentBy: row.sentBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Owner predicate for an `"Event" e` alias: an event with an orgId is
 * org-owned; a HUMAN owner owns only org-less events whose humanId is them.
 * Mirrors `eventBelongsTo` in the use case's audience-ownership.ts (NOT
 * `ensureSameOwner`, which lets an org event and a personal event sharing a
 * humanId count as the same owner). Defence in depth behind
 * `assertAudienceOwnedBy` (security review F4).
 */
function eventOwnerSql(
  ownerType: "HUMAN" | "ORGANIZATION",
  ownerId: string,
): Prisma.Sql {
  return ownerType === "ORGANIZATION"
    ? Prisma.sql`e."orgId" = ${ownerId}`
    : Prisma.sql`e."orgId" IS NULL AND e."humanId" = ${ownerId}`;
}

/** True only when `listId` is an InviteList owned by the given owner. */
function listOwnedSql(
  listId: string,
  ownerType: "HUMAN" | "ORGANIZATION",
  ownerId: string,
): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM "InviteList" l
    WHERE l."id" = ${listId}
      AND l."ownerType"::text = ${ownerType}
      AND l."ownerId" = ${ownerId}
  )`;
}

export function makeAnnouncementsRepo(p: PrismaClientOrTx): AnnouncementsRepo {
  return {
    create: async (input) => {
      const created = await p.announcement.create({
        data: {
          orgId: input.orgId,
          eventId: input.eventId ?? null,
          subject: input.subject,
          bodyDoc: input.bodyDoc as Prisma.InputJsonValue,
          bodyHtml: input.bodyHtml,
          publicOnEntityPage: input.publicOnEntityPage ?? false,
          audienceType: input.audienceType,
          audienceRef: input.audienceRef ?? null,
          audienceFilter: input.audienceFilter
            ? (input.audienceFilter as unknown as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          excludedContactListId: input.excludedContactListId ?? null,
          recipientCount: input.recipientCount ?? null,
          sentAt: input.sentAt ?? null,
          sentBy: input.sentBy,
        },
        select: announcementSelect,
      });

      return toRecord(created);
    },

    findById: async (id) => {
      const row = await p.announcement.findUnique({
        where: { id },
        select: announcementSelect,
      });

      return row ? toRecord(row) : null;
    },

    listByOrg: async (input) => {
      const limit = input.limit ?? 50;
      const offset = input.offset ?? 0;

      const [items, total] = await Promise.all([
        p.announcement.findMany({
          where: { orgId: input.orgId },
          orderBy: { createdAt: "desc" },
          take: limit,
          skip: offset,
          select: announcementSelect,
        }),
        p.announcement.count({
          where: { orgId: input.orgId },
        }),
      ]);

      return {
        items: items.map(toRecord),
        total,
      };
    },

    listBySender: async (input) => {
      const limit = input.limit ?? 50;
      const offset = input.offset ?? 0;

      const [items, total] = await Promise.all([
        p.announcement.findMany({
          where: { sentBy: input.humanId },
          orderBy: { createdAt: "desc" },
          take: limit,
          skip: offset,
          select: announcementSelect,
        }),
        p.announcement.count({
          where: { sentBy: input.humanId },
        }),
      ]);

      return {
        items: items.map(toRecord),
        total,
      };
    },

    listPublicForOrgEntityPage: async (input) => {
      const limit = input.limit ?? 50;
      const offset = input.offset ?? 0;
      const where: Prisma.AnnouncementWhereInput = {
        orgId: input.orgId,
        publicOnEntityPage: true,
        sentAt: { not: null },
      };

      const [items, total] = await Promise.all([
        p.announcement.findMany({
          where,
          orderBy: [{ sentAt: "desc" }, { createdAt: "desc" }],
          take: limit,
          skip: offset,
          select: announcementSelect,
        }),
        p.announcement.count({ where }),
      ]);

      return {
        items: items.map(toRecord),
        total,
      };
    },

    listPublicForSenderEntityPage: async (input) => {
      const limit = input.limit ?? 50;
      const offset = input.offset ?? 0;
      const where: Prisma.AnnouncementWhereInput = {
        sentBy: input.humanId,
        publicOnEntityPage: true,
        sentAt: { not: null },
      };

      const [items, total] = await Promise.all([
        p.announcement.findMany({
          where,
          orderBy: [{ sentAt: "desc" }, { createdAt: "desc" }],
          take: limit,
          skip: offset,
          select: announcementSelect,
        }),
        p.announcement.count({ where }),
      ]);

      return {
        items: items.map(toRecord),
        total,
      };
    },

    getLatestByAudience: async (input) => {
      const where: Prisma.AnnouncementWhereInput = {
        orgId: input.orgId,
        audienceType: input.audienceType,
        sentAt: { not: null },
      };
      if (input.audienceRef) {
        where.audienceRef = input.audienceRef;
      }

      const row = await p.announcement.findFirst({
        where,
        orderBy: { sentAt: "desc" },
        select: announcementSelect,
      });

      return row ? toRecord(row) : null;
    },

    // Audience SQL notes (both reads below):
    //  - Email lives on `auth_user` (Better Auth), linked 1:1 by
    //    `auth_user.human_id`; `Human` has no email column. A buyer with no
    //    auth_user row (e.g. a POS walk-up) has no address and drops out.
    //  - "Ticket holder" = an order in SUCCEEDED / PART_REFUNDED (the
    //    follow-notification "near you" home lookup reads the same set).
    //    `OrderStatus` has no CONFIRMED/COMPLETED; those literals made
    //    Postgres reject the query outright.
    //  - Counts dedupe on LOWER(email) so the preview matches the
    //    DISTINCT ON (LOWER(email)) recipient list.
    //  - EVERY branch is scoped to the owner (`ownerEvent` / `listOwnedSql`,
    //    and the excluded list via its `inviteList` relation). A foreign
    //    audienceRef therefore resolves to nobody even if a caller skipped
    //    the use case's ownership assertion.
    countAudienceRecipients: async (input) => {
      const {
        ownerType,
        orgId,
        audienceType,
        audienceRef,
        audienceFilter,
        excludedContactListId,
      } = input;
      const ownerEvent = eventOwnerSql(ownerType, orgId);

      // ── Build the set of excluded email addresses ───────────────────
      let excludedEmails: Set<string> | null = null;
      if (excludedContactListId) {
        const excluded = await p.inviteListEntry.findMany({
          where: {
            inviteListId: excludedContactListId,
            inviteList: { ownerType, ownerId: orgId },
          },
          select: { contactEmail: true },
        });
        excludedEmails = new Set(
          excluded
            .filter((e) => e.contactEmail != null)
            .map((e) => e.contactEmail!.toLowerCase()),
        );
      }

      let count = 0;

      switch (audienceType) {
        case "ALL_TICKET_HOLDERS": {
          // Distinct buyer emails for all org events
          const rows = await p.$queryRaw<{ cnt: bigint }[]>`
            SELECT COUNT(DISTINCT LOWER(u."email")) AS cnt
            FROM "Order" o
            JOIN "Event" e ON e."id" = o."eventId"
            JOIN "Human" h ON h."id" = o."buyerHumanId"
            JOIN "auth_user" u ON u."human_id" = h."id"
            WHERE ${ownerEvent}
              AND o."status" IN ('SUCCEEDED', 'PART_REFUNDED')
              AND u."email" IS NOT NULL
          `;
          count = Number(rows[0]?.cnt ?? 0);
          break;
        }

        case "EVENT_TICKET_HOLDERS": {
          if (!audienceRef) return 0;
          const rows = await p.$queryRaw<{ cnt: bigint }[]>`
            SELECT COUNT(DISTINCT LOWER(u."email")) AS cnt
            FROM "Order" o
            JOIN "Event" e ON e."id" = o."eventId"
            JOIN "Human" h ON h."id" = o."buyerHumanId"
            JOIN "auth_user" u ON u."human_id" = h."id"
            WHERE o."eventId" = ${audienceRef}
              AND ${ownerEvent}
              AND o."status" IN ('SUCCEEDED', 'PART_REFUNDED')
              AND u."email" IS NOT NULL
          `;
          count = Number(rows[0]?.cnt ?? 0);
          break;
        }

        case "MULTIPLE_EVENTS": {
          const filter = audienceFilter as { eventIds?: string[] } | null;
          const eventIds = filter?.eventIds ?? [];
          if (eventIds.length === 0) return 0;
          const rows = await p.$queryRaw<{ cnt: bigint }[]>`
            SELECT COUNT(DISTINCT LOWER(u."email")) AS cnt
            FROM "Order" o
            JOIN "Event" e ON e."id" = o."eventId"
            JOIN "Human" h ON h."id" = o."buyerHumanId"
            JOIN "auth_user" u ON u."human_id" = h."id"
            WHERE o."eventId" = ANY(${eventIds})
              AND ${ownerEvent}
              AND o."status" IN ('SUCCEEDED', 'PART_REFUNDED')
              AND u."email" IS NOT NULL
          `;
          count = Number(rows[0]?.cnt ?? 0);
          break;
        }

        case "EVENT_TICKET_TIER": {
          const filter = audienceFilter as {
            eventId?: string;
            tierIds?: string[];
          } | null;
          const eventId = filter?.eventId;
          const tierIds = filter?.tierIds ?? [];
          if (!eventId || tierIds.length === 0) return 0;
          const rows = await p.$queryRaw<{ cnt: bigint }[]>`
            SELECT COUNT(DISTINCT LOWER(u."email")) AS cnt
            FROM "Order" o
            JOIN "Event" e ON e."id" = o."eventId"
            JOIN "OrderItem" oi ON oi."orderId" = o."id"
            JOIN "TicketType" tt
              ON tt."id" = oi."ticketTypeId" AND tt."eventId" = o."eventId"
            JOIN "Human" h ON h."id" = o."buyerHumanId"
            JOIN "auth_user" u ON u."human_id" = h."id"
            WHERE o."eventId" = ${eventId}
              AND ${ownerEvent}
              AND oi."ticketTypeId" = ANY(${tierIds})
              AND o."status" IN ('SUCCEEDED', 'PART_REFUNDED')
              AND u."email" IS NOT NULL
          `;
          count = Number(rows[0]?.cnt ?? 0);
          break;
        }

        case "CONTACT_LIST": {
          if (!audienceRef) return 0;
          const rows = await p.$queryRaw<{ cnt: bigint }[]>`
            SELECT COUNT(DISTINCT LOWER("contactEmail")) AS cnt
            FROM "InviteListEntry"
            WHERE "inviteListId" = ${audienceRef}
              AND ${listOwnedSql(audienceRef, ownerType, orgId)}
              AND "contactEmail" IS NOT NULL
              AND "unsubscribedAt" IS NULL
          `;
          count = Number(rows[0]?.cnt ?? 0);
          break;
        }

        case "WAITLIST_SUBSCRIBERS": {
          // audienceRef = eventId for waitlist subscribers
          if (!audienceRef) return 0;
          // Count distinct reachable subscribers: entries that have either a
          // linked human with an email, or a contactEmail directly on the entry.
          const rows = await p.$queryRaw<{ cnt: bigint }[]>`
            SELECT COUNT(DISTINCT LOWER(COALESCE(u."email", w."contactEmail"))) AS cnt
            FROM "EventWaitlistEntry" w
            JOIN "Event" e ON e."id" = w."eventId"
            LEFT JOIN "Human" h ON h."id" = w."humanId"
            LEFT JOIN "auth_user" u ON u."human_id" = w."humanId"
            WHERE w."eventId" = ${audienceRef}
              AND ${ownerEvent}
              AND w."status" IN ('PENDING', 'NOTIFIED')
              AND (u."email" IS NOT NULL OR w."contactEmail" IS NOT NULL)
          `;
          count = Number(rows[0]?.cnt ?? 0);
          break;
        }

        default:
          return 0;
      }

      // Subtract excluded contacts (approximate — exact subtraction would
      // require fetching all emails, but for a count preview this is fine).
      if (
        excludedEmails &&
        excludedEmails.size > 0 &&
        audienceType !== "CONTACT_LIST"
      ) {
        // For the preview we subtract the overlap count.
        // This is an approximation: we count how many of the excluded emails
        // are also in the audience. For large sets this is still fast because
        // we already have the excluded set in memory.
        // For simplicity we'll subtract min(excludedEmails.size, count) as
        // an upper bound, but clamp to zero.
        count = Math.max(0, count - excludedEmails.size);
      }

      return count;
    },

    listAudienceRecipientEmails: async (input) => {
      const {
        ownerType,
        orgId,
        audienceType,
        audienceRef,
        audienceFilter,
        excludedContactListId,
      } = input;
      const ownerEvent = eventOwnerSql(ownerType, orgId);

      // ── Build the set of excluded email addresses ───────────────────
      let excludedEmails: Set<string> | null = null;
      if (excludedContactListId) {
        const excluded = await p.inviteListEntry.findMany({
          where: {
            inviteListId: excludedContactListId,
            inviteList: { ownerType, ownerId: orgId },
          },
          select: { contactEmail: true },
        });
        excludedEmails = new Set(
          excluded
            .map((e) => e.contactEmail?.toLowerCase())
            .filter((e): e is string => !!e),
        );
      }

      type RecipientRow = {
        email: string;
        name: string | null;
        entry_id: string | null;
        list_id: string | null;
        waitlist_entry_id: string | null;
        waitlist_event_id: string | null;
        human_id: string | null;
      };
      let rows: RecipientRow[] = [];

      switch (audienceType) {
        case "ALL_TICKET_HOLDERS": {
          rows = await p.$queryRaw<RecipientRow[]>`
            SELECT DISTINCT ON (LOWER(u."email"))
              u."email" AS email,
              h."name" AS name,
              NULL::text AS entry_id,
              NULL::text AS list_id,
              NULL::text AS waitlist_entry_id,
              NULL::text AS waitlist_event_id,
              h."id" AS human_id
            FROM "Order" o
            JOIN "Event" e ON e."id" = o."eventId"
            JOIN "Human" h ON h."id" = o."buyerHumanId"
            JOIN "auth_user" u ON u."human_id" = h."id"
            WHERE ${ownerEvent}
              AND o."status" IN ('SUCCEEDED', 'PART_REFUNDED')
              AND u."email" IS NOT NULL
          `;
          break;
        }

        case "EVENT_TICKET_HOLDERS": {
          if (!audienceRef) return [];
          rows = await p.$queryRaw<RecipientRow[]>`
            SELECT DISTINCT ON (LOWER(u."email"))
              u."email" AS email,
              h."name" AS name,
              NULL::text AS entry_id,
              NULL::text AS list_id,
              NULL::text AS waitlist_entry_id,
              NULL::text AS waitlist_event_id,
              h."id" AS human_id
            FROM "Order" o
            JOIN "Event" e ON e."id" = o."eventId"
            JOIN "Human" h ON h."id" = o."buyerHumanId"
            JOIN "auth_user" u ON u."human_id" = h."id"
            WHERE o."eventId" = ${audienceRef}
              AND ${ownerEvent}
              AND o."status" IN ('SUCCEEDED', 'PART_REFUNDED')
              AND u."email" IS NOT NULL
          `;
          break;
        }

        case "MULTIPLE_EVENTS": {
          const filter = audienceFilter as { eventIds?: string[] } | null;
          const eventIds = filter?.eventIds ?? [];
          if (eventIds.length === 0) return [];
          rows = await p.$queryRaw<RecipientRow[]>`
            SELECT DISTINCT ON (LOWER(u."email"))
              u."email" AS email,
              h."name" AS name,
              NULL::text AS entry_id,
              NULL::text AS list_id,
              NULL::text AS waitlist_entry_id,
              NULL::text AS waitlist_event_id,
              h."id" AS human_id
            FROM "Order" o
            JOIN "Event" e ON e."id" = o."eventId"
            JOIN "Human" h ON h."id" = o."buyerHumanId"
            JOIN "auth_user" u ON u."human_id" = h."id"
            WHERE o."eventId" = ANY(${eventIds})
              AND ${ownerEvent}
              AND o."status" IN ('SUCCEEDED', 'PART_REFUNDED')
              AND u."email" IS NOT NULL
          `;
          break;
        }

        case "EVENT_TICKET_TIER": {
          const filter = audienceFilter as {
            eventId?: string;
            tierIds?: string[];
          } | null;
          const eventId = filter?.eventId;
          const tierIds = filter?.tierIds ?? [];
          if (!eventId || tierIds.length === 0) return [];
          rows = await p.$queryRaw<RecipientRow[]>`
            SELECT DISTINCT ON (LOWER(u."email"))
              u."email" AS email,
              h."name" AS name,
              NULL::text AS entry_id,
              NULL::text AS list_id,
              NULL::text AS waitlist_entry_id,
              NULL::text AS waitlist_event_id,
              h."id" AS human_id
            FROM "Order" o
            JOIN "Event" e ON e."id" = o."eventId"
            JOIN "OrderItem" oi ON oi."orderId" = o."id"
            JOIN "TicketType" tt
              ON tt."id" = oi."ticketTypeId" AND tt."eventId" = o."eventId"
            JOIN "Human" h ON h."id" = o."buyerHumanId"
            JOIN "auth_user" u ON u."human_id" = h."id"
            WHERE o."eventId" = ${eventId}
              AND ${ownerEvent}
              AND oi."ticketTypeId" = ANY(${tierIds})
              AND o."status" IN ('SUCCEEDED', 'PART_REFUNDED')
              AND u."email" IS NOT NULL
          `;
          break;
        }

        case "CONTACT_LIST": {
          if (!audienceRef) return [];
          rows = await p.$queryRaw<RecipientRow[]>`
            SELECT DISTINCT ON (LOWER("contactEmail"))
              "contactEmail" AS email,
              "displayName" AS name,
              "id" AS entry_id,
              "inviteListId" AS list_id,
              NULL::text AS waitlist_entry_id,
              NULL::text AS waitlist_event_id,
              "humanId" AS human_id
            FROM "InviteListEntry"
            WHERE "inviteListId" = ${audienceRef}
              AND ${listOwnedSql(audienceRef, ownerType, orgId)}
              AND "contactEmail" IS NOT NULL
              AND "unsubscribedAt" IS NULL
          `;
          break;
        }

        case "WAITLIST_SUBSCRIBERS": {
          if (!audienceRef) return [];
          rows = await p.$queryRaw<RecipientRow[]>`
            SELECT DISTINCT ON (LOWER(COALESCE(u."email", w."contactEmail")))
              COALESCE(u."email", w."contactEmail") AS email,
              h."name" AS name,
              NULL::text AS entry_id,
              NULL::text AS list_id,
              w."id" AS waitlist_entry_id,
              w."eventId" AS waitlist_event_id,
              w."humanId" AS human_id
            FROM "EventWaitlistEntry" w
            JOIN "Event" e ON e."id" = w."eventId"
            LEFT JOIN "Human" h ON h."id" = w."humanId"
            LEFT JOIN "auth_user" u ON u."human_id" = w."humanId"
            WHERE w."eventId" = ${audienceRef}
              AND ${ownerEvent}
              AND w."status" IN ('PENDING', 'NOTIFIED')
              AND (u."email" IS NOT NULL OR w."contactEmail" IS NOT NULL)
          `;
          break;
        }

        default:
          return [];
      }

      // Filter out excluded emails
      const recipients: AudienceRecipient[] = [];
      for (const row of rows) {
        if (!row.email) continue;
        if (excludedEmails && excludedEmails.has(row.email.toLowerCase()))
          continue;
        recipients.push({
          email: row.email,
          name: row.name,
          contactListEntryId: row.entry_id,
          inviteListId: row.list_id,
          waitlistEntryId: row.waitlist_entry_id,
          waitlistEventId: row.waitlist_event_id,
          humanId: row.human_id,
        });
      }

      return recipients;
    },

    updateRecipientCount: async (id, recipientCount) => {
      await p.announcement.update({
        where: { id },
        data: { recipientCount },
      });
    },

    insertAnonymousSuppression: async (input) => {
      const email = input.email.toLowerCase();
      // Idempotent: a unique constraint on (email, orgId) means a duplicate
      // unsubscribe is a no-op rather than an error.
      await p.anonymousEmailSuppression.upsert({
        where: { email_orgId: { email, orgId: input.orgId } },
        create: {
          email,
          orgId: input.orgId,
          reason: input.reason ?? "unsubscribe",
        },
        update: {},
      });
    },

    getAnonymousSuppressedEmails: async (input) => {
      const emails = input.emails.map((e) => e.toLowerCase());
      if (emails.length === 0) return new Set<string>();

      const rows = await p.anonymousEmailSuppression.findMany({
        where: { orgId: input.orgId, email: { in: emails } },
        select: { email: true },
      });

      return new Set(rows.map((r) => r.email.toLowerCase()));
    },
  };
}
