import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";
import { plainTextRequired } from "../../lib/sanitize-plain-text";
import { buildPageSlug } from "./_shared/page-slug";

// ── Schema ────────────────────────────────────────────────────────────────────

const addressSchema = z.object({
  formatted: z.string().trim().min(1).max(280),
  /**
   * OPTIONAL — mirrors `upsertPlace`'s `addressSchema`.
   *
   * `Place.addrLine1` is `String?` and plenty of real venues (parks, DIY
   * spaces, house shows, city-only stubs) have no street address. This schema
   * requiring it is what pushed the platform CSV importer into forging a
   * literal `"TBD"`, which then persisted to `Place.addrLine1` and rendered
   * publicly. `formatted` stays required, so an address still has to say
   * something; it just no longer has to be a street.
   */
  line1: z.string().trim().max(160).optional(),
  line2: z.string().trim().max(160).optional(),
  city: z.string().trim().max(120).optional(),
  region: z.string().trim().max(120).optional(),
  postalCode: z.string().trim().max(32).optional(),
  countryCode: z
    .string()
    .trim()
    .length(2)
    .transform((v) => v.toUpperCase()),
  lat: z.number().gte(-90).lte(90).optional(),
  lng: z.number().gte(-180).lte(180).optional(),
});

const ownerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("org"), orgId: z.string().uuid() }),
  z.object({ kind: z.literal("human"), humanId: z.string().uuid() }),
]);

const placeRowSchema = z.object({
  name: plainTextRequired(140).pipe(z.string().min(2)),
  address: addressSchema,
  /**
   * OPTIONAL — an absent owner imports the place UNOWNED, which is the point of
   * the platform CSV importer: a scraped venue must stay `claimable` for its
   * real operator. Stamping the importing staff human as a verified owner (the
   * old behaviour) made `getPlaceClaimEligibility` return `already_claimed` /
   * `verified_owner_exists` forever after. Deliberately NOT defaulted to the
   * actor.
   */
  owner: ownerSchema.optional(),
  capacity: z.number().int().positive().max(200_000).optional(),
  phone: z.string().trim().max(40).optional(),
  website: z.string().trim().max(500).url().optional(),
  /**
   * Provenance of `website`. OMITTING it yields `UNKNOWN` in the adapter — the
   * fail-safe default, and the right one for every importer that exists today.
   *
   * `TRUSTED_IMPORT` is RESERVED for genuinely curated feeds (a verified import
   * / PRO list / Google Places) because it arms the FR-010 fast-track:
   * `submit-place-claim` will auto-verify an email_domain_match against the
   * place's website domain with no admin in the loop. A staff CSV paste or an
   * LLM scrape is not a verified import path, so neither importer sends this —
   * see docs/specs/2026-07-05/completed/claim-venue-flow.spec.yaml (FR-010 mitigation:
   * "set exclusively by verified import paths").
   */
  websiteSource: z.enum(["TRUSTED_IMPORT", "USER_STUB", "UNKNOWN"]).optional(),
  listedInDirectory: z.boolean().optional(),
});

export const bulkImportPlacesInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  places: z.array(placeRowSchema).min(1).max(500),
});

export const bulkImportPlacesOutputSchema = z.object({
  total: z.number().int(),
  created: z.number().int(),
});

export type BulkImportPlacesInput = z.infer<typeof bulkImportPlacesInputSchema>;
export type BulkImportPlacesOutput = z.infer<
  typeof bulkImportPlacesOutputSchema
>;

export type BulkImportPlacesDeps = {
  repos: Pick<Repos, "places" | "entityPages" | "audit" | "tx">;
  authz: AuthZPort;
  logger?: LoggerPort;
};

// ── Use case ──────────────────────────────────────────────────────────────────

export async function bulkImportPlaces(
  deps: BulkImportPlacesDeps,
  rawInput: unknown,
): Promise<BulkImportPlacesOutput> {
  const logger = deps.logger?.child({ useCase: "bulkImportPlaces" });
  const startMs = Date.now();

  const input = parseInput(bulkImportPlacesInputSchema, rawInput);

  // RBAC: platform staff only
  const check = await deps.authz.hasStaffRole({
    actorHumanId: input.actorHumanId,
    requiredRoles: ["ADMIN"],
  });
  if (!check.allowed) {
    throw fail("STAFF_ONLY");
  }

  // Assign UUIDs here so ownerships can reference them in the same batch
  const placesWithIds = input.places.map((pl) => ({
    ...pl,
    id: randomUUID(),
    address: {
      formatted: pl.address.formatted,
      // `""`, not `null` — same normalisation as `upsertPlace`: every existing
      // addressless caller already writes the empty string, so downstream
      // reads (`filter(Boolean)` joins, `addressLine1 && …` guards) are built
      // for it. (The port's `line1` is optional, but omitted means "leave
      // alone", which says nothing on a create.)
      line1: pl.address.line1 ?? "",
      line2: pl.address.line2,
      city: pl.address.city,
      region: pl.address.region,
      postalCode: pl.address.postalCode,
      countryCode: pl.address.countryCode,
    },
    geo:
      pl.address.lat !== undefined
        ? { lat: pl.address.lat, lng: pl.address.lng }
        : undefined,
  }));

  const result = await deps.repos.tx(async (tx) => {
    const { created } = await tx.places.bulkCreate(
      placesWithIds.map((pl) => ({
        id: pl.id,
        name: pl.name,
        address: pl.address,
        geo: pl.geo,
        owner: pl.owner,
        capacity: pl.capacity ?? null,
        phone: pl.phone ?? null,
        website: pl.website ?? null,
        // Undefined here means the adapter's fail-safe `UNKNOWN`, never a
        // fast-track-arming `TRUSTED_IMPORT`.
        websiteSource: pl.websiteSource,
        listedInDirectory: pl.listedInDirectory ?? false,
      })),
    );

    // ── Public page per imported venue ──────────────────────────────────
    //
    // WITHOUT THIS, A BULK-IMPORTED VENUE HAS NO PUBLIC PAGE AT ALL.
    // `/places/[slug]` and `/p/[slug]` resolve `EntityPage.slug`; a place with
    // no EntityPage row is reachable only via the `/places/id/[placeId]`
    // fallback, which nothing links to and no crawler finds. `upsertPlace`
    // has always minted a page on create — the import path silently did not,
    // so every scraped venue landed invisible.
    //
    // The slug comes from `buildPageSlug`, the SAME helper the create path
    // uses: a FLAT `{name}-{id8}` segment. It is the venue's ONLY addressable
    // slug — the deprecated `Place.slug` was multi-segment
    // (`us/tn/x--a1b2c3d4e5`) and could never match a single-segment route, so
    // nothing mints or reads it any more.
    //
    // Same transaction as the places, so there is no window in which a venue
    // exists without its page.
    const pageRows = placesWithIds.map((pl) => ({
      ownerType: "PLACE" as const,
      ownerId: pl.id,
      slug: buildPageSlug(pl.name, pl.id),
      displayName: pl.name,
      // The import schema carries no bio — a scraped row has nothing
      // trustworthy to put in one, and inventing copy for a venue whose real
      // operator has not claimed it yet would be worse than an empty page.
      bio: null,
    }));

    const { created: pagesCreated } = await tx.entityPages.bulkCreate(pageRows);

    // A short count means the repo dropped a row on a unique collision —
    // either the globally-unique `slug` or `(ownerType, ownerId)`. Both are
    // vanishingly unlikely (the slug carries 8 hex chars of the row's own
    // freshly-minted uuid, and the place ids are new), but "unlikely" is not
    // "handled": letting it pass would ship precisely the defect this block
    // exists to fix — a venue in the directory with no page, silently, with
    // nothing in the logs. So the whole import rolls back instead. A failed
    // import is retryable (new uuids ⇒ new slug suffixes); a page-less venue
    // is permanent and invisible.
    if (pagesCreated !== pageRows.length) {
      throw fail("INTERNAL", {
        message: "entity_page_insert_count_mismatch",
        meta: { requested: pageRows.length, created: pagesCreated },
      });
    }

    // The generated ids go in the audit row, not just a count: these places
    // land publicly listed AND claimable, so an import has to leave a record of
    // exactly WHICH venues it minted — a bare `count` gives an operator nothing
    // to reconcile or roll back against after a several-hundred-row load.
    await tx.audit.log({
      entity: "Place",
      entityId: "batch",
      action: "admin.bulkImportPlaces",
      data: {
        count: created,
        actorHumanId: input.actorHumanId,
        placeIds: placesWithIds.map((pl) => pl.id),
      },
    });

    return { created };
  });

  logger?.info("bulkImportPlaces.completed", {
    total: input.places.length,
    created: result.created,
    durationMs: Date.now() - startMs,
  });

  return { total: input.places.length, created: result.created };
}
