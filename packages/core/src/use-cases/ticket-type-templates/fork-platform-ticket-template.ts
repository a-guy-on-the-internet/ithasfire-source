import { fail } from "@th/errors";
import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { OrgRole } from "@th/ports/repos/authz";
import type { TicketTypeTemplateRecord } from "@th/types";

import { abandonClaim } from "../../lib/idempotency-claim";
import { parseInput } from "../../lib/io";
import { ensureTemplateOwnerAccess } from "../event-templates/permissions";
import {
  forkPlatformTicketTemplateInputSchema,
  forkPlatformTicketTemplateResultSchema,
  ticketTypeTemplateStoredEntrySchema,
  type ForkPlatformTicketTemplateResult,
} from "./schemas";

// ── Deps ────────────────────────────────────────────────────────────────────

export type ForkPlatformTicketTemplateDeps = {
  repos: Repos;
  clock: ClockPort;
  idempotency: IdempotencyPort;
  logger?: LoggerPort;
  reportError?: ReporterPort;
};

/**
 * Claim window for the fork lock. Long enough to cover a slow transaction,
 * short enough that a crashed run frees the key before a human retries.
 */
const IDEMPOTENCY_TTL_SECONDS = 60;

/**
 * How long a successful fork's result stays replayable. The DURABLE guard is
 * the in-transaction (packId, name) re-read below plus `findByName`'s
 * owner-scoped uniqueness precheck, which never expire. This cache only
 * exists to make the double-click cheap.
 */
const IDEMPOTENCY_KEEP_SECONDS = 24 * 60 * 60;

/** Derived from (owner, source template id) — spec FR-010. */
function buildForkKey(
  ownerScope: string,
  ownerId: string,
  templateId: string,
): string {
  return `ticket-template-fork:${ownerScope}:${ownerId}:${templateId}`;
}

type StoredFork = { forkedTemplateId: string };

/**
 * Is this owned row the fork of that catalogue row?
 *
 * Provenance is (packId, name) — the same identity the FR-006 list shadowing
 * and the partial unique index `TicketTypeTemplate_platform_pack_name_key`
 * use. The two must agree, or Customise would create a second row the list
 * then refuses to hide.
 */
function isForkOf(
  candidate: { isPlatform: boolean; packId: string | null; name: string },
  source: { packId: string | null; name: string },
): boolean {
  if (candidate.isPlatform) return false;
  if (!source.packId || candidate.packId !== source.packId) return false;
  return candidate.name.toLowerCase() === source.name.toLowerCase();
}

/** OWNER | ADMIN — the org roles allowed to mint templates via Customise. */
const FORK_ORG_ROLES: ReadonlySet<OrgRole> = new Set(["OWNER", "ADMIN"]);

async function requireForkAccess(
  repos: TxRepos,
  ownerScope: "ORGANIZATION" | "HUMAN",
  ownerId: string,
  actorHumanId: string,
  logger?: LoggerPort,
): Promise<void> {
  await ensureTemplateOwnerAccess(
    repos,
    ownerScope,
    ownerId,
    actorHumanId,
    // Spec FR authz: org OWNER | ADMIN, or the human themself (HUMAN scope
    // is enforced inside ensureTemplateOwnerAccess regardless of roles).
    { purpose: "edit", allowedOrgRoles: FORK_ORG_ROLES },
    logger,
  );
}

// ── Use case ────────────────────────────────────────────────────────────────

/**
 * "Customise" — copy a LIVE platform catalogue template into an owned copy
 * (spec FR-009/FR-010). Structured on volunteering/fork-platform-template.ts.
 *
 * The copy is a normal owned row: `ownerScope`/`ownerId` from the caller's
 * context, `isPlatform` false, `packId` RETAINED as provenance — which
 * powers FR-006 shadowing and lets the fork outlive its pack via SetNull.
 * Entries are copied by parsing each through
 * `ticketTypeTemplateStoredEntrySchema`: unknown keys stripped, defaults applied.
 *
 * Idempotent per (owner, source template id); two independent guards,
 * because the store's key eventually expires and the data does not:
 *
 *   1. The idempotency store, claimed before the write, committed after.
 *   2. A durable re-read: an existing, live fork of the same catalogue row
 *      is RETURNED unchanged rather than duplicated (re-copying would
 *      clobber the owner's edits).
 *
 * Name collisions never destroy existing work: an owned template with the
 * target name that is NOT this catalogue row's fork fails with
 * TEMPLATE_NAME_TAKEN, and the UI re-submits with an explicit new name.
 * (An archived fork counts as a collision on purpose — reviving it silently
 * could resurrect a row the owner deliberately retired.)
 *
 * AUTHZ RUNS BEFORE THE IDEMPOTENCY STORE IS TOUCHED (FR-010, the
 * volunteer fork's NFR-002 lesson): the replay path returns a full owned
 * template for whichever owner the key names, so a membership check placed
 * after the cache read would hand an ex-member another org's customised
 * template. Replay also re-verifies tenancy on the cached id rather than
 * trusting it.
 */
export async function forkPlatformTicketTemplate(
  deps: ForkPlatformTicketTemplateDeps,
  rawInput: unknown,
): Promise<ForkPlatformTicketTemplateResult> {
  const scopedLogger = deps.logger?.child({
    useCase: "forkPlatformTicketTemplate",
  });
  const input = parseInput(forkPlatformTicketTemplateInputSchema, rawInput);
  const key = buildForkKey(input.ownerScope, input.ownerId, input.templateId);

  // ── AUTHZ FIRST ───────────────────────────────────────────────────────────
  // Before the idempotency store is read, claimed, or otherwise touched.
  // `ownerId` is caller-supplied and the key is derived from it, so anyone
  // can name any owner; platform template ids are visible to every org by
  // design. This check guards the READ path; the one inside `repos.tx`
  // guards the WRITE on the transaction's snapshot.
  await deps.repos.tx(async (tx) => {
    await requireForkAccess(
      tx,
      input.ownerScope,
      input.ownerId,
      input.actorHumanId,
      scopedLogger,
    );
  });

  const toResult = (
    template: TicketTypeTemplateRecord,
  ): ForkPlatformTicketTemplateResult =>
    forkPlatformTicketTemplateResultSchema.parse({
      template: {
        id: template.id,
        ownerScope: template.ownerScope,
        ownerId: template.ownerId,
        name: template.name,
        ticketTypes: template.ticketTypes,
        isPlatform: template.isPlatform,
        packId: template.packId,
        createdByHumanId: template.createdByHumanId,
        createdAt: template.createdAt,
        updatedAt: template.updatedAt,
      },
    });

  const replayFork = async (
    stored: StoredFork | null,
  ): Promise<TicketTypeTemplateRecord | null> => {
    if (!stored) return null;
    const existing = await deps.repos.ticketTypeTemplates.getById(
      stored.forkedTemplateId,
    );
    // Re-verify tenancy on replay rather than trusting the cached id: the
    // row could have been deleted/archived, and a cache that outlived it
    // must not become a way to read someone else's template.
    if (
      !existing ||
      existing.isPlatform ||
      existing.ownerId !== input.ownerId ||
      existing.ownerScope !== input.ownerScope ||
      existing.archivedAt
    ) {
      return null;
    }
    return existing;
  };

  // Both replay call sites below are reachable only past the access check
  // above.
  const cached = await replayFork(await deps.idempotency.get<StoredFork>(key));
  if (cached) return toResult(cached);

  const ownerToken = crypto.randomUUID();
  const claimed = await deps.idempotency.begin(
    key,
    IDEMPOTENCY_TTL_SECONDS,
    ownerToken,
  );
  if (!claimed) {
    const replay = await replayFork(
      await deps.idempotency.get<StoredFork>(key),
    );
    if (replay) return toResult(replay);
    throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS");
  }

  let forked: TicketTypeTemplateRecord;
  try {
    forked = await deps.repos.tx(async (tx) => {
      // Re-checked on the transaction's snapshot: the pre-claim check above
      // guards the read path, this one guards the write.
      await requireForkAccess(
        tx,
        input.ownerScope,
        input.ownerId,
        input.actorHumanId,
        scopedLogger,
      );

      const source = await tx.ticketTypeTemplates.getById(input.templateId);
      // Only a LIVE catalogue row is forkable. Another owner's template, a
      // DRAFT pack's template, and an archived row all answer the same
      // TEMPLATE_NOT_FOUND — no existence signal. An owned row reaching
      // here would already be the caller's to edit; refusing keeps this
      // endpoint from doubling as "duplicate my template" with different
      // authz.
      if (
        !source ||
        !source.isPlatform ||
        source.ownerId !== null ||
        !source.packId ||
        source.archivedAt
      ) {
        throw fail("TEMPLATE_NOT_FOUND");
      }
      const pack = await tx.ticketTypeTemplates.getPack(source.packId);
      if (!pack || pack.status !== "LIVE") {
        throw fail("TEMPLATE_NOT_FOUND");
      }

      const targetName = input.name ?? source.name;

      // OWNED-ONLY read, archived included — findByName sees archived rows,
      // so the precheck matches what a unique constraint would count.
      const clash = await tx.ticketTypeTemplates.findByName(
        input.ownerScope,
        input.ownerId,
        targetName,
      );
      if (clash) {
        if (
          !clash.archivedAt &&
          isForkOf(clash, { packId: source.packId, name: targetName })
        ) {
          // Already forked (stale tab, expired idempotency key). Return the
          // owner's row untouched — re-copying would clobber their edits.
          return clash;
        }
        throw fail("TEMPLATE_NAME_TAKEN");
      }

      const now = deps.clock.now();
      const created = await tx.ticketTypeTemplates.create({
        ownerScope: input.ownerScope,
        ownerId: input.ownerId,
        name: targetName,
        // Entries are copied (FR-009) by parsing each through the stored-entry
        // schema: keys the schema no longer declares are stripped and its
        // defaults are applied, so the fork holds what a write would accept.
        ticketTypes: source.ticketTypes.map((entry) =>
          ticketTypeTemplateStoredEntrySchema.parse(entry),
        ),
        createdByHumanId: input.actorHumanId,
        createdAt: now,
        // Provenance. Never `isPlatform` — `create` cannot set it, which is
        // the point: no organizer-facing path mints a catalogue row.
        packId: source.packId,
      });

      await tx.audit.log({
        entity: "ticket_type_template",
        entityId: created.id,
        action: "forked_from_platform",
        data: {
          actorHumanId: input.actorHumanId,
          ownerScope: input.ownerScope,
          ownerId: input.ownerId,
          sourceTemplateId: source.id,
          packId: source.packId,
          name: targetName,
          entryCount: created.ticketTypes.length,
        },
        at: now,
      });

      return created;
    });

  } catch (error) {
    // Release (not a `failed:` marker): the documented TEMPLATE_NAME_TAKEN
    // rename-and-retry reuses this SAME key (it derives from owner + source
    // template, not name), so the retry must be able to begin at once. See
    // lib/idempotency-claim.ts. Commit is deliberately OUTSIDE this catch: if
    // the fork committed and only the store write throws, releasing would let
    // a retry redo committed work.
    await abandonClaim(deps.idempotency, key, ownerToken, error, {
      useCase: "forkPlatformTicketTemplate",
      logger: deps.logger,
      reportError: deps.reportError,
    });
    throw error;
  }

  await deps.idempotency.commit<StoredFork>(
    key,
    { forkedTemplateId: forked.id },
    IDEMPOTENCY_KEEP_SECONDS,
  );

  scopedLogger?.info("forkPlatformTicketTemplate.completed", {
    ownerScope: input.ownerScope,
    ownerId: input.ownerId,
    sourceTemplateId: input.templateId,
    forkedTemplateId: forked.id,
  });

  return toResult(forked);
}
