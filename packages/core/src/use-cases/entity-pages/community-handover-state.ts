/**
 * What the community moderators left on a PLACE page that its owner has not
 * yet decided on (moderator place page spec
 * docs/specs/2026-10-14/moderator-place-page.spec.yaml, D6 / D7, FR-006 /
 * FR-007).
 *
 * DERIVED, never a stored flag (D6): moderator writes are PENDING while an
 * {@link ENTITY_PAGE_COMMUNITY_UPDATED_ACTION} row for the page exists that
 * is strictly newer than the page's latest
 * {@link ENTITY_PAGE_COMMUNITY_HANDOVER_ACTION} row (no handover row = every
 * moderator write is pending). The public page shows the community
 * attribution and the owner's editor shows the handover notice exactly while
 * something is pending; the owner's Keep / Clear writes the handover row that
 * ends it, and a later moderator write (the place unowned again) starts it
 * over.
 *
 * Both reads are exact-match `audit.listForEntity` calls, newest first,
 * bounded: one row for the attribution, at most
 * {@link COMMUNITY_HANDOVER_MAX_UPDATES} for the owner's notice.
 */

import type { Repos, TxRepos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";
import type { AuditLogListItem } from "@th/types";

import {
  ENTITY_PAGE_AUDIT_ENTITY,
  ENTITY_PAGE_COMMUNITY_UPDATED_ACTION,
} from "./entity-page-access";

/**
 * The audit action of the owner's Keep / Clear (D6). Row shape (the
 * derivation above reads it; keep it stable):
 *
 *   entity   "entity_page"            entityId  the page id
 *   data     { actorHumanId, pageId, placeId, choice: "keep" | "clear",
 *              pendingUpdateCount }
 */
export const ENTITY_PAGE_COMMUNITY_HANDOVER_ACTION =
  "entity_page.community_handover";

/** Most moderator writes the owner's notice lists (newest first). */
export const COMMUNITY_HANDOVER_MAX_UPDATES = 200;

type AuditReader = Pick<Repos | TxRepos, "audit">;

/** The page's latest handover row, or null when the owner never chose. */
export async function latestCommunityHandover(
  repos: AuditReader,
  pageId: string,
): Promise<AuditLogListItem | null> {
  const [row] = await repos.audit.listForEntity({
    entity: ENTITY_PAGE_AUDIT_ENTITY,
    entityId: pageId,
    actions: [ENTITY_PAGE_COMMUNITY_HANDOVER_ACTION],
    limit: 1,
  });
  return row ?? null;
}

/**
 * The `op` of the community_updated row getMyPage writes when a moderator's
 * first open seeds the empty place template. The row stays (an honest record
 * of who seeded) but is NOT moderator content: attribution and the pending
 * handover skip it. Shared by get-my-page.ts so the two cannot drift.
 */
export const COMMUNITY_SEED_TEMPLATE_OP = "seedTemplate";

function isSeedRow(row: AuditLogListItem): boolean {
  const data = row.data;
  return (
    data !== null &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    (data as Record<string, unknown>).op === COMMUNITY_SEED_TEMPLATE_OP
  );
}

/**
 * The most rows one audit.listForEntity call returns, whatever is asked
 * (mirrors LIST_AUDIT_FOR_ENTITY_MAX in the Prisma adapter; core cannot
 * import adapters). A read of exactly this many rows is NOT proof that no
 * more exist, so a capped read that still lacks enough real rows is
 * reported as `capped`, never as exhausted.
 */
const AUDIT_READ_CAP = 500;

/**
 * Moderator writes newer than `after` (null = all), newest first, seed rows
 * skipped. Same index-friendly query as ever (entity, entityId, action, at),
 * asking for exactly `limit` rows first; only when seed rows ate into the
 * window does it re-ask with a doubled limit, up to {@link AUDIT_READ_CAP}.
 * Seed rows are at most one per template category, so the common path stays
 * one read of `limit` rows. `capped` = the cap was hit and more rows may
 * exist behind it.
 */
export async function listCommunityUpdatesSince(
  repos: AuditReader,
  pageId: string,
  after: Date | null,
  limit: number,
): Promise<{ rows: AuditLogListItem[]; capped: boolean }> {
  let ask = Math.min(limit, AUDIT_READ_CAP);
  for (;;) {
    const rows = await repos.audit.listForEntity({
      entity: ENTITY_PAGE_AUDIT_ENTITY,
      entityId: pageId,
      actions: [ENTITY_PAGE_COMMUNITY_UPDATED_ACTION],
      after,
      limit: ask,
    });
    const real = rows.filter((row) => !isSeedRow(row));
    if (real.length >= limit || rows.length < ask) {
      return { rows: real.slice(0, limit), capped: false };
    }
    if (ask >= AUDIT_READ_CAP) return { rows: real, capped: true };
    ask = Math.min(ask * 2, AUDIT_READ_CAP);
  }
}

/** The public page's community attribution (D7). */
export type CommunityAttribution = {
  maintainedByCommunity: true;
  /** The newest pending moderator write. */
  lastUpdatedAt: Date;
};

/**
 * The attribution for a page: present while a moderator write is pending
 * (see the module comment), else null. Two single-row reads.
 */
export async function findCommunityAttribution(
  repos: AuditReader,
  pageId: string,
): Promise<CommunityAttribution | null> {
  const handover = await latestCommunityHandover(repos, pageId);
  // A capped read with no real row (500+ seed rows) names no write: null.
  const {
    rows: [newest],
  } = await listCommunityUpdatesSince(repos, pageId, handover?.at ?? null, 1);
  return newest ? { maintainedByCommunity: true, lastUpdatedAt: newest.at } : null;
}

/** One pending moderator write, as the owner's notice shows it. */
export type PendingCommunityUpdate = {
  /** Null when the row carries no actor (never written so; reported). */
  humanId: string | null;
  /** The operation ("updatePage", "managePageBlocks.edit", ...). */
  op: string;
  /** Which things it changed (stable names; see entity-page-access.ts). */
  fields: string[];
  at: Date;
};

/** What the owner has not yet decided on. */
export type PendingCommunityHandover = {
  /** The latest handover before these writes; null when there was none. */
  sinceHandoverAt: Date | null;
  /** Newest first, at most {@link COMMUNITY_HANDOVER_MAX_UPDATES}. */
  updates: PendingCommunityUpdate[];
  /** More pending writes exist than `updates` holds. */
  truncated: boolean;
};

function readUpdate(
  row: AuditLogListItem,
  reportError: ReporterPort | undefined,
): PendingCommunityUpdate {
  const data =
    row.data !== null && typeof row.data === "object" && !Array.isArray(row.data)
      ? (row.data as Record<string, unknown>)
      : {};
  const op = typeof data.op === "string" ? data.op : null;
  const fields = Array.isArray(data.fields)
    ? data.fields.filter((field): field is string => typeof field === "string")
    : null;
  if (row.actorHumanId === null || op === null || fields === null) {
    // logCommunityPageUpdate never writes such a row: the notice still lists
    // it (the owner must see every pending write), with what it holds.
    try {
      reportError?.(new Error("entity_page.community_updated row malformed"), {
        tags: { useCase: "communityHandover", step: "readUpdate" },
        extra: { auditId: row.id, pageId: row.entityId },
      });
    } catch {
      // A throwing reporter never changes the answer.
    }
  }
  return {
    humanId: row.actorHumanId,
    op: op ?? "unknown",
    fields: fields ?? [],
    at: row.at,
  };
}

/**
 * The page's pending moderator writes, or null when nothing is pending.
 * Inside a transaction, pass the tx repos so the answer is read after the
 * caller's locks.
 */
export async function findPendingCommunityHandover(
  repos: AuditReader,
  pageId: string,
  reportError?: ReporterPort,
): Promise<PendingCommunityHandover | null> {
  const handover = await latestCommunityHandover(repos, pageId);
  const sinceHandoverAt = handover?.at ?? null;
  const { rows, capped } = await listCommunityUpdatesSince(
    repos,
    pageId,
    sinceHandoverAt,
    COMMUNITY_HANDOVER_MAX_UPDATES + 1,
  );
  // Capped = more rows may sit behind the cap: pending, and truncated.
  if (rows.length === 0 && !capped) return null;
  return {
    sinceHandoverAt,
    updates: rows
      .slice(0, COMMUNITY_HANDOVER_MAX_UPDATES)
      .map((row) => readUpdate(row, reportError)),
    truncated: capped || rows.length > COMMUNITY_HANDOVER_MAX_UPDATES,
  };
}
