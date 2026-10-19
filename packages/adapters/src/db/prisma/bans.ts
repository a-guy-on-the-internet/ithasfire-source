import { Prisma } from "@prisma/client";
import type { BansRepo } from "@th/ports/repos/bans";

import { resolveWithheldOwners } from "./banned-owner";
import type { PrismaClientOrTx } from "./types";

export function makeBansRepo(p: PrismaClientOrTx): BansRepo {
  return {
    async recordForHuman({ humanId, rows }) {
      if (rows.length === 0) return { count: 0 };
      // UPSERT per (source, kind, value): a re-ban never shortens coverage.
      // Expiry keeps the LATER of the two, and NULL (never expires) wins.
      let count = 0;
      for (const row of rows) {
        count += await p.$executeRaw(Prisma.sql`
          INSERT INTO banned_identity
            (id, kind, value_hash, source_human_id, expires_at)
          VALUES (
            gen_random_uuid()::text,
            ${row.kind}::"BannedIdentityKind",
            ${row.valueHash},
            ${humanId},
            ${row.expiresAt}::timestamp
          )
          ON CONFLICT (source_human_id, kind, value_hash) DO UPDATE SET
            expires_at = CASE
              WHEN banned_identity.expires_at IS NULL
                OR EXCLUDED.expires_at IS NULL THEN NULL
              ELSE GREATEST(banned_identity.expires_at, EXCLUDED.expires_at)
            END
        `);
      }
      return { count };
    },

    async removeForHuman(humanId) {
      const { count } = await p.bannedIdentity.deleteMany({
        where: { sourceHumanId: humanId },
      });
      return { count };
    },

    async isActive({ kind, valueHash, now }) {
      const row = await p.bannedIdentity.findFirst({
        where: {
          kind,
          valueHash,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        select: { id: true },
      });
      return row !== null;
    },

    async purgeExpired({ before }) {
      const { count } = await p.bannedIdentity.deleteMany({
        where: { expiresAt: { lt: before } },
      });
      return { count };
    },

    async findBannedOwners({ humanIds, orgIds }) {
      // The SAME withheld set the public list reads filter on
      // (banned-owner.ts), so a single-page check can never disagree with a
      // listing. One small query; bans are rare.
      if (humanIds.length === 0 && orgIds.length === 0) {
        return { humanIds: [], orgIds: [] };
      }
      const withheld = await resolveWithheldOwners(p);
      const h = new Set(withheld.humanIds);
      const o = new Set(withheld.orgIds);
      return {
        humanIds: [...new Set(humanIds)].filter((id) => h.has(id)),
        orgIds: [...new Set(orgIds)].filter((id) => o.has(id)),
      };
    },

    async listWithheldOwners() {
      return resolveWithheldOwners(p);
    },
  };
}
