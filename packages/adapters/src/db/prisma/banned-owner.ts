import { Prisma } from "@prisma/client";

import type { WithheldOwnerIds } from "@th/types/repos/events";

import type { PrismaClientOrTx } from "./types";

/**
 * THE RULE, in one place: which owners are withheld from public reads because
 * of a ban (ban-that-sticks, 2026-09-29).
 *
 *   - a HUMAN is withheld while `Human.status = 'BANNED'`;
 *   - an ORG is withheld while it has at least one OWNER member and NO OWNER
 *     member whose human is not BANNED (its sole owner — or every owner — is
 *     banned). An org with a second, un-banned owner stays up.
 *   - an EVENT is withheld when its owner (`humanId` or `orgId`; the two are
 *     exclusive) is withheld. Ownerless COMMUNITY listings never are.
 *
 * DERIVED at read time from `Human.status` — nothing is stored, nothing is
 * deleted, so reactivating the human brings every page, event and search
 * result straight back.
 *
 * HOW LIST READS APPLY IT. {@link resolveWithheldOwners} computes the whole
 * withheld set in ONE small query (a partial index on BANNED humans,
 * migration 20260929140000) and the list query filters on those ids. With no
 * bans the set is empty and the filter is omitted entirely, so an unbanned
 * platform runs byte-identical list SQL. (The first cut used a correlated
 * relation filter, which Postgres ran as uncorrelated hashed subplans over
 * every OWNER row on every discovery read — review round 1.)
 *
 * Raw-SQL reads embed the same set as uncorrelated subqueries
 * ({@link ownerIdsNotWithheldSql}) — one evaluation per statement, driven from
 * the banned humans, no extra round trip.
 *
 * NULL-SAFETY. Prisma renders `NOT: { humanId: { in: [...] } }` as
 * `NOT "humanId" IN (...)`, which is NULL — i.e. FALSE — for a NULL column,
 * so every org-owned and community event would vanish. Measured on the dev DB
 * (0 of 45 rows kept). The Prisma filter therefore spells out
 * `humanId IS NULL OR humanId NOT IN (...)` per column, and the raw SQL wraps
 * `IN (subquery)` in `COALESCE(..., FALSE)`. `__tests__/banned-owner.integration.test.ts`
 * pins this against a real database.
 */

/** The shared shape (`@th/types`), so the port and the adapter cannot drift. */
export type WithheldOwners = WithheldOwnerIds;

export const NO_WITHHELD_OWNERS: WithheldOwners = { humanIds: [], orgIds: [] };

export function hasWithheldOwners(w: WithheldOwners): boolean {
  return w.humanIds.length > 0 || w.orgIds.length > 0;
}

/**
 * SQL: the ids of BANNED humans. Served by the partial index
 * `Human_banned_id_idx` (migration 20260929140000).
 */
export const WITHHELD_HUMAN_IDS_SQL = Prisma.sql`
  SELECT bh.id FROM "Human" bh WHERE bh.status = 'BANNED'::"HumanStatus"
`;

/**
 * SQL: the ids of withheld orgs — an OWNER is banned and no OWNER is not.
 * Driven FROM the banned humans (small), never from all OWNER rows.
 */
export const WITHHELD_ORG_IDS_SQL = Prisma.sql`
  SELECT bm."orgId" FROM "OrgMember" bm
  JOIN "Human" bh ON bh.id = bm."humanId"
  WHERE bh.status = 'BANNED'::"HumanStatus"
    AND bm.role = 'OWNER'::"OrgRole"
    AND NOT EXISTS (
      SELECT 1 FROM "OrgMember" bm2
      JOIN "Human" bh2 ON bh2.id = bm2."humanId"
      WHERE bm2."orgId" = bm."orgId"
        AND bm2.role = 'OWNER'::"OrgRole"
        AND bh2.status <> 'BANNED'::"HumanStatus"
    )
`;

/** The whole withheld set, in one query (for Prisma `where` filters). */
export async function resolveWithheldOwners(
  p: PrismaClientOrTx,
): Promise<WithheldOwners> {
  const rows = await p.$queryRaw<Array<{ kind: "HUMAN" | "ORG"; id: string }>>(
    Prisma.sql`
      SELECT 'HUMAN'::text AS kind, h.id FROM (${WITHHELD_HUMAN_IDS_SQL}) h
      UNION
      SELECT 'ORG'::text AS kind, o."orgId" AS id FROM (${WITHHELD_ORG_IDS_SQL}) o
    `,
  );
  return {
    humanIds: rows.filter((r) => r.kind === "HUMAN").map((r) => r.id),
    orgIds: rows.filter((r) => r.kind === "ORG").map((r) => r.id),
  };
}

/**
 * SQL, for raw queries: the owner ids `humanIdExpr` / `orgIdExpr` are not
 * withheld. Uncorrelated subqueries over the (small) banned set, evaluated
 * once per statement; `COALESCE(..., FALSE)` keeps a NULL owner id (org
 * events, community listings) from turning the predicate NULL.
 */
export function ownerIdsNotWithheldSql(
  humanIdExpr: Prisma.Sql,
  orgIdExpr: Prisma.Sql,
): Prisma.Sql {
  return Prisma.sql`(
    NOT COALESCE(${humanIdExpr} IN (${WITHHELD_HUMAN_IDS_SQL}), FALSE)
    AND NOT COALESCE(${orgIdExpr} IN (${WITHHELD_ORG_IDS_SQL}), FALSE)
  )`;
}

/** SQL: the event aliased `alias` (trusted identifier) is not withheld. */
export function eventOwnerNotWithheldSubquerySql(alias = "e"): Prisma.Sql {
  return ownerIdsNotWithheldSql(
    Prisma.raw(`${alias}."humanId"`),
    Prisma.raw(`${alias}."orgId"`),
  );
}

/**
 * SQL for a SearchDocument row aliased `d`: a withheld human's profile, a
 * withheld org's page, and either owner's events are excluded.
 */
export const SEARCH_DOC_NOT_WITHHELD_SQL = Prisma.sql`(
  (d.type <> 'human'
    OR NOT COALESCE(d.human_id IN (${WITHHELD_HUMAN_IDS_SQL}), FALSE))
  AND (d.type <> 'organization'
    OR NOT COALESCE(d.org_id_ref IN (${WITHHELD_ORG_IDS_SQL}), FALSE))
  AND (d.type <> 'event'
    OR ${ownerIdsNotWithheldSql(Prisma.sql`d.owner_human_id`, Prisma.sql`d.org_id`)})
)`;

// ── Prisma where ───────────────────────────────────────────────────────────

/**
 * Prisma: the event is NOT withheld, as an element for an `AND: [...]` array.
 * Null when nothing is withheld (callers then add no filter at all).
 */
export function eventOwnerNotWithheldWhere(
  w: WithheldOwners,
): Prisma.EventWhereInput | null {
  const parts: Prisma.EventWhereInput[] = [];
  if (w.humanIds.length > 0) {
    parts.push({
      OR: [{ humanId: null }, { humanId: { notIn: [...w.humanIds] } }],
    });
  }
  if (w.orgIds.length > 0) {
    parts.push({ OR: [{ orgId: null }, { orgId: { notIn: [...w.orgIds] } }] });
  }
  return parts.length > 0 ? { AND: parts } : null;
}

/**
 * Merge the not-withheld filter into an existing `where` WITHOUT clobbering
 * its own `AND` key. Returns `where` unchanged when nothing is withheld.
 */
export function withEventOwnerNotWithheld(
  where: Prisma.EventWhereInput,
  w: WithheldOwners,
): Prisma.EventWhereInput {
  const extra = eventOwnerNotWithheldWhere(w);
  if (!extra) return where;
  const existing = where.AND;
  const and =
    existing === undefined
      ? []
      : Array.isArray(existing)
        ? existing
        : [existing];
  return { ...where, AND: [...and, extra] };
}

// ── Prisma select (opt-in single-row reads) ────────────────────────────────

/**
 * Relation select that {@link ownerBannedFromStanding} reads. OPT-IN: only the
 * public-read gates and checkout ask for it (`getById(id, { withOwnerStanding:
 * true })`); internal reads do not pay for the owner join.
 */
export const EVENT_OWNER_STANDING_SELECT = {
  human: { select: { status: true } },
  org: {
    select: {
      members: {
        where: { role: "OWNER" as const },
        select: { human: { select: { status: true } } },
      },
    },
  },
} satisfies Prisma.EventSelect;

export type EventOwnerStanding = {
  human?: { status: string } | null;
  org?: { members: Array<{ human: { status: string } }> } | null;
};

/** The rule applied to a row loaded with {@link EVENT_OWNER_STANDING_SELECT}. */
export function ownerBannedFromStanding(row: EventOwnerStanding): boolean {
  if (row.human?.status === "BANNED") return true;
  const owners = row.org?.members ?? [];
  return owners.length > 0 && owners.every((m) => m.human.status === "BANNED");
}

/**
 * `{}` when nothing is withheld, else `{ AND: [notWithheld] }` — for spreading
 * into a `where` literal that has NO `AND` key of its own (use
 * {@link withEventOwnerNotWithheld} when it does).
 */
export async function notWithheldEventWhere(
  p: PrismaClientOrTx,
): Promise<Prisma.EventWhereInput> {
  const extra = eventOwnerNotWithheldWhere(await resolveWithheldOwners(p));
  return extra ? { AND: [extra] } : {};
}
