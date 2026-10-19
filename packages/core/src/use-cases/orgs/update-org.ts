import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { ORG_ADMIN_ROLES } from "../../lib/rbac";
import { fail } from "@th/errors";
import { sanitizePlainText } from "../../lib/sanitize-plain-text";
import { markForSearchReindex } from "../search/search-reindex-marks";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

/** Base shape without refinements — safe for `.omit()` in tRPC routers. */
export const updateOrgInputSchemaBase = z
  .object({
    actorHumanId: z.string().uuid(),
    orgId: z.string().uuid(),
    // Sanitize BEFORE length validation (matches `plainTextOptional`'s
    // ordering) so the min/max bounds apply to the cleaned value; composed
    // manually here because the org name needs a `min(2)` floor that the
    // shared `plainTextOptional` helper doesn't expose.
    name: z
      .string()
      .transform(sanitizePlainText)
      .pipe(z.string().min(2, "name_min_length").max(140, "name_max_length"))
      .optional(),
    defaultLocale: z.string().min(2).max(10).nullable().optional(),
    contactEmail: z.string().email("invalid_email").nullable().optional(),
    physicalAddress: z
      .string()
      .max(500, "address_max_length")
      .nullable()
      .optional(),
  })
  .strict();

export const updateOrgInputSchema = updateOrgInputSchemaBase.refine(
  (v) =>
    v.name !== undefined ||
    v.defaultLocale !== undefined ||
    v.contactEmail !== undefined ||
    v.physicalAddress !== undefined,
  { message: "at_least_one_field_required" },
);

export const updateOrgOutputSchema = z
  .object({
    ok: z.literal(true),
    org: z.object({
      id: z.string().uuid(),
      name: z.string(),
      slug: z.string(),
      defaultLocale: z.string().nullable(),
      contactEmail: z.string().nullable(),
      physicalAddress: z.string().nullable(),
    }),
  })
  .strict();

export type UpdateOrgInput = z.infer<typeof updateOrgInputSchema>;
export type UpdateOrgOutput = z.infer<typeof updateOrgOutputSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type UpdateOrgDeps = {
  repos: Repos;
  authz: AuthZPort;
  clock: ClockPort;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

const REQUIRED_ACTOR_ROLES = ORG_ADMIN_ROLES;

export async function updateOrg(
  deps: UpdateOrgDeps,
  rawInput: unknown,
): Promise<UpdateOrgOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "updateOrg" });

  const input = parseInput(updateOrgInputSchema, rawInput);

  await deps.authz.requireOrgRole({
    actorHumanId: input.actorHumanId,
    orgId: input.orgId,
    requiredRoles: [...REQUIRED_ACTOR_ROLES],
  });

  // The org's search document shows its name and slug.
  const searchMarked = input.name !== undefined;
  const org = await deps.repos.tx(async (tx) => {
    const existing = await tx.organizations.getById(input.orgId);
    if (!existing) {
      throw fail("ORG_NOT_FOUND");
    }

    const newName = input.name?.trim() ?? existing.name;
    const newSlug = input.name !== undefined ? slugify(newName) : existing.slug;

    // CONDITIONAL SPREADS, NOT `? x : undefined` — a key set to `undefined` is
    // NOT the same as an absent key here.
    //
    // `makeOrganizationsRepo.update` decides what to write with
    // `Object.prototype.hasOwnProperty`, which is TRUE for a key whose value is
    // `undefined`, and then coalesces (`input.contactEmail ?? null`). So the
    // previous always-present-key literal told the adapter "write NULL" for
    // every field the caller had merely omitted. It never fired while the only
    // UI sent name + contactEmail + physicalAddress on one Save; the moment
    // settings split into per-section routes and started sending genuine
    // partial patches, saving just the group NAME wiped the CAN-SPAM mailing
    // address, the reply-to email and the default locale — and silently, since
    // the audit entry below only records fields the caller actually supplied.
    //
    // The adapter's `hasOwnProperty` contract is deliberate and stays: passing
    // an explicit `null` is how a caller CLEARS a field, which
    // `OrgContactSection`'s `contactEmail || null` relies on. Only genuinely
    // absent keys must stay absent. Every other `organizations.update` caller
    // already builds a sparse literal this way.
    const updated = await tx.organizations.update({
      id: input.orgId,
      // Name and slug move as a unit — the slug is derived from the name.
      ...(input.name !== undefined ? { name: newName, slug: newSlug } : {}),
      ...(input.defaultLocale !== undefined
        ? { defaultLocale: input.defaultLocale }
        : {}),
      ...(input.contactEmail !== undefined
        ? { contactEmail: input.contactEmail }
        : {}),
      ...(input.physicalAddress !== undefined
        ? { physicalAddress: input.physicalAddress }
        : {}),
    });

    const now = deps.clock.now();

    await tx.audit.log({
      entity: "organization",
      entityId: input.orgId,
      action: "org.updated",
      data: {
        actorHumanId: input.actorHumanId,
        changes: {
          ...(input.name !== undefined
            ? { name: { from: existing.name, to: newName } }
            : {}),
          ...(input.name !== undefined && newSlug !== existing.slug
            ? { slug: { from: existing.slug, to: newSlug } }
            : {}),
          ...(input.defaultLocale !== undefined
            ? {
                defaultLocale: {
                  from: existing.defaultLocale,
                  to: input.defaultLocale,
                },
              }
            : {}),
          ...(input.contactEmail !== undefined
            ? {
                contactEmail: {
                  from: existing.contactEmail,
                  to: input.contactEmail,
                },
              }
            : {}),
          ...(input.physicalAddress !== undefined
            ? {
                physicalAddress: {
                  from: existing.physicalAddress,
                  to: input.physicalAddress,
                },
              }
            : {}),
        },
      },
      at: now,
    });

    if (searchMarked) {
      await markForSearchReindex(
        tx,
        [{ kind: "organization", id: input.orgId }],
        now,
      );
    }

    return updated;
  });

  scopedLogger?.info("updateOrg.completed", {
    orgId: input.orgId,
    name: org.name,
    slug: org.slug,
  });

  return updateOrgOutputSchema.parse({
    ok: true,
    org: {
      id: org.id,
      name: org.name,
      slug: org.slug,
      defaultLocale: org.defaultLocale ?? null,
      contactEmail: org.contactEmail ?? null,
      physicalAddress: org.physicalAddress ?? null,
    },
  });
}
