import { createHash, randomBytes } from "node:crypto";

import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  ApiKeyListItem,
  ApiKeyRecord,
  ApiKeyRequestRecord,
  ApiKeySubject,
  ApiKeyAccess,
  HumanStatus,
  ResolvedApiKeyScope,
  ScopedApiKeyRecord,
} from "@th/types";
import type { ApiKeysRepo } from "@th/ports/repos/api-keys";

import { rethrowApiKeyDbError } from "./api-keys-errors";
import type { PrismaClientOrTx } from "./types";

// Scoped API keys (scoped-api-keys spec 2026-10-08) over api_keys and
// api_key_requests.
//
// Rules this file keeps (from the step-1 reviews; the guards are in
// migrations 20261012120100..20261012120400):
//  - Lock order everywhere: (advisory cap lock) → request row FOR UPDATE →
//    key rows. api_keys_guard follows the same order on insert.
//  - Writes are raw, parameterised SQL: humanId and orgId each sit in two
//    relations (the plain FK and a composite scope FK), so a nested Prisma
//    `connect` cannot express them.
//  - No ON CONFLICT / upsert / skipDuplicates on api_keys: a refusal must
//    surface, never be swallowed.
//  - The app never supplies created_at / decided_at / withdrawn_at /
//    revoked_at / collected_at. The guards stamp them from the clock;
//    where a guard stamps only on a NULL → NOT NULL transition, the SQL
//    writes the marker `NOW_UTC` and the trigger replaces it.
//  - Every DB refusal is rethrown as a typed ApiKeyRepoError
//    (./api-keys-errors.ts); expected outcomes (already decided, lapsed, …)
//    come back as values from CAS updates, never as exceptions.
//  - No hard delete of a key by app code.
//
// Times: the columns are tz-naive TIMESTAMP(3) holding UTC (the guard
// functions are pinned to TimeZone UTC). Every comparison here uses
// `now() AT TIME ZONE 'UTC'`, which does not depend on the session TimeZone.

/** The DB clock as a UTC tz-naive timestamp, rounded like the guards' LOCALTIMESTAMP(3). */
const NOW_UTC = Prisma.sql`((now() AT TIME ZONE 'UTC')::timestamp(3))`;
/** The DB clock as a UTC tz-naive timestamp at full (µs) precision, unrounded. */
const NOW_UTC_FULL = Prisma.sql`(now() AT TIME ZONE 'UTC')`;
/**
 * R31 sweep: how far past a lapse instant revokeAllForHuman still closes a
 * request, so ms rounding never lets the sweep skip one the guard still
 * accepts (see revokeAllForHuman).
 */
const SWEEP_LAPSE_MARGIN = Prisma.sql`interval '1 hour'`;
/** FR-004: a pending request lapses at 14 days. */
const REQUEST_LAPSE = Prisma.sql`interval '14 days'`;
/** FR-005: an approved request not collected within 7 days lapses. */
const COLLECT_WINDOW = Prisma.sql`interval '7 days'`;
/** FR-012: the expiry notice goes out 7 days ahead. */
const EXPIRY_NOTICE_WINDOW = Prisma.sql`interval '7 days'`;

const KEY_PREFIX = "thk";

export const digestApiKey = (apiKey: string): string =>
  createHash("sha256").update(apiKey, "utf8").digest("hex");

/** `thk_` + 32 random bytes, base64url (FR-005, as before). */
const generateApiKey = (): string =>
  `${KEY_PREFIX}_${randomBytes(32).toString("base64url")}`;

const lastFour = (key: string): string => key.slice(-4);

// ── Column lists (aliases match the @th/types records) ──────────────────────

const REQUEST_COLS = Prisma.sql`
  r.id,
  r.requester_human_id AS "requesterHumanId",
  r.subject::text AS "subject",
  r.org_id AS "orgId",
  r.access::text AS "access",
  r.label,
  r.purpose,
  r.expiry_days AS "expiryDays",
  r.auto_renew AS "autoRenew",
  r.created_at AS "createdAt",
  r.decided_at AS "decidedAt",
  r.decision::text AS "decision",
  r.decided_by_human_id AS "decidedByHumanId",
  r.denial_reason AS "denialReason",
  r.self_approved AS "selfApproved",
  r.withdrawn_at AS "withdrawnAt",
  r.withdrawal_reason::text AS "withdrawalReason",
  r.collected_at AS "collectedAt",
  r.lapse_notified_at AS "lapseNotifiedAt"`;

const KEY_COLS = Prisma.sql`
  k.id,
  k.human_id AS "humanId",
  k.request_id AS "requestId",
  k.subject::text AS "subject",
  k.org_id AS "orgId",
  k.access::text AS "access",
  k.label,
  k.key_last4 AS "keyLast4",
  k.created_at AS "createdAt",
  k.last_used_at AS "lastUsedAt",
  k.expires_at AS "expiresAt",
  k.auto_renew AS "autoRenew",
  k.renewed_from_key_id AS "renewedFromKeyId",
  k.revoked_at AS "revokedAt",
  k.revoked_by_human_id AS "revokedByHumanId",
  k.revoke_reason AS "revokeReason",
  k.expiry_notified_at AS "expiryNotifiedAt"`;

/** Key + the request fields the screens show (LEFT JOIN: legacy keys have none). */
const KEY_LIST_COLS = Prisma.sql`${KEY_COLS},
  r.purpose AS "purpose",
  COALESCE(r.self_approved, false) AS "selfApproved",
  r.decided_by_human_id AS "decidedByHumanId",
  r.auto_renew AS "requestAutoRenew"`;

const KEY_LIST_FROM = Prisma.sql`
  FROM api_keys k
  LEFT JOIN api_key_requests r ON r.id = k.request_id`;

/** A key that still authenticates: unrevoked and not past its expiry. */
const KEY_IS_LIVE = Prisma.sql`(k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > ${NOW_UTC}))`;

/**
 * "The org has a live OWNER/ADMIN other than `excludeHumanId`" (Key scopes
 * table: ORG requests fall back to platform staff when there is none). ONE
 * definition, used by listPlatformQueue and orgHasOtherLiveApprover, so the
 * queue and the decide-rights check (step 3) cannot drift. Live = OrgMember
 * role OWNER or ADMIN whose Human.status is ACTIVE.
 */
function orgHasOtherLiveApproverSql(
  orgId: Prisma.Sql,
  excludeHumanId: Prisma.Sql,
): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1
    FROM "OrgMember" m
    JOIN "Human" h ON h.id = m."humanId"
    WHERE m."orgId" = ${orgId}
      AND m."humanId" <> ${excludeHumanId}
      AND m.role IN ('OWNER', 'ADMIN')
      AND h.status = 'ACTIVE'
  )`;
}

interface LegacyApiKeyRow {
  id: string;
  humanId: string;
  label: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

/**
 * Run `fn` atomically. Inside `repos.tx()` (a transaction client) the
 * surrounding transaction provides it; on the root client this opens one.
 */
async function atomically<T>(
  p: PrismaClientOrTx,
  fn: (tx: PrismaClientOrTx) => Promise<T>,
): Promise<T> {
  if ("$transaction" in p) {
    return (p as PrismaClient).$transaction((tx) => fn(tx));
  }
  return fn(p);
}

/**
 * Advisory-lock methods hold their lock until the transaction ends; on the
 * root client that is the end of the one statement, so the lock would
 * protect nothing. Refuse instead of silently serializing nothing.
 */
function requireTransaction(p: PrismaClientOrTx, method: string): void {
  if ("$transaction" in p) {
    throw new Error(`apiKeys.${method} must run inside repos.tx()`);
  }
}

/** Run a write and rethrow any DB refusal as a typed ApiKeyRepoError. */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    rethrowApiKeyDbError(error);
  }
}

export function makeApiKeysRepo(p: PrismaClientOrTx): ApiKeysRepo {
  async function readRequest(
    db: PrismaClientOrTx,
    requestId: string,
  ): Promise<ApiKeyRequestRecord | null> {
    const rows = await db.$queryRaw<ApiKeyRequestRecord[]>`
      SELECT ${REQUEST_COLS} FROM api_key_requests r WHERE r.id = ${requestId}`;
    return rows[0] ?? null;
  }

  async function readKey(
    db: PrismaClientOrTx,
    keyId: string,
  ): Promise<ScopedApiKeyRecord | null> {
    const rows = await db.$queryRaw<ScopedApiKeyRecord[]>`
      SELECT ${KEY_COLS} FROM api_keys k WHERE k.id = ${keyId}`;
    return rows[0] ?? null;
  }

  async function revokeKeyIn(
    db: PrismaClientOrTx,
    input: {
      keyId: string;
      revokedByHumanId: string | null;
      reason: string | null;
      holderHumanId?: string;
    },
  ) {
    const target = await db.$queryRaw<
      { requestId: string | null; humanId: string }[]
    >`
      SELECT request_id AS "requestId", human_id AS "humanId"
      FROM api_keys WHERE id = ${input.keyId}`;
    const found = target[0];
    if (
      !found ||
      (input.holderHumanId !== undefined &&
        found.humanId !== input.holderHumanId)
    ) {
      return { status: "not_found" } as const;
    }
    // Request row first, then the keys.
    if (found.requestId) {
      await db.$queryRaw`
        SELECT 1 FROM api_key_requests WHERE id = ${found.requestId} FOR UPDATE`;
    }
    const still = await db.$queryRaw<{ revoked: boolean }[]>`
      SELECT revoked_at IS NOT NULL AS revoked
      FROM api_keys WHERE id = ${input.keyId} FOR UPDATE`;
    if (!still[0]) return { status: "not_found" } as const;
    if (still[0].revoked) return { status: "already_revoked" } as const;

    // revoked_at = NOW_UTC is a marker: api_keys_guard stamps the clock.
    // `live` reads expires_at, which revoke does not change, so it is the
    // key's liveness at the moment of the revoke.
    const revoked = await db.$queryRaw<{ id: string; live: boolean }[]>`
      UPDATE api_keys
      SET revoked_at = ${NOW_UTC},
          revoked_by_human_id = ${input.revokedByHumanId},
          revoke_reason = ${input.reason}
      WHERE revoked_at IS NULL
        AND ${
          found.requestId
            ? Prisma.sql`request_id = ${found.requestId}`
            : Prisma.sql`id = ${input.keyId}`
        }
      RETURNING id, (expires_at IS NULL OR expires_at > ${NOW_UTC}) AS live`;
    return {
      status: "revoked",
      revokedKeyIds: revoked
        .filter((r) => r.live)
        .map((r) => r.id)
        .sort(),
      alsoClosedExpiredKeyIds: revoked
        .filter((r) => !r.live)
        .map((r) => r.id)
        .sort(),
    } as const;
  }

  return {
    // ── Authn hot path ─────────────────────────────────────────────────────

    async getHumanIdForKey({ apiKey }) {
      const hash = digestApiKey(apiKey);
      // ONE statement (NFR-003): the key, its scope and the holder's status
      // ride the same UPDATE ... FROM join that stamps last_used_at.
      // last_used_at is not in api_keys_guard's UPDATE OF list, so the guard
      // does not fire here.
      const rows = await p.$queryRaw<
        {
          id: string;
          humanId: string;
          humanStatus: HumanStatus;
          requestId: string | null;
          subject: ApiKeySubject | null;
          access: ApiKeyAccess | null;
          orgId: string | null;
        }[]
      >`
        UPDATE api_keys AS k
        SET last_used_at = ${NOW_UTC}
        FROM "Human" AS h
        WHERE k.key_hash = ${hash}
          AND k.revoked_at IS NULL
          AND (k.expires_at IS NULL OR k.expires_at > ${NOW_UTC})
          AND h.id = k.human_id
        RETURNING
          k.id,
          k.human_id AS "humanId",
          h.status::text AS "humanStatus",
          k.request_id AS "requestId",
          k.subject::text AS "subject",
          k.access::text AS "access",
          k.org_id AS "orgId"
      `;

      const record = rows[0];
      if (!record) return null;
      // Legacy = subject, access and request ALL null. A partial scope (some
      // set, some null) is refused, never downgraded to legacy: legacy is
      // its holder's full session, so a corrupt scoped row must not widen.
      // CHECK api_keys_scope_shape forbids such a row; this is the second
      // wall in case that check is ever dropped.
      const scopeParts = [record.subject, record.access, record.requestId];
      const setParts = scopeParts.filter((part) => part !== null).length;
      if (setParts !== 0 && setParts !== scopeParts.length) return null;
      const keyScope: ResolvedApiKeyScope =
        record.subject && record.access && record.requestId
          ? {
              kind: "scoped",
              keyId: record.id,
              requestId: record.requestId,
              subject: record.subject,
              access: record.access,
              orgId: record.orgId,
            }
          : { kind: "legacy", keyId: record.id };
      return {
        apiKeyId: record.id,
        humanId: record.humanId,
        humanStatus: record.humanStatus,
        keyScope,
      };
    },

    // ── Legacy ─────────────────────────────────────────────────────────────

    async create({ humanId, label }) {
      const key = generateApiKey();
      const hash = digestApiKey(key);
      // created_at is stamped by api_keys_guard.
      const rows = await guarded(
        () => p.$queryRaw<{ id: string; createdAt: Date }[]>`
          INSERT INTO api_keys (id, human_id, key_hash, label)
          VALUES (gen_random_uuid()::text, ${humanId}, ${hash}, ${label ?? null})
          RETURNING id, created_at AS "createdAt"
        `,
      );
      const record = rows[0]!;
      return { id: record.id, key, createdAt: record.createdAt };
    },

    async listByHuman({ humanId, limit, offset }) {
      const items = await p.$queryRaw<LegacyApiKeyRow[]>`
        SELECT
          id,
          human_id as "humanId",
          label,
          created_at as "createdAt",
          last_used_at as "lastUsedAt",
          revoked_at as "revokedAt"
        FROM api_keys
        WHERE human_id = ${humanId}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;

      const countRows = await p.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint as count
        FROM api_keys
        WHERE human_id = ${humanId}
      `;

      return {
        items: items satisfies ApiKeyRecord[],
        total: Number(countRows[0]?.count ?? 0),
      };
    },

    async getById({ apiKeyId, humanId }) {
      const rows = await p.$queryRaw<LegacyApiKeyRow[]>`
        SELECT
          id,
          human_id as "humanId",
          label,
          created_at as "createdAt",
          last_used_at as "lastUsedAt",
          revoked_at as "revokedAt"
        FROM api_keys
        WHERE id = ${apiKeyId} AND human_id = ${humanId}
      `;

      return (rows[0] as ApiKeyRecord | undefined) ?? null;
    },

    async revoke({ apiKeyId, humanId }) {
      // Same path as revokeKey (the whole approval, request locked first),
      // so the legacy procedure cannot leave a renewal's twin alive.
      await guarded(() =>
        atomically(p, (db) =>
          revokeKeyIn(db, {
            keyId: apiKeyId,
            revokedByHumanId: humanId,
            reason: null,
            holderHumanId: humanId,
          }),
        ),
      );
    },

    async lockAndCountActiveByHuman({ humanId }) {
      requireTransaction(p, "lockAndCountActiveByHuman");
      // Serialize concurrent creates for ONE human so the per-human cap is a
      // real ceiling. Transaction-scoped: released at commit/rollback.
      await p.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`api_keys_create:${humanId}`}))`;
      const rows = await p.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint AS count
        FROM api_keys
        WHERE human_id = ${humanId} AND revoked_at IS NULL
      `;
      return Number(rows[0]?.count ?? 0);
    },

    async revokeAllForHuman({ humanId }) {
      return guarded(() =>
        atomically(p, async (db) => {
          // Lock order: the holder's APPROVED and still-UNDECIDED requests
          // first, by id (sorted, so two sweeps never deadlock), then the
          // keys, then the request closures (rows already locked here).
          //
          //  - A renewal on a locked request waits, then finds its parent
          //    revoked and its request closed (api_keys_guard refuses both).
          //  - A collect on a locked request waits; if it ran first its key
          //    is revoked below (and the request, now collected, stays as
          //    it is); if it runs after, api_keys_guard refuses it because
          //    the request is closed (R31).
          //  - Pending and approved-uncollected requests are closed with
          //    withdrawalReason ACCOUNT_SECURITY (R31), so nothing can be
          //    approved or collected on them afterwards and the holder is
          //    told why. Requests lapsed over an hour ago are left as they
          //    are (see the margin note below).
          await db.$queryRaw`
            SELECT id FROM api_key_requests
            WHERE requester_human_id = ${humanId}
              AND (decision = 'APPROVED'
                   OR (decided_at IS NULL AND withdrawn_at IS NULL))
            ORDER BY id
            FOR UPDATE`;
          // revoked_at = NOW_UTC is a marker: api_keys_guard stamps the clock.
          // `live` reads expires_at, which revoke does not change.
          const revoked = await db.$queryRaw<{ live: boolean }[]>`
            UPDATE api_keys
            SET revoked_at = ${NOW_UTC}
            WHERE human_id = ${humanId} AND revoked_at IS NULL
            RETURNING (expires_at IS NULL OR expires_at > ${NOW_UTC}) AS live`;
          const count = revoked.filter((k) => k.live).length;
          // CAS; withdrawn_at = NOW_UTC is a marker (the guard stamps it).
          // CHECK api_key_requests_withdrawn_shape allows ACCOUNT_SECURITY
          // on an undecided or an APPROVED-and-uncollected request.
          //
          // The lapse windows are compared at full precision with a 1-hour
          // margin (SWEEP_LAPSE_MARGIN), not against NOW_UTC. NOW_UTC rounds
          // to ms and can round UP, while the guards judge lapse with
          // LOCALTIMESTAMP at full precision; at the lapse instant the sweep
          // could skip a request that an in-flight collect or decide still
          // passes. With the margin, every request the guard might still let
          // through is closed. Accepted cost: a request that lapsed less than
          // an hour ago is closed as ACCOUNT_SECURITY instead of staying lapsed.
          const closedRequestCount = await db.$executeRaw`
            UPDATE api_key_requests
            SET withdrawn_at = ${NOW_UTC},
                withdrawal_reason = 'ACCOUNT_SECURITY'
            WHERE requester_human_id = ${humanId}
              AND withdrawn_at IS NULL
              AND (
                (decided_at IS NULL
                 AND created_at > ${NOW_UTC_FULL} - ${REQUEST_LAPSE}
                                  - ${SWEEP_LAPSE_MARGIN})
                OR (decision = 'APPROVED' AND collected_at IS NULL
                    AND decided_at > ${NOW_UTC_FULL} - ${COLLECT_WINDOW}
                                     - ${SWEEP_LAPSE_MARGIN})
              )
          `;
          return { count, closedRequestCount };
        }),
      );
    },

    // ── Key requests ───────────────────────────────────────────────────────

    async createRequest(input) {
      const rows = await guarded(
        () => p.$queryRaw<ApiKeyRequestRecord[]>`
          INSERT INTO api_key_requests AS r (
            id, requester_human_id, subject, org_id, access, label, purpose,
            expiry_days, auto_renew
          ) VALUES (
            gen_random_uuid()::text,
            ${input.requesterHumanId},
            ${input.subject}::"ApiKeySubject",
            ${input.orgId},
            ${input.access}::"ApiKeyAccess",
            ${input.label},
            ${input.purpose},
            ${input.expiryDays}::int,
            ${input.autoRenew}
          )
          RETURNING ${REQUEST_COLS}
        `,
      );
      return rows[0]!;
    },

    async getRequest({ requestId }) {
      return readRequest(p, requestId);
    },

    async listRequestsByRequester({ requesterHumanId, limit }) {
      return p.$queryRaw<ApiKeyRequestRecord[]>`
        SELECT ${REQUEST_COLS}
        FROM api_key_requests r
        WHERE r.requester_human_id = ${requesterHumanId}
        ORDER BY r.created_at DESC, r.id
        LIMIT ${limit}`;
    },

    async listOrgQueue({ orgId, limit }) {
      return p.$queryRaw<ApiKeyRequestRecord[]>`
        SELECT ${REQUEST_COLS}
        FROM api_key_requests r
        WHERE r.org_id = ${orgId}
          AND r.subject = 'ORG'
          AND r.decided_at IS NULL
          AND r.withdrawn_at IS NULL
          AND r.created_at > ${NOW_UTC} - ${REQUEST_LAPSE}
        ORDER BY r.created_at, r.id
        LIMIT ${limit}`;
    },

    async listPlatformQueue({ subjects, includeOrgFallbacks, limit }) {
      const subjectList = [...subjects];
      return p.$queryRaw<ApiKeyRequestRecord[]>`
        SELECT ${REQUEST_COLS}
        FROM api_key_requests r
        WHERE r.decided_at IS NULL
          AND r.withdrawn_at IS NULL
          AND r.created_at > ${NOW_UTC} - ${REQUEST_LAPSE}
          AND (
            r.subject::text = ANY(${subjectList}::text[])
            OR (
              ${includeOrgFallbacks}
              AND r.subject = 'ORG'
              AND NOT ${orgHasOtherLiveApproverSql(
                Prisma.sql`r.org_id`,
                Prisma.sql`r.requester_human_id`,
              )}
            )
          )
        ORDER BY r.created_at, r.id
        LIMIT ${limit}`;
    },

    async orgHasOtherLiveApprover({ orgId, excludeHumanId }) {
      const rows = await p.$queryRaw<{ has: boolean }[]>`
        SELECT ${orgHasOtherLiveApproverSql(
          Prisma.sql`${orgId}::text`,
          Prisma.sql`${excludeHumanId}::text`,
        )} AS has`;
      return rows[0]?.has ?? false;
    },

    async lockAndCountForCap({ holderHumanId, subject, orgId }) {
      requireTransaction(p, "lockAndCountForCap");
      if (subject === "ORG" && !orgId) {
        throw new Error("lockAndCountForCap: orgId is required for ORG");
      }
      // Lock order, every caller: the holder's lock FIRST (it serializes the
      // holder's per-subject count and the 24-hour request count across
      // subjects), then, for ORG, the org's lock (the per-org count across
      // holders). One fixed order, so two requests cannot deadlock here.
      const holderLock = `api_key_cap:holder:${holderHumanId}`;
      await p.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${holderLock}))`;
      if (subject === "ORG") {
        const orgLock = `api_key_cap:org:${orgId}`;
        await p.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${orgLock}))`;
      }

      // A slot = pending (undecided, unwithdrawn, < 14 days), approved and
      // inside the 7-day collect window, or collected with a live key.
      const occupiesSlot = Prisma.sql`(
        r.withdrawn_at IS NULL AND (
          (r.decision IS NULL AND r.created_at > ${NOW_UTC} - ${REQUEST_LAPSE})
          OR (r.decision = 'APPROVED' AND r.collected_at IS NULL
              AND r.decided_at > ${NOW_UTC} - ${COLLECT_WINDOW})
          OR (r.decision = 'APPROVED' AND r.collected_at IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM api_keys k
                WHERE k.request_id = r.id AND ${KEY_IS_LIVE}
              ))
        )
      )`;

      const holderRows = await p.$queryRaw<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM api_key_requests r
        WHERE r.requester_human_id = ${holderHumanId}
          AND r.subject = ${subject}::"ApiKeySubject"
          AND r.org_id IS NOT DISTINCT FROM ${orgId}::text
          AND ${occupiesSlot}`;

      let orgCount: number | null = null;
      if (subject === "ORG") {
        const orgRows = await p.$queryRaw<{ count: number }[]>`
          SELECT COUNT(*)::int AS count
          FROM api_key_requests r
          WHERE r.org_id = ${orgId}
            AND r.subject = 'ORG'
            AND ${occupiesSlot}`;
        orgCount = orgRows[0]?.count ?? 0;
      }
      // Every request the holder sent in the last 24 hours, any subject or
      // state (withdrawn included): core's per-holder request rate limit
      // (an orchestrator abuse limit, not a spec rule).
      const recentRows = await p.$queryRaw<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM api_key_requests r
        WHERE r.requester_human_id = ${holderHumanId}
          AND r.created_at > ${NOW_UTC} - interval '24 hours'`;

      return {
        holderCount: holderRows[0]?.count ?? 0,
        orgCount,
        holderRequestsLast24h: recentRows[0]?.count ?? 0,
      };
    },

    async decide({
      requestId,
      decision,
      decidedByHumanId,
      denialReason,
      selfApproved,
    }) {
      return guarded(async () => {
        // decided_at is NOT written: api_key_requests_guard stamps it when
        // the decision goes from NULL to set.
        const rows = await p.$queryRaw<ApiKeyRequestRecord[]>`
          UPDATE api_key_requests AS r
          SET decision = ${decision}::"ApiKeyRequestDecision",
              decided_by_human_id = ${decidedByHumanId},
              denial_reason = ${denialReason},
              self_approved = ${selfApproved}
          WHERE r.id = ${requestId}
            AND r.decided_at IS NULL
            AND r.withdrawn_at IS NULL
            AND (${decision}::text <> 'APPROVED'
                 OR r.created_at > ${NOW_UTC} - ${REQUEST_LAPSE})
          RETURNING ${REQUEST_COLS}`;
        if (rows[0]) return { status: "decided", request: rows[0] } as const;

        // 0 rows: say why. Decision and withdrawal are final, so this read
        // cannot be overtaken into a different answer.
        const current = await readRequest(p, requestId);
        if (!current) return { status: "not_found" } as const;
        if (current.decidedAt !== null) {
          return { status: "already_decided", request: current } as const;
        }
        if (current.withdrawnAt !== null) {
          return { status: "withdrawn", request: current } as const;
        }
        return { status: "lapsed", request: current } as const;
      });
    },

    async withdraw({ requestId, requesterHumanId }) {
      return guarded(async () => {
        // withdrawn_at = NOW_UTC is a marker: the guard stamps the clock.
        const rows = await p.$queryRaw<ApiKeyRequestRecord[]>`
          UPDATE api_key_requests AS r
          SET withdrawn_at = ${NOW_UTC},
              withdrawal_reason = 'REQUESTER'
          WHERE r.id = ${requestId}
            AND r.requester_human_id = ${requesterHumanId}
            AND r.decided_at IS NULL
            AND r.withdrawn_at IS NULL
          RETURNING ${REQUEST_COLS}`;
        if (rows[0]) return { status: "withdrawn", request: rows[0] } as const;

        const current = await readRequest(p, requestId);
        if (!current || current.requesterHumanId !== requesterHumanId) {
          return { status: "not_found" } as const;
        }
        if (current.decidedAt !== null) {
          return { status: "already_decided", request: current } as const;
        }
        return { status: "already_withdrawn", request: current } as const;
      });
    },

    async collect({ requestId, holderHumanId }) {
      return guarded(() =>
        atomically(p, async (db) => {
          // Request row first (the guard re-locks it; same order).
          const locked = await db.$queryRaw<{ id: string }[]>`
            SELECT id FROM api_key_requests
            WHERE id = ${requestId} AND requester_human_id = ${holderHumanId}
            FOR UPDATE`;
          if (!locked[0]) return { status: "not_found" } as const;

          const key = generateApiKey();
          // INSERT only. api_keys_guard stamps created_at, writes the
          // request's collected_at, and refuses anything but a first collect
          // of an APPROVED, unwithdrawn request inside its 7-day window (a
          // request closed by a reset or ban sweep, R31, is refused). The
          // Human join also mints nothing for a holder who is not ACTIVE.
          const rows = await db.$queryRaw<ScopedApiKeyRecord[]>`
            INSERT INTO api_keys AS k (
              id, human_id, key_hash, label, request_id, subject, org_id,
              access, expires_at, auto_renew, key_last4
            )
            SELECT
              gen_random_uuid()::text,
              r.requester_human_id,
              ${digestApiKey(key)},
              r.label,
              r.id,
              r.subject,
              r.org_id,
              r.access,
              CASE WHEN r.expiry_days IS NULL THEN NULL
                   ELSE ${NOW_UTC} + make_interval(days => r.expiry_days) END,
              r.auto_renew,
              ${lastFour(key)}
            FROM api_key_requests r
            JOIN "Human" h ON h.id = r.requester_human_id AND h.status = 'ACTIVE'
            WHERE r.id = ${requestId}
            RETURNING ${KEY_COLS}`;
          const record = rows[0];
          if (!record) return { status: "holder_inactive" } as const;
          return { status: "collected", key, record } as const;
        }),
      );
    },

    async renew({ parentKeyId, holderHumanId }) {
      return guarded(() =>
        atomically(p, async (db) => {
          const parent = await db.$queryRaw<{ requestId: string | null }[]>`
            SELECT request_id AS "requestId" FROM api_keys
            WHERE id = ${parentKeyId} AND human_id = ${holderHumanId}`;
          const requestId = parent[0]?.requestId;
          if (!requestId) return { status: "not_found" } as const;

          // Request row first; api_keys_guard then locks the parent key.
          // The request may be gone (CASCADE with its holder or org) between
          // the read above and this lock.
          const lockedRequest = await db.$queryRaw<{ id: string }[]>`
            SELECT id FROM api_key_requests WHERE id = ${requestId} FOR UPDATE`;
          if (!lockedRequest[0]) return { status: "not_found" } as const;

          const key = generateApiKey();
          // INSERT only. Scope, org, label and holder come from the parent
          // together (scope_shape / org_shape CHECKs, composite scope FKs);
          // the term is the request's. api_keys_guard cuts the parent to
          // now + 24h and refuses anything but a live auto-renewing parent
          // in its last 7 days with no other live key on the request.
          const rows = await db.$queryRaw<ScopedApiKeyRecord[]>`
            INSERT INTO api_keys AS k (
              id, human_id, key_hash, label, request_id, subject, org_id,
              access, expires_at, auto_renew, key_last4, renewed_from_key_id
            )
            SELECT
              gen_random_uuid()::text,
              pk.human_id,
              ${digestApiKey(key)},
              pk.label,
              pk.request_id,
              pk.subject,
              pk.org_id,
              pk.access,
              CASE WHEN r.expiry_days IS NULL THEN NULL
                   ELSE ${NOW_UTC} + make_interval(days => r.expiry_days) END,
              pk.auto_renew AND r.auto_renew,
              ${lastFour(key)},
              pk.id
            FROM api_keys pk
            JOIN api_key_requests r ON r.id = pk.request_id
            WHERE pk.id = ${parentKeyId}
            RETURNING ${KEY_COLS}`;
          // No row = the parent vanished after the lock (CASCADE); never
          // report "renewed" without a key.
          const record = rows[0];
          if (!record) return { status: "not_found" } as const;
          return { status: "renewed", key, record } as const;
        }),
      );
    },

    async getKey({ keyId }) {
      const rows = await p.$queryRaw<ApiKeyListItem[]>`
        SELECT ${KEY_LIST_COLS} ${KEY_LIST_FROM} WHERE k.id = ${keyId}`;
      return rows[0] ?? null;
    },

    async revokeKey({ keyId, revokedByHumanId, reason }) {
      return guarded(() =>
        atomically(p, (db) =>
          revokeKeyIn(db, { keyId, revokedByHumanId, reason }),
        ),
      );
    },

    async setKeyAutoRenew({ keyId, autoRenew }) {
      return guarded(() =>
        atomically(p, async (db) => {
          const target = await db.$queryRaw<{ requestId: string | null }[]>`
            SELECT request_id AS "requestId" FROM api_keys WHERE id = ${keyId}`;
          if (!target[0]) return { status: "not_found" } as const;
          const requestId = target[0].requestId;

          // Request row first, then the key.
          let requestAutoRenew = false;
          if (requestId) {
            const req = await db.$queryRaw<{ autoRenew: boolean }[]>`
              SELECT auto_renew AS "autoRenew" FROM api_key_requests
              WHERE id = ${requestId} FOR UPDATE`;
            requestAutoRenew = req[0]?.autoRenew ?? false;
          }
          const rows = await db.$queryRaw<
            (ScopedApiKeyRecord & { live: boolean })[]
          >`
            SELECT ${KEY_COLS}, ${KEY_IS_LIVE} AS live
            FROM api_keys k WHERE k.id = ${keyId} FOR UPDATE`;
          const row = rows[0];
          if (!row) return { status: "not_found" } as const;
          const { live, ...record } = row;

          if (!live) return { status: "not_live", record } as const;
          if (record.autoRenew === autoRenew) {
            return { status: "unchanged", record } as const;
          }
          if (autoRenew && !requestAutoRenew) {
            return { status: "request_disallows", record } as const;
          }
          const updated = await db.$queryRaw<ScopedApiKeyRecord[]>`
            UPDATE api_keys AS k SET auto_renew = ${autoRenew}
            WHERE k.id = ${keyId}
            RETURNING ${KEY_COLS}`;
          return { status: "updated", record: updated[0]! } as const;
        }),
      );
    },

    async switchOffRequestAutoRenew({ requestId }) {
      return guarded(() =>
        atomically(p, async (db) => {
          // The request first (its row lock orders us before any key);
          // api_key_requests_guard makes the switch-off final.
          const rows = await db.$queryRaw<ApiKeyRequestRecord[]>`
            UPDATE api_key_requests AS r SET auto_renew = false
            WHERE r.id = ${requestId} AND r.auto_renew
            RETURNING ${REQUEST_COLS}`;
          const request = rows[0];
          if (!request) {
            const current = await readRequest(db, requestId);
            return current
              ? ({ status: "unchanged", request: current } as const)
              : ({ status: "not_found" } as const);
          }
          const keys = await db.$queryRaw<{ id: string }[]>`
            UPDATE api_keys SET auto_renew = false
            WHERE request_id = ${requestId} AND auto_renew AND revoked_at IS NULL
            RETURNING id`;
          return {
            status: "switched_off",
            request,
            keyIds: keys.map((k) => k.id).sort(),
          } as const;
        }),
      );
    },

    // ── Screen reads ───────────────────────────────────────────────────────

    async listKeysByHolder({ humanId, limit }) {
      return p.$queryRaw<ApiKeyListItem[]>`
        SELECT ${KEY_LIST_COLS} ${KEY_LIST_FROM}
        WHERE k.human_id = ${humanId}
        ORDER BY k.created_at DESC, k.id
        LIMIT ${limit}`;
    },

    async listKeysByOrg({ orgId, limit }) {
      return p.$queryRaw<ApiKeyListItem[]>`
        SELECT ${KEY_LIST_COLS} ${KEY_LIST_FROM}
        WHERE k.org_id = ${orgId}
        ORDER BY k.created_at DESC, k.id
        LIMIT ${limit}`;
    },

    async listAllKeys({ limit, offset, subject }) {
      const where = subject
        ? Prisma.sql`WHERE k.subject = ${subject}::"ApiKeySubject"`
        : Prisma.empty;
      const items = await p.$queryRaw<ApiKeyListItem[]>`
        SELECT ${KEY_LIST_COLS} ${KEY_LIST_FROM}
        ${where}
        ORDER BY k.created_at DESC, k.id
        LIMIT ${limit} OFFSET ${offset}`;
      const total = await p.$queryRaw<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM api_keys k ${where}`;
      return { items, total: total[0]?.count ?? 0 };
    },

    // ── Notice markers (FR-012) ────────────────────────────────────────────

    async listRequestsDueLapseNotice({ limit }) {
      const rows = await p.$queryRaw<
        (ApiKeyRequestRecord & {
          kind: "pending_lapsed" | "collect_lapsed";
        })[]
      >`
        SELECT ${REQUEST_COLS},
          CASE WHEN r.decision IS NULL THEN 'pending_lapsed'
               ELSE 'collect_lapsed' END AS kind
        FROM api_key_requests r
        WHERE r.lapse_notified_at IS NULL
          AND r.withdrawn_at IS NULL
          AND (
            (r.decision IS NULL AND r.created_at <= ${NOW_UTC} - ${REQUEST_LAPSE})
            OR (r.decision = 'APPROVED' AND r.collected_at IS NULL
                AND r.decided_at <= ${NOW_UTC} - ${COLLECT_WINDOW})
          )
        ORDER BY r.created_at, r.id
        LIMIT ${limit}`;
      return rows.map(({ kind, ...request }) => ({ kind, request }));
    },

    async markRequestLapseNotified({ requestId }) {
      const n = await p.$executeRaw`
        UPDATE api_key_requests SET lapse_notified_at = ${NOW_UTC}
        WHERE id = ${requestId}
          AND lapse_notified_at IS NULL
          AND withdrawn_at IS NULL`;
      return n === 1;
    },

    async listKeysDueExpiryNotice({ limit }) {
      return p.$queryRaw<ScopedApiKeyRecord[]>`
        SELECT ${KEY_COLS}
        FROM api_keys k
        JOIN api_key_requests r ON r.id = k.request_id
        WHERE k.revoked_at IS NULL
          AND k.expiry_notified_at IS NULL
          AND k.expires_at IS NOT NULL
          AND k.expires_at > ${NOW_UTC}
          AND k.expires_at <= ${NOW_UTC} + ${EXPIRY_NOTICE_WINDOW}
          AND NOT (k.auto_renew AND r.auto_renew)
          AND NOT EXISTS (
            SELECT 1 FROM api_keys c WHERE c.renewed_from_key_id = k.id
          )
        ORDER BY k.expires_at, k.id
        LIMIT ${limit}`;
    },

    async markKeyExpiryNotified({ keyId }) {
      const n = await p.$executeRaw`
        UPDATE api_keys SET expiry_notified_at = ${NOW_UTC}
        WHERE id = ${keyId} AND expiry_notified_at IS NULL`;
      return n === 1;
    },
  };
}
