import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type {
  RoleTemplateRecord,
  RoleTemplateShiftRecord,
  RoleTemplateWithShiftsRecord,
} from "@th/ports/repos/volunteering";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";
import {
  requireOrgMembership,
  ORG_ADMIN_ROLES,
  ORG_ANY_ROLE,
  ORG_EDIT_ROLES,
} from "../../lib/rbac";
import {
  requireOrgOwnedTemplate,
  requireTemplateOrgMembership,
  tryOrgOwnedTemplate,
} from "./_shared/require-org-owned-template";
import {
  createRoleTemplateInputSchema,
  updateRoleTemplateInputSchema,
  archiveRoleTemplateInputSchema,
  listRoleTemplatesInputSchema,
  upsertRoleTemplateShiftsInputSchema,
  getRoleTemplateWithShiftsInputSchema,
  type CreateRoleTemplateUseCaseInput,
  type UpdateRoleTemplateUseCaseInput,
  type ArchiveRoleTemplateUseCaseInput,
  type ListRoleTemplatesUseCaseInput,
} from "./schemas";

// ── Deps ────────────────────────────────────────────────────────────────────

export type ManageRoleTemplatesDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

// ── Create ──────────────────────────────────────────────────────────────────

/**
 * Create a new org-level volunteer role template.
 *
 * Auth: OWNER | ADMIN on the org.
 * Unique constraint on (orgId, name) — throws `template_name_taken` on conflict.
 */
export async function createRoleTemplate(
  deps: ManageRoleTemplatesDeps,
  rawInput: unknown,
): Promise<RoleTemplateRecord> {
  const input = parseInput(createRoleTemplateInputSchema, rawInput);

  return deps.repos.tx(async (tx) => {
    await requireOrgMembership({
      repos: tx,
      orgId: input.orgId,
      actorHumanId: input.actorHumanId,
      roles: ORG_ADMIN_ROLES,
    });

    // Check unique constraint proactively for a nicer error message
    const existing = await tx.volunteering.listRoleTemplates(input.orgId, {
      includeArchived: true,
    });
    if (
      existing.some((t) => t.name.toLowerCase() === input.name.toLowerCase())
    ) {
      throw fail("TEMPLATE_NAME_TAKEN");
    }

    const created = await tx.volunteering.createRoleTemplate({
      orgId: input.orgId,
      name: input.name,
      description: input.description ?? null,
      defaultCapacity: input.defaultCapacity ?? null,
    });

    await tx.audit.log({
      entity: "volunteer_role_template",
      entityId: created.id,
      action: "created",
      data: { orgId: input.orgId, name: input.name },
      at: deps.clock.now(),
    });

    return created;
  });
}

// ── Update ──────────────────────────────────────────────────────────────────

/**
 * Update an existing volunteer role template.
 *
 * Auth: OWNER | ADMIN on the template's org — and NEVER on a platform
 * catalogue row, which `requireOrgOwnedTemplate` rejects before the
 * membership check runs (FR-007). Authz here is derived from the row, so a
 * row with no owning org has no derivable authz and must not be reachable.
 */
export async function updateRoleTemplate(
  deps: ManageRoleTemplatesDeps,
  rawInput: unknown,
): Promise<RoleTemplateRecord> {
  const input = parseInput(updateRoleTemplateInputSchema, rawInput);

  return deps.repos.tx(async (tx) => {
    const { template, orgId } = requireOrgOwnedTemplate(
      await tx.volunteering.getRoleTemplate(input.id),
    );

    // Non-members 404 rather than 403 — otherwise the error itself confirms
    // that another org's template exists. A MEMBER holding the wrong role
    // still gets the actionable INSUFFICIENT_ROLE below.
    await requireTemplateOrgMembership({
      repos: tx,
      orgId,
      actorHumanId: input.actorHumanId,
    });

    await requireOrgMembership({
      repos: tx,
      orgId,
      actorHumanId: input.actorHumanId,
      roles: ORG_ADMIN_ROLES,
    });

    // If renaming, check for name collisions. ORG-ONLY on purpose — the DB
    // unique is (orgId, name), so a platform role sharing the name is not a
    // collision.
    if (
      input.name &&
      input.name.toLowerCase() !== template.name.toLowerCase()
    ) {
      const siblings = await tx.volunteering.listRoleTemplates(orgId, {
        includeArchived: true,
      });
      if (
        siblings.some(
          (t) =>
            t.id !== input.id &&
            t.name.toLowerCase() === input.name!.toLowerCase(),
        )
      ) {
        throw fail("TEMPLATE_NAME_TAKEN");
      }
    }

    const updated = await tx.volunteering.updateRoleTemplate(input.id, {
      name: input.name,
      description: input.description,
      defaultCapacity: input.defaultCapacity,
      sortOrder: input.sortOrder,
    });

    await tx.audit.log({
      entity: "volunteer_role_template",
      entityId: input.id,
      action: "updated",
      data: { name: input.name },
      at: deps.clock.now(),
    });

    return updated;
  });
}

// ── Archive ─────────────────────────────────────────────────────────────────

/**
 * Soft-archive a volunteer role template.
 *
 * Auth: OWNER | ADMIN on the template's org — and NEVER on a platform
 * catalogue row (FR-007): archiving one would pull it out of every other
 * org's list.
 * Does not affect existing event roles derived from this template.
 */
export async function archiveRoleTemplate(
  deps: ManageRoleTemplatesDeps,
  rawInput: unknown,
): Promise<void> {
  const input = parseInput(archiveRoleTemplateInputSchema, rawInput);

  await deps.repos.tx(async (tx) => {
    const { template, orgId } = requireOrgOwnedTemplate(
      await tx.volunteering.getRoleTemplate(input.id),
    );

    // Non-members 404 rather than 403 — otherwise the error itself confirms
    // that another org's template exists. A MEMBER holding the wrong role
    // still gets the actionable INSUFFICIENT_ROLE below.
    await requireTemplateOrgMembership({
      repos: tx,
      orgId,
      actorHumanId: input.actorHumanId,
    });

    await requireOrgMembership({
      repos: tx,
      orgId,
      actorHumanId: input.actorHumanId,
      roles: ORG_ADMIN_ROLES,
    });

    if (template.archived) {
      return; // idempotent
    }

    await tx.volunteering.archiveRoleTemplate(input.id);

    await tx.audit.log({
      entity: "volunteer_role_template",
      entityId: input.id,
      action: "archived",
      data: { orgId, name: template.name },
      at: deps.clock.now(),
    });
  });
}

// ── List ────────────────────────────────────────────────────────────────────

/**
 * Shadow key for pack provenance (FR-011).
 *
 * A catalogue role's identity inside the catalogue is (pack, name) — that is
 * exactly what the partial unique index
 * `VolunteerRoleTemplate_platform_pack_name_key` enforces, and it is the only
 * identity a fork can carry: `packId` is the sole provenance column, so a
 * fork records WHICH PACK it came from, and its copied `name` records WHICH
 * ROLE of that pack.
 *
 * `packId` alone would be wrong — a pack has many roles, so forking one
 * ("Door") would hide the other five from the organizer's list. `name` alone
 * would also be wrong — an org's own unrelated "Door", created before packs
 * existed, would hide a catalogue "Door" they never forked. The pair is the
 * narrowest key that means "this row IS that catalogue row, customised".
 *
 * Names compare case-insensitively, matching how every other template
 * name-collision check in this file compares them.
 */
function packShadowKey(template: {
  packId: string | null;
  name: string;
}): string | null {
  if (!template.packId) return null;
  return `${template.packId}::${template.name.toLowerCase()}`;
}

/**
 * List volunteer role templates for an org: the org's OWN rows plus the
 * LIVE platform catalogue rows, each carrying `isPlatform` / `packId` so
 * the caller can tag them and offer Customise instead of Edit (FR-009).
 *
 * Rows belonging to a DRAFT pack are excluded by the repo, so no
 * organizer-facing response can surface unpublished catalogue content.
 * Rows belonging to ANOTHER org are excluded by the same query — `orgId`
 * being nullable never widens this to "everyone's rows" (NFR-002).
 *
 * Shadowing (FR-011): when the org has forked a catalogue role, the
 * organizer must see ONE row, their own. The platform row is dropped from
 * the response when an org row carries the same (packId, name) — see
 * {@link packShadowKey}. The shadow set is built from the ORG rows in this
 * same response, so with `includeArchived` false an archived fork stops
 * shadowing and the catalogue row comes back: the org retired their copy,
 * the original is usable again.
 *
 * That coupling runs BOTH ways, and the archived direction is the
 * counter-intuitive one: because the shadow set is built from whatever org
 * rows this response contains, `includeArchived: true` pulls archived forks
 * back INTO it and they resume shadowing. So the "show archived" view can
 * list FEWER catalogue rows than the default view — every catalogue role
 * whose only fork is archived disappears from it. Deliberate: with archived
 * rows on screen the organizer can see their retired copy, so re-showing the
 * catalogue original beside it would be the duplicate the shadowing exists to
 * prevent. Callers rendering the two views should not expect the platform
 * rows to be a superset of the default view's.
 *
 * Auth: any org member (read-only). VIEWER/FINANCE/SCANNER auditor roles
 * can view the templates list read-only; writes stay OWNER | ADMIN.
 */
export async function listRoleTemplates(
  deps: ManageRoleTemplatesDeps,
  rawInput: unknown,
): Promise<RoleTemplateRecord[]> {
  const input = parseInput(listRoleTemplatesInputSchema, rawInput);

  return deps.repos.tx(async (tx) => {
    await requireOrgMembership({
      repos: tx,
      orgId: input.orgId,
      actorHumanId: input.actorHumanId,
      roles: ORG_ANY_ROLE,
    });

    const rows = await tx.volunteering.listRoleTemplates(input.orgId, {
      includeArchived: input.includeArchived ?? false,
      includePlatform: true,
    });

    const shadowed = new Set<string>();
    for (const row of rows) {
      // Org rows only. A platform row never shadows anything, and reading
      // the flag (not "orgId is non-null") keeps a mis-shaped row failing
      // closed, the same test every other gate in this feature uses.
      if (row.isPlatform) continue;
      const key = packShadowKey(row);
      if (key) shadowed.add(key);
    }
    if (shadowed.size === 0) return rows;

    return rows.filter((row) => {
      if (!row.isPlatform) return true;
      const key = packShadowKey(row);
      return key === null || !shadowed.has(key);
    });
  });
}

// ── Get with shifts ─────────────────────────────────────────────────────────

/**
 * Fetch a single template with its shift presets attached. Used by the
 * template EDITOR when opening a template for edit, and by tests.
 *
 * Auth: OWNER | ADMIN | EDITOR on the template's org. A platform catalogue
 * row reads as `null` here: it is not editable by anyone holding an org
 * role, and this input carries no orgId to authorize a read-only view
 * against. The staff preview (STAFF_TECH, FR-016) and the fork flow
 * (FR-011) get their own reads rather than widening this one.
 */
export async function getRoleTemplateWithShifts(
  deps: ManageRoleTemplatesDeps,
  rawInput: unknown,
): Promise<RoleTemplateWithShiftsRecord | null> {
  const input = parseInput(getRoleTemplateWithShiftsInputSchema, rawInput);

  return deps.repos.tx(async (tx) => {
    // Same gate as every mutating path (FR-007), answered with `null`
    // instead of a throw — so this read inherits any future tightening of
    // it rather than drifting from a hand-rolled copy.
    const owned = tryOrgOwnedTemplate(
      await tx.volunteering.getRoleTemplateWithShifts(input.templateId),
    );
    if (!owned) return null;
    const { template, orgId } = owned;

    // A template outside the actor's orgs reads as "not found", the same as
    // a bad id — no existence signal. An in-org member with too weak a role
    // still gets INSUFFICIENT_ROLE below.
    const membership = await tx.authz.getOrgMembership({
      orgId,
      humanId: input.actorHumanId,
    });
    if (!membership) return null;

    await requireOrgMembership({
      repos: tx,
      orgId,
      actorHumanId: input.actorHumanId,
      roles: ORG_EDIT_ROLES,
    });

    return template;
  });
}

// ── Upsert shifts (replace-set) ─────────────────────────────────────────────

/**
 * Replace the shift list for a template in one call. The editor lets
 * users reorder/add/remove rows freely in a single edit session, so we
 * accept the desired state and let the repo run the diff.
 *
 * Validation:
 *   - Each row's end time-of-day must differ from start (or `endsNextDay`
 *     true for a 24-hour shift) — enforced in schema.
 *   - Day offset bounded to [-7, +14] for sanity; 0 means "event day".
 *   - Position is assigned by array index when not provided.
 *   - `offsetMinutes` bounded to ±1440 and forced to 0 on a WALL_CLOCK
 *     preset — enforced in schema.
 *
 * ⚠️ This is a REPLACE-SET write: every row is rewritten from the payload,
 * so any column the payload does not carry is reset to its DB default. That
 * is why `anchor` / `offsetMinutes` / `notes` are threaded through here and
 * through `roleTemplateShiftDraftSchemaBase`. They used to be omitted, which
 * was safe only while no org-owned template could CARRY an anchor; the
 * moment Customise (FR-011) copies a platform template holding
 * `anchor: EVENT_START, offsetMinutes: -180`, an omission here would make
 * the organizer's first save silently reset all three and move the shift to
 * the wrong time — no error, no visible diff. Keep them threaded, and add
 * any future shift column to BOTH the schema and the mapping below.
 *
 * Auth: OWNER | ADMIN on the template's org — and NEVER on a platform
 * catalogue row (FR-007): rewriting its shifts would rewrite them for
 * every org.
 */
export async function upsertRoleTemplateShifts(
  deps: ManageRoleTemplatesDeps,
  rawInput: unknown,
): Promise<RoleTemplateShiftRecord[]> {
  const input = parseInput(upsertRoleTemplateShiftsInputSchema, rawInput);

  return deps.repos.tx(async (tx) => {
    const { orgId } = requireOrgOwnedTemplate(
      await tx.volunteering.getRoleTemplate(input.templateId),
    );

    // Non-members 404 rather than 403 — see updateRoleTemplate.
    await requireTemplateOrgMembership({
      repos: tx,
      orgId,
      actorHumanId: input.actorHumanId,
    });

    await requireOrgMembership({
      repos: tx,
      orgId,
      actorHumanId: input.actorHumanId,
      roles: ORG_ADMIN_ROLES,
    });

    const upserted = await tx.volunteering.upsertRoleTemplateShifts(
      input.templateId,
      input.shifts.map((shift, index) => ({
        label: shift.label,
        startMinuteOfDay: shift.startMinuteOfDay,
        endMinuteOfDay: shift.endMinuteOfDay,
        startDayOffset: shift.startDayOffset ?? 0,
        // When end <= start and the user hasn't explicitly opted in to
        // a 24-hour shift, infer that the shift wraps past midnight.
        endsNextDay:
          shift.endsNextDay ?? shift.endMinuteOfDay < shift.startMinuteOfDay,
        capacity: shift.capacity ?? null,
        position: shift.position ?? index,
        // Anchor round-trip. Omitting any of these would let the replace-set
        // reset a forked EVENT_START preset to wall-clock — see the ⚠️ block.
        anchor: shift.anchor ?? "WALL_CLOCK",
        // Belt-and-braces alongside the schema refine: a wall-clock preset
        // stores no offset, so switching the anchor later can never revive a
        // stale value.
        offsetMinutes:
          (shift.anchor ?? "WALL_CLOCK") === "WALL_CLOCK"
            ? 0
            : (shift.offsetMinutes ?? 0),
        notes: shift.notes ?? null,
      })),
    );

    await tx.audit.log({
      entity: "volunteer_role_template",
      entityId: input.templateId,
      action: "shifts_upserted",
      data: { count: input.shifts.length },
      at: deps.clock.now(),
    });

    return upserted;
  });
}
