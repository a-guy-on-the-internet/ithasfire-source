import { fail } from "@th/errors";
import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { RoleTemplateWithShiftsRecord } from "@th/ports/repos/volunteering";

import { describeError, parseInput } from "../../lib/io";
import { ORG_ADMIN_ROLES, requireOrgMembership } from "../../lib/rbac";
import { forkPlatformRoleTemplateInputSchema } from "./schemas";

// ── Deps ────────────────────────────────────────────────────────────────────

export type ForkPlatformRoleTemplateDeps = {
  repos: Repos;
  clock: ClockPort;
  idempotency: IdempotencyPort;
  logger?: LoggerPort;
};

/**
 * Claim window for the fork lock. Long enough to cover a slow transaction,
 * short enough that a crashed run frees the key before a human retries.
 */
const IDEMPOTENCY_TTL_SECONDS = 60;

/**
 * How long a successful fork's result stays replayable. A day is plenty: the
 * DURABLE guard is the (packId, name) re-read below plus the
 * `@@unique([orgId, name])` constraint, which never expire. This cache only
 * exists to make the double-click cheap.
 */
const IDEMPOTENCY_KEEP_SECONDS = 24 * 60 * 60;

/**
 * How long a FAILED fork's key is retained. Near-zero on purpose.
 *
 * Both shipped adapters hold a failed key for 15 minutes by default
 * (`PrismaIdempotencyAdapter.fail`, `RedisIdempotency.fail`) and `get()`
 * replays only a *succeeded* key, so taking the default would answer the
 * documented FR-011 retry — "Door is taken, re-submit as Door (Ithas Fire)"
 * — with IDEMPOTENCY_LOCK_IN_PROGRESS ("already being processed") for a
 * quarter of an hour, every time, for the whole window.
 *
 * 1s rather than 0: it is the smallest value every adapter accepts (Redis
 * `SET … EX 0` is an error) and it satisfies the Prisma adapter's
 * `expiresAt <= now` re-claim predicate. Same constant, same reasoning as
 * `DETERMINISTIC_FAILURE_KEEP_SECONDS` in `claimBookingRequest`.
 *
 * Applied to EVERY failure class here, infrastructure included — which is
 * where this diverges from `claimBookingRequest`, and deliberately. The
 * thing a long hold buys is "we don't know whether the effect happened, so
 * don't let a retry double it", and this use case does not need the store
 * for that: its duplicate guard is the in-transaction `(packId, name)`
 * re-read plus `@@unique([orgId, name])` (guard 2 below), neither of which
 * expires. A retry after a lost/failed write finds the fork and returns it
 * unchanged. A token CAS has no such durable re-read; this does.
 *
 * We still always CALL `fail` — skipping it would leave the `in_progress`
 * marker armed for the full begin TTL, which is strictly worse.
 */
const FAILURE_KEEP_SECONDS = 1;

/** Derived from (orgId, source template id) — see the schema's doc comment. */
function buildForkKey(orgId: string, templateId: string): string {
  return `volunteer-template-fork:${orgId}:${templateId}`;
}

type StoredFork = { forkedTemplateId: string };

/**
 * Is this org row the fork of that catalogue row?
 *
 * Provenance is (packId, name): `packId` says which pack, the copied name
 * says which role of it. Same key `listRoleTemplates` shadows on — the two
 * must agree, or Customise would create a second row the list then refuses
 * to hide.
 *
 * Known imprecision, accepted: the only caller reaches this AFTER matching
 * `candidate.name` to `targetName`, so the name comparison below is already
 * true and the predicate effectively reduces to "org row, same pack". If
 * staff later add a SECOND catalogue role to that pack under a name an org
 * already forked-then-renamed into, this would call the renamed row that
 * new role's fork and return it. Nothing is written down that path — the
 * caller returns the org's existing row untouched — and the ambiguity is
 * inherent to (packId, name) being the only provenance a fork carries, the
 * same identity `packShadowKey` and
 * `VolunteerRoleTemplate_platform_pack_name_key` use. Tightening it needs a
 * `forkedFromTemplateId` column, not a change here.
 */
function isForkOf(
  candidate: { isPlatform: boolean; packId: string | null; name: string },
  source: { packId: string | null; name: string },
): boolean {
  if (candidate.isPlatform) return false;
  if (!source.packId || candidate.packId !== source.packId) return false;
  return candidate.name.toLowerCase() === source.name.toLowerCase();
}

// ── Use case ────────────────────────────────────────────────────────────────

/**
 * "Customise" — copy a LIVE platform catalogue role, and its shift presets,
 * into an org-owned template (FR-011).
 *
 * The copy is a normal org row: `orgId` set, `isPlatform` false, `packId`
 * RETAINED as provenance. That provenance is what makes the copy shadow the
 * catalogue row in this org's list (`listRoleTemplates`) and what lets it
 * outlive the pack it came from — the FK is SET NULL on org rows.
 *
 * Shift presets are copied field-for-field INCLUDING `anchor` /
 * `offsetMinutes` / `notes`. Those columns are the reason the shift-draft
 * schema had to grow them first: a fork carrying `EVENT_START −180` whose
 * fields the editor can't round-trip would be silently flattened to
 * wall-clock on the org's first save.
 *
 * Idempotency (FR-012): keyed on (orgId, source template id), so a
 * double-clicked Customise makes exactly one copy. Two independent guards,
 * because the store's key eventually expires and the data does not:
 *
 *   1. The idempotency store, claimed before the write and committed after.
 *   2. A re-read of the org's own rows: an existing, live fork of the same
 *      catalogue role is RETURNED unchanged rather than duplicated.
 *
 * Name collisions never destroy an organizer's own work. If the org already
 * has a template with the target name that is NOT this catalogue role's fork
 * — their own hand-made "Door", or an archived fork of it — the call fails
 * with `TEMPLATE_NAME_TAKEN` and the UI re-submits with an explicit `name`.
 * (An archived fork counts as a collision on purpose: `@@unique([orgId,
 * name])` covers archived rows, so reviving it silently would be the one
 * behaviour that could resurrect a row the org deliberately retired.)
 *
 * Auth: org OWNER | ADMIN — the same set that already edits templates, and
 * checked BEFORE the idempotency store is touched. See the ordering note in
 * the body: the replay path returns a whole org-owned template, so it has to
 * sit behind membership, not in front of it.
 */
export async function forkPlatformRoleTemplate(
  deps: ForkPlatformRoleTemplateDeps,
  rawInput: unknown,
): Promise<RoleTemplateWithShiftsRecord> {
  const input = parseInput(forkPlatformRoleTemplateInputSchema, rawInput);
  const key = buildForkKey(input.orgId, input.templateId);

  // ── AUTHZ FIRST ───────────────────────────────────────────────────────────
  // Before the idempotency store is read, claimed, or otherwise touched.
  //
  // `orgId` is caller-supplied and the key is derived from it, so anyone can
  // name any org. The replay below returns a FULL template — name,
  // description, capacity and every shift preset including `notes` — for
  // whichever org the key names. Platform catalogue rows are visible to every
  // org by design, so a catalogue role's id plus a victim org's uuid is all
  // an outsider would need. Checking membership after the cache read would
  // therefore hand an ex-member (or any member of any other org) org A's
  // customised template, in violation of NFR-002.
  //
  // The check inside `repos.tx` below is NOT redundant: it is the one that
  // guards the WRITE, on the transaction's snapshot, closing the window
  // between this read and the insert. This one guards the READ path.
  await requireOrgMembership({
    repos: deps.repos,
    orgId: input.orgId,
    actorHumanId: input.actorHumanId,
    roles: ORG_ADMIN_ROLES,
  });

  const replayFork = async (
    stored: StoredFork | null,
  ): Promise<RoleTemplateWithShiftsRecord | null> => {
    if (!stored) return null;
    const existing = await deps.repos.volunteering.getRoleTemplateWithShifts(
      stored.forkedTemplateId,
    );
    // Re-verify tenancy on replay rather than trusting the cached id: the row
    // could have been deleted, and a cache that outlived it must not become a
    // way to read someone else's template.
    if (!existing || existing.isPlatform || existing.orgId !== input.orgId) {
      return null;
    }
    return existing;
  };

  // Both replay call sites below are reachable only past the membership
  // check above.
  const cached = await replayFork(await deps.idempotency.get<StoredFork>(key));
  if (cached) return cached;

  const claimed = await deps.idempotency.begin(key, IDEMPOTENCY_TTL_SECONDS);
  if (!claimed) {
    const replay = await replayFork(
      await deps.idempotency.get<StoredFork>(key),
    );
    if (replay) return replay;
    throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS");
  }

  try {
    const forked = await deps.repos.tx(async (tx) => {
      // Re-checked on the transaction's snapshot: the pre-claim check above
      // guards the read path, this one guards the write.
      await requireOrgMembership({
        repos: tx,
        orgId: input.orgId,
        actorHumanId: input.actorHumanId,
        roles: ORG_ADMIN_ROLES,
      });

      // Tenancy-filtered read: the org's own row OR a LIVE catalogue row.
      // Another org's template and a DRAFT pack's role both come back null,
      // so the 404 below never confirms the id exists.
      const source = await tx.volunteering.getRoleTemplateUsableBy(
        input.templateId,
        input.orgId,
      );
      // Only a catalogue row is forkable. An org's own row reaching here
      // would already be theirs to edit; answering TEMPLATE_NOT_FOUND keeps
      // this endpoint from doubling as a "duplicate my template" primitive
      // with different authz.
      if (!source || !source.isPlatform || !source.packId) {
        throw fail("TEMPLATE_NOT_FOUND");
      }

      const targetName = input.name ?? source.name;

      // ORG-ONLY read (no `includePlatform`), archived included — the DB
      // unique constraint counts archived rows, so the precheck must too.
      const siblings = await tx.volunteering.listRoleTemplates(input.orgId, {
        includeArchived: true,
      });
      const clash = siblings.find(
        (row) => row.name.toLowerCase() === targetName.toLowerCase(),
      );
      if (clash) {
        if (
          !clash.archived &&
          isForkOf(clash, { ...source, name: targetName })
        ) {
          // Already forked (stale tab, expired idempotency key). Return the
          // org's row untouched — re-copying would clobber their edits.
          const existing = await tx.volunteering.getRoleTemplateWithShifts(
            clash.id,
          );
          if (existing) return existing;
        }
        throw fail("TEMPLATE_NAME_TAKEN");
      }

      const created = await tx.volunteering.createRoleTemplate({
        orgId: input.orgId,
        name: targetName,
        description: source.description,
        defaultCapacity: source.defaultCapacity,
        sortOrder: source.sortOrder,
        // Provenance. Never `isPlatform` — createRoleTemplate cannot set it,
        // which is the point: no organizer-facing path mints a catalogue row.
        packId: source.packId,
      });

      const sourceShifts = await tx.volunteering.listRoleTemplateShifts(
        source.id,
      );
      if (sourceShifts.length > 0) {
        await tx.volunteering.upsertRoleTemplateShifts(
          created.id,
          sourceShifts.map((shift) => ({
            label: shift.label,
            startMinuteOfDay: shift.startMinuteOfDay,
            endMinuteOfDay: shift.endMinuteOfDay,
            startDayOffset: shift.startDayOffset,
            endsNextDay: shift.endsNextDay,
            capacity: shift.capacity,
            position: shift.position,
            // The three anchor columns ride along verbatim. Dropping any of
            // them here would move the shift to a different time on the
            // organizer's first apply, with nothing on screen to show it.
            anchor: shift.anchor,
            offsetMinutes: shift.offsetMinutes,
            notes: shift.notes,
          })),
        );
      }

      await tx.audit.log({
        entity: "volunteer_role_template",
        entityId: created.id,
        action: "forked_from_platform",
        data: {
          actorHumanId: input.actorHumanId,
          orgId: input.orgId,
          sourceTemplateId: source.id,
          packId: source.packId,
          name: targetName,
          shiftCount: sourceShifts.length,
        },
        at: deps.clock.now(),
      });

      const withShifts = await tx.volunteering.getRoleTemplateWithShifts(
        created.id,
      );
      if (!withShifts) {
        // Unreachable: we just created it inside this transaction.
        throw fail("TEMPLATE_NOT_FOUND");
      }
      return withShifts;
    });

    await deps.idempotency.commit<StoredFork>(
      key,
      { forkedTemplateId: forked.id },
      IDEMPOTENCY_KEEP_SECONDS,
    );

    deps.logger?.info("forkPlatformRoleTemplate.completed", {
      orgId: input.orgId,
      sourceTemplateId: input.templateId,
      forkedTemplateId: forked.id,
    });

    return forked;
  } catch (error) {
    // Explicit near-zero retention. The adapters' DEFAULT is a 15-minute
    // hold on a failed key, which would lock out the corrected retry this
    // use case documents (different name) as well as any retry after a
    // transient blip — see FAILURE_KEEP_SECONDS.
    await deps.idempotency.fail(key, describeError(error), FAILURE_KEEP_SECONDS);
    throw error;
  }
}
