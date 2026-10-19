import { Prisma } from "@prisma/client";
import type {
  FlaggedSignupRecord,
  NetworkSightingsRepo,
} from "@th/ports/repos/network-sightings";

import type { PrismaClientOrTx } from "./types";

type FlaggedRow = {
  humanId: string;
  authUserId: string;
  name: string | null;
  email: string;
  status: FlaggedSignupRecord["status"];
  signedUpAt: Date;
  country: string | null;
  bannedHumanIds: string[];
  total: number;
};

export function makeNetworkSightingsRepo(
  p: PrismaClientOrTx,
): NetworkSightingsRepo {
  return {
    async record(input) {
      await p.networkSighting.create({
        data: {
          authUserId: input.authUserId,
          humanId: input.humanId,
          kind: input.kind,
          ipHash: input.ipHash,
          networkHash: input.networkHash,
          country: input.country,
          userAgentFamily: input.userAgentFamily,
        },
        select: { id: true },
      });
    },

    async listNetworkHashesForHuman({ humanId, since }) {
      // A sign-up's first session is written before the Human is linked, so
      // some rows carry only the AuthUser id: match either.
      const authUser = await p.authUser.findUnique({
        where: { humanId },
        select: { id: true },
      });
      const rows = await p.networkSighting.findMany({
        where: {
          createdAt: { gte: since },
          OR: [{ humanId }, ...(authUser ? [{ authUserId: authUser.id }] : [])],
        },
        select: { networkHash: true },
        distinct: ["networkHash"],
      });
      return rows.map((r) => r.networkHash);
    },

    async listFlaggedSignups({ since, now, limit, offset }) {
      // Derived on every read: recent SIGN_UP sightings joined to NETWORK
      // ban rows active at `now`. Nothing about the flag is stored.
      const rows = await p.$queryRaw<FlaggedRow[]>(Prisma.sql`
        WITH matched AS (
          SELECT
            COALESCE(s.human_id, au.human_id) AS human_id,
            s.created_at,
            s.country,
            b.source_human_id
          FROM network_sighting s
          JOIN auth_user au ON au.id = s.auth_user_id
          JOIN banned_identity b
            ON b.kind = 'NETWORK'::"BannedIdentityKind"
           AND b.value_hash = s.network_hash
           AND (b.expires_at IS NULL OR b.expires_at > ${now}::timestamp)
          WHERE s.kind = 'SIGN_UP'::"NetworkSightingKind"
            AND s.created_at >= ${since}::timestamp
            AND b.source_human_id IS NOT NULL
            AND COALESCE(s.human_id, au.human_id) IS NOT NULL
            AND COALESCE(s.human_id, au.human_id) <> b.source_human_id
        ),
        per_human AS (
          SELECT
            m.human_id,
            max(m.created_at) AS signed_up_at,
            (array_agg(m.country ORDER BY m.created_at DESC))[1] AS country,
            array_agg(DISTINCT m.source_human_id) AS banned_human_ids
          FROM matched m
          GROUP BY m.human_id
        )
        SELECT
          ph.human_id AS "humanId",
          au.id AS "authUserId",
          h.name AS "name",
          au.email AS "email",
          h.status::text AS "status",
          ph.signed_up_at AS "signedUpAt",
          ph.country AS "country",
          ph.banned_human_ids AS "bannedHumanIds",
          count(*) OVER ()::int AS "total"
        FROM per_human ph
        JOIN "Human" h ON h.id = ph.human_id
        JOIN auth_user au ON au.human_id = ph.human_id
        ORDER BY ph.signed_up_at DESC, ph.human_id ASC
        LIMIT ${limit} OFFSET ${offset}
      `);

      const bannedIds = [...new Set(rows.flatMap((r) => r.bannedHumanIds))];
      const banned =
        bannedIds.length === 0
          ? []
          : await p.human.findMany({
              where: { id: { in: bannedIds } },
              select: { id: true, name: true, status: true },
            });
      const byId = new Map(banned.map((h) => [h.id, h]));

      return {
        total: rows.length > 0 ? Number(rows[0]!.total) : 0,
        items: rows.map((r) => ({
          humanId: r.humanId,
          authUserId: r.authUserId,
          name: r.name,
          email: r.email,
          status: r.status,
          signedUpAt: r.signedUpAt,
          country: r.country,
          matches: r.bannedHumanIds.map((bannedHumanId) => ({
            bannedHumanId,
            bannedHumanName: byId.get(bannedHumanId)?.name ?? null,
            // Rows only exist while the source is BANNED or SUSPENDED; a row
            // whose human vanished mid-read reads as BANNED (the stricter).
            bannedHumanStatus: byId.get(bannedHumanId)?.status ?? "BANNED",
          })),
        })),
      };
    },

    async purgeOlderThan({ before }) {
      const { count } = await p.networkSighting.deleteMany({
        where: { createdAt: { lt: before } },
      });
      return { count };
    },
  };
}
