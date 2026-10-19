import { Prisma } from "@prisma/client";
import type { EntityEventDelivery, EntityEventNoticesRepo, ExpandAudienceStep, FollowerHomeCandidate } from "@th/ports/repos/entity-event-notices";
import type { PrismaClientOrTx } from "./types";

export function makeEntityEventNoticesRepo(p: PrismaClientOrTx): EntityEventNoticesRepo {
  return {
    async enqueue({entityPageId, eventId, at}) {
      await p.entityEventNotice.createMany({data: [{entityPageId, eventId, createdAt: at}], skipDuplicates: true});
    },
    async expandAudience({limit, now}) {
      const cap = Math.min(500, Math.max(1, limit));
      // One open notice, locked. Its event decides whether it may still
      // expand: a started (or deleted) event closes the notice with a reason
      // and writes no deliveries. ON CONFLICT with no target covers BOTH
      // unique keys, so a follower already reached for this event through
      // another followed page is skipped, not re-sent.
      const rows = await p.$queryRaw<{noticeId: string; inserted: number; closedReason: string | null}[]>(Prisma.sql`
        WITH notice AS (
          SELECT n.*, e."startsAt" AS "eventStartsAt", (e."id" IS NULL) AS "eventGone"
          FROM "EntityEventNotice" n LEFT JOIN "Event" e ON e."id" = n."eventId"
          WHERE NOT n."expanded"
          ORDER BY n."createdAt", n."id" LIMIT 1 FOR UPDATE OF n SKIP LOCKED
        ), open_notice AS (
          SELECT * FROM notice WHERE NOT "eventGone" AND "eventStartsAt" > ${now}
        ), audience AS (
          SELECT f."id", f."followerHumanId", n."id" AS "noticeId", n."eventId"
          FROM "EntityFollow" f CROSS JOIN open_notice n
          WHERE f."entityPageId" = n."entityPageId" AND f."createdAt" <= n."createdAt"
            AND (n."audienceCursor" IS NULL OR f."id" > n."audienceCursor")
          ORDER BY f."id" LIMIT ${cap}
        ), inserted AS (
          INSERT INTO "EntityEventDelivery" ("id", "noticeId", "eventId", "humanId", "followId")
          SELECT gen_random_uuid()::text, "noticeId", "eventId", "followerHumanId", "id" FROM audience
          ON CONFLICT DO NOTHING RETURNING "id"
        ), advanced AS (
          UPDATE "EntityEventNotice" n SET
            "audienceCursor" = COALESCE((SELECT max("id") FROM audience), n."audienceCursor"),
            "expanded" = notice."eventGone" OR notice."eventStartsAt" <= ${now} OR (SELECT count(*) FROM audience) < ${cap},
            "closedReason" = CASE WHEN notice."eventGone" THEN 'EVENT_GONE'
                                  WHEN notice."eventStartsAt" <= ${now} THEN 'EVENT_STARTED'
                                  ELSE NULL END
          FROM notice WHERE n."id" = notice."id" RETURNING n."id", n."closedReason"
        ) SELECT a."id" AS "noticeId", (SELECT count(*)::int FROM inserted) AS "inserted", a."closedReason"
          FROM advanced a
      `);
      const row = rows[0];
      return row ? {noticeId: row.noticeId, inserted: row.inserted, closedReason: row.closedReason as ExpandAudienceStep["closedReason"]} : null;
    },
    async claim({now, leaseUntil, token}) {
      const rows = await p.$queryRaw<EntityEventDelivery[]>(Prisma.sql`
        WITH candidate AS (
          SELECT "id" FROM "EntityEventDelivery"
          WHERE "finishedAt" IS NULL AND "nextAttemptAt" <= ${now}
            AND ("leaseUntil" IS NULL OR "leaseUntil" <= ${now})
          ORDER BY "nextAttemptAt", "id" LIMIT 1 FOR UPDATE SKIP LOCKED
        ), claimed AS (
          UPDATE "EntityEventDelivery" d SET "leaseToken" = ${token}, "leaseUntil" = ${leaseUntil}
          FROM candidate WHERE d."id" = candidate."id" RETURNING d.*
        ) SELECT c.*, n."entityPageId", n."eventId", n."createdAt"
          FROM claimed c JOIN "EntityEventNotice" n ON n."id" = c."noticeId"
      `);
      return rows[0] ?? null;
    },
    async renew(id, token, now, leaseUntil) {
      const result = await p.entityEventDelivery.updateMany({where: {id, leaseToken: token, leaseUntil: {gt: now}, finishedAt: null}, data: {leaseUntil}});
      return result.count === 1;
    },
    async settleChannel(id, token, channel, now) {
      const field = channel === "in_app" ? "inAppDone" : channel === "email" ? "emailDone" : "pushDone";
      const result = await p.entityEventDelivery.updateMany({
        where: {id, leaseToken: token, leaseUntil: {gt: now}, finishedAt: null},
        data: {[field]: true},
      });
      return result.count === 1;
    },
    async finish(id, token, now, reason) {
      await p.entityEventDelivery.updateMany({where: {id, leaseToken: token, leaseUntil: {gt: now}}, data: {finishedAt: now, finishReason: reason, leaseToken: null, leaseUntil: null}});
    },
    async retry(id, token, retryAt, now) {
      await p.entityEventDelivery.updateMany({where: {id, leaseToken: token, leaseUntil: {gt: now}}, data: {nextAttemptAt: retryAt, attempts: {increment: 1}, leaseToken: null, leaseUntil: null}});
    },
    async followerHomeCandidates(humanId, limit) {
      const orders = await p.order.findMany({
        where: {buyerHumanId: humanId, kind: "TICKETING", status: {in: ["SUCCEEDED", "PART_REFUNDED"]}, eventId: {not: null}},
        orderBy: [{occurredAt: "desc"}, {id: "desc"}],
        take: Math.min(50, Math.max(1, limit)),
        // Exactly the public projection's inputs. No savedLocation: it is not
        // an input of the public projection, so it cannot be a home point.
        select: {event: {select: {
          id: true, orgId: true, humanId: true, placeId: true, gateType: true, locationMode: true,
          locationRadiusMeters: true, locationLabel: true, addressText: true, lat: true, lng: true,
          locality: true, region: true, countryCode: true, postalCode: true,
          place: {select: {
            id: true, locationMode: true, locationRadiusMeters: true, locationLabel: true,
            address: true, addrLine1: true, addrLine2: true, city: true, region: true,
            postcode: true, country: true, lat: true, lng: true,
          }},
        }}},
      });
      const out: FollowerHomeCandidate[] = [];
      for (const {event: e} of orders) {
        if (!e) continue;
        const {place: pl, ...event} = e;
        out.push({
          event,
          place: pl ? {
            id: pl.id, locationMode: pl.locationMode, locationRadiusMeters: pl.locationRadiusMeters,
            locationLabel: pl.locationLabel, formattedAddress: pl.address, addressLine1: pl.addrLine1,
            addressLine2: pl.addrLine2, city: pl.city, region: pl.region, postalCode: pl.postcode,
            countryCode: pl.country, lat: pl.lat, lng: pl.lng,
          } : null,
        });
      }
      return out;
    },
    async purgeStartedBefore(cutoff) {
      const notices = await p.$executeRaw(Prisma.sql`
        DELETE FROM "EntityEventNotice" n
        WHERE NOT EXISTS (SELECT 1 FROM "Event" e WHERE e."id" = n."eventId")
           OR EXISTS (SELECT 1 FROM "Event" e WHERE e."id" = n."eventId" AND e."startsAt" < ${cutoff})
      `);
      return {notices};
    },
  };
}
