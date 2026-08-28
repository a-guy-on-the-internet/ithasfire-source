/**
 * ticket-packs.ts — the launch ticket-type catalogue (FR-013 of
 * docs/specs/2026-08-04/ticket-type-packs.spec.yaml).
 *
 * Four platform-curated packs, seeded through the normal seed path so dev,
 * staging and prod start from the same reviewed baseline. A catalogue row is
 * an ordinary `TicketTypeTemplate` with `ownerId = null`, `isPlatform = true`
 * and `packId` set; `TicketPack` carries only the metadata. Sibling of
 * volunteer-packs.ts with the SAME contract, because this seed also runs on
 * every deploy dispatch.
 *
 * ── Idempotency ────────────────────────────────────────────────────────────
 *
 * Everything is keyed on stable identity, never on row ids:
 *
 *   - a pack on `TicketPack.key` (unique);
 *   - a catalogue template on (`packId`, `name`) — exactly the identity the
 *     partial unique index `TicketTypeTemplate_platform_pack_name_key`
 *     enforces, and the identity an owner's fork carries as provenance
 *     (FR-006 shadowing matches on it), so a re-seed must not churn ids.
 *
 * ── DEFAULT MODE IS INSTALL-ONLY ───────────────────────────────────────────
 *
 *   - CREATE packs and templates that do not exist. A fresh environment
 *     converges on the reviewed git baseline; content added to this file
 *     later still propagates.
 *   - NEVER update an existing row's content. A price a staff member fixed
 *     at /platform/ticket-packs stays fixed (FR-013 acceptance).
 *   - NEVER delete. Retiring catalogue content is a deliberate staff action
 *     through `upsertTicketPack`, which is transactional and audited.
 *   - CURATION is the database's after the first insert: `status` and
 *     `sortOrder` are applied on first insert only. No mode of this seed
 *     re-publishes a pack staff deliberately pulled.
 *
 * Two opt-ins widen that, and BOTH are off in deploy workflows:
 *
 *   - `refresh` — push this file's CONTENT (pack name/blurb, template
 *     name/entries) over existing rows: `pnpm seed:ticket-packs:refresh`.
 *     (NOT `pnpm seed:ticket-packs -- --refresh` — pnpm silently drops
 *     everything after `--`, the repo's documented flag footgun.)
 *   - `prune` — delete catalogue rows the baseline no longer names, plus
 *     case-folded duplicate rows. Pinned to `isPlatform: true`, so an
 *     owner's fork is never reachable from here.
 *
 * `seed-data.ts` passes BOTH: `pnpm seed:dev` recreates the schema, so full
 * convergence is the point.
 *
 * ── Audit ──────────────────────────────────────────────────────────────────
 *
 * A converged re-seed writes NOTHING — no updates, no deletes, no audit
 * rows. Changes are recorded against `entity: "ticket_pack"`:
 *
 *   - `ticket_pack.seed_installed` — rows created
 *   - `ticket_pack.seed_refreshed` — existing content overwritten
 *   - `ticket_pack.seed_pruned`    — rows deleted, in the SAME transaction
 *
 * All four packs are created LIVE.
 *
 * ── Money ──────────────────────────────────────────────────────────────────
 *
 * Integer cents, USD, FACE PRICE ONLY (NFR-003) — templates never bake fees
 * (PASS_THROUGH is grossed up at checkout; a fee-inflated template price
 * would double-charge). Prices are editable starting points a Nashville
 * house show could actually charge. Entries are validated through the staff
 * editor's zod schema (`ticketPackTemplateInputSchema`), so seeded content
 * always round-trips through /platform/ticket-packs.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { ticketPackTemplateInputSchema } from "@th/core/use-cases/platform/ticket-packs";

// ── Catalogue ────────────────────────────────────────────────────────────────

type SeedEntry = {
  name: string;
  priceCents: number;
  pricingMode?: "FIXED" | "ADJUSTABLE";
  minimumCents?: number | null;
  suggestedCents?: number | null;
  capacity: number;
  doorPriceCents?: number | null;
};

type SeedTemplate = {
  name: string;
  entries: SeedEntry[];
};

type SeedPack = {
  key: string;
  name: string;
  blurb: string;
  /** CURATION — applied on first insert only (see the header). */
  sortOrder: number;
  templates: SeedTemplate[];
};

export const LAUNCH_TICKET_PACKS: SeedPack[] = [
  {
    key: "general-admission",
    name: "General admission",
    blurb:
      "One ticket, one price. The starting point for most shows — edit the price and capacity to fit your room.",
    sortOrder: 0,
    templates: [
      {
        name: "General admission",
        entries: [
          { name: "General admission", priceCents: 2000, capacity: 100 },
        ],
      },
    ],
  },
  {
    key: "advance-plus-door",
    name: "Advance + door",
    blurb:
      "One capacity pool, two prices: cheaper in advance, a little more at the door. Rewards buying ahead without splitting your room.",
    sortOrder: 1,
    templates: [
      {
        name: "Advance + door",
        entries: [
          {
            // FR-004's showcase: one FIXED type, one capacity pool, an
            // advance price and a door override.
            name: "General admission",
            priceCents: 1500,
            doorPriceCents: 2000,
            capacity: 100,
          },
        ],
      },
    ],
  },
  {
    key: "early-bird-tiers",
    name: "Early-bird tiers",
    // CAPACITY-limited tiering only — each tier closes by selling out.
    // Deliberately no promise of time-based flips (Phase B); the blurb says
    // "sells out", never "closes Friday".
    blurb:
      "Three price steps that climb as each allocation sells out. Early bird rewards the first fans; day-of-show carries the walk-up price.",
    sortOrder: 2,
    templates: [
      {
        name: "Early-bird tiers",
        entries: [
          { name: "Early bird", priceCents: 1200, capacity: 30 },
          { name: "Advance", priceCents: 1800, capacity: 60 },
          { name: "Day of show", priceCents: 2200, capacity: 30 },
        ],
      },
    ],
  },
  {
    key: "pay-what-you-can",
    name: "Pay what you can",
    blurb:
      "Everyone gets in; people give what they can. Set a suggested amount and let the room decide — works for benefits, house shows, and all-ages spaces.",
    sortOrder: 3,
    templates: [
      {
        name: "Pay what you can",
        entries: [
          {
            name: "Pay what you can",
            priceCents: 0,
            pricingMode: "ADJUSTABLE",
            minimumCents: 0,
            suggestedCents: 1000,
            capacity: 60,
          },
        ],
      },
    ],
  },
];

// ── Validation ───────────────────────────────────────────────────────────────

export type EncodedTemplate = {
  name: string;
  ticketTypes: Array<{
    name: string;
    priceCents: number;
    pricingMode: "FIXED" | "ADJUSTABLE";
    minimumCents: number | null;
    suggestedCents: number | null;
    capacity: number;
    resaleAllowed: boolean;
    resaleCapCents: number | null;
    transferAllowed: boolean;
    doorPriceCents: number | null;
  }>;
};

/**
 * Encode a pack's templates and validate them against the SAME zod schema
 * the staff editor writes through (`ticketPackTemplateInputSchema`, which
 * nests `ticketTypeTemplateEntriesSchema`). Running the catalogue through
 * the real schema guarantees a seeded template is one a staff member can
 * open, edit and re-save. Exported so a unit test can assert it without a
 * database.
 */
export function encodeTicketPackTemplates(pack: SeedPack): EncodedTemplate[] {
  const seenNames = new Set<string>();

  return pack.templates.map((template) => {
    const nameKey = template.name.trim().toLowerCase();
    if (seenNames.has(nameKey)) {
      // Mirrors the partial unique index: one pack cannot list two templates
      // under one name. (Two DIFFERENT packs both shipping a "General
      // admission" is fine — the index is per pack.)
      throw new Error(
        `[ticket-packs] pack "${pack.key}" lists "${template.name}" twice`,
      );
    }
    seenNames.add(nameKey);

    const parsed = ticketPackTemplateInputSchema.parse({
      name: template.name,
      ticketTypes: template.entries.map((entry) => ({
        name: entry.name,
        priceCents: entry.priceCents,
        pricingMode: entry.pricingMode ?? "FIXED",
        minimumCents: entry.minimumCents ?? null,
        suggestedCents: entry.suggestedCents ?? null,
        capacity: entry.capacity,
        // Platform default-OFF gate (FR-013): no seeded entry ever ships
        // resale config.
        resaleAllowed: false,
        resaleCapCents: null,
        transferAllowed: true,
        doorPriceCents: entry.doorPriceCents ?? null,
      })),
    });

    return { name: parsed.name, ticketTypes: parsed.ticketTypes };
  });
}

// ── Seed ─────────────────────────────────────────────────────────────────────

export type TicketPackSeedOptions = {
  /** Overwrite existing pack/template CONTENT with this file's baseline. OFF
   * by default and OFF in deploy workflows — see the header. */
  refresh?: boolean;
  /** Delete catalogue rows the baseline no longer names (+ case-folded
   * duplicates). OFF by default and in deploy workflows. */
  prune?: boolean;
};

export type ExistingTemplate = {
  id: string;
  name: string;
  ticketTypes: Prisma.JsonValue;
  archivedAt: Date | null;
};

const foldKey = (value: string) => value.trim().toLowerCase();

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Deterministic JSON encoding: object keys are sorted recursively.
 *
 * Postgres `jsonb` does NOT preserve key order (it stores keys length-then-
 * bytewise), so a template that round-trips through the database comes back
 * with the same content under a different key order. A naive
 * `JSON.stringify` compare therefore NEVER matches, and a converged
 * `--refresh` run would rewrite every template and emit a
 * `ticket_pack.seed_refreshed` audit row on every single run — the exact
 * churn the header contract forbids. Canonicalizing both sides makes
 * "content equal" mean content, not storage order.
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Deterministic duplicate handling — see volunteer-packs.ts's groupByKey. */
function groupByKey<T>(
  rows: readonly T[],
  key: (row: T) => string,
  order: (a: T, b: T) => number,
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of [...rows].sort(order)) {
    const bucket = out.get(key(row));
    if (bucket) bucket.push(row);
    else out.set(key(row), [row]);
  }
  return out;
}

/**
 * Content comparison for refresh mode. Entries are compared through
 * {@link stableStringify} — see its doc comment: `jsonb` re-orders keys, so
 * byte comparison of raw stringify output is permanently "different".
 * Exported for the convergence unit test in
 * apps/api/test/seed-ticket-packs.test.ts.
 */
export function templateContentDiffers(
  existing: ExistingTemplate,
  desired: EncodedTemplate,
): boolean {
  return (
    existing.name !== desired.name ||
    stableStringify(existing.ticketTypes) !==
      stableStringify(desired.ticketTypes) ||
    // A catalogue template is never archived; a hand-archived row converges
    // back on the reviewed baseline under refresh.
    existing.archivedAt !== null
  );
}

/**
 * Install the launch catalogue (FR-013).
 *
 * INSTALL-ONLY by default — creates what is missing, updates nothing,
 * deletes nothing. A converged re-seed performs zero writes and emits zero
 * audit rows.
 *
 * Written with plain Prisma calls rather than through `upsertTicketPack`,
 * matching volunteer-packs.ts: the staff use case requires an actorHumanId
 * for its RBAC check, and no such human is guaranteed on a fresh production
 * database. `curatedByHumanId` stays null until a staff member edits a
 * pack. Content is still validated against the staff editor's schema by
 * `encodeTicketPackTemplates`, and every change writes an AuditLog row —
 * the seed names itself as the actor.
 */
export async function ensureTicketPacks(
  prisma: PrismaClient,
  options: TicketPackSeedOptions = {},
) {
  const refresh = options.refresh ?? false;
  const prune = options.prune ?? false;

  console.log(
    `Seeding platform ticket packs (refresh=${refresh}, prune=${prune})...`,
  );

  const summary = {
    /** Packs the catalogue declares (processed), not packs written. */
    packCount: 0,
    templateCount: 0,
    createdPacks: 0,
    createdTemplates: 0,
    updatedPacks: 0,
    updatedTemplates: 0,
    removedTemplates: 0,
    /** Deletions the baseline wanted and `prune: false` withheld. */
    withheldTemplateDeletes: 0,
  };

  for (const pack of LAUNCH_TICKET_PACKS) {
    const encoded = encodeTicketPackTemplates(pack);

    const createdTemplateNames: string[] = [];
    const updatedTemplateNames: string[] = [];
    const candidateTemplates: { id: string; name: string }[] = [];
    let packCreated = false;
    let packRefreshed = false;

    const priorPack = await prisma.ticketPack.findUnique({
      where: { key: pack.key },
      select: { id: true, name: true, blurb: true },
    });

    let packId: string;
    if (!priorPack) {
      const row = await prisma.ticketPack.create({
        data: {
          key: pack.key,
          name: pack.name,
          blurb: pack.blurb,
          status: "LIVE",
          sortOrder: pack.sortOrder,
        },
        select: { id: true },
      });
      packId = row.id;
      packCreated = true;
      summary.createdPacks += 1;
    } else {
      packId = priorPack.id;
      if (refresh) {
        // CONTENT only. `status` / `sortOrder` are deliberately absent even
        // here: publishing is `setTicketPackStatus`, and no mode of this
        // seed re-publishes a pack staff pulled.
        const data: Record<string, unknown> = {};
        if (priorPack.name !== pack.name) data.name = pack.name;
        if (priorPack.blurb !== pack.blurb) data.blurb = pack.blurb;
        if (Object.keys(data).length > 0) {
          await prisma.ticketPack.update({
            where: { id: packId },
            data,
            select: { id: true },
          });
          packRefreshed = true;
          summary.updatedPacks += 1;
        }
      }
    }
    summary.packCount += 1;

    // PLATFORM-ONLY: an owner's fork carries the same packId and must never
    // be reachable from here.
    const existingTemplates: ExistingTemplate[] =
      await prisma.ticketTypeTemplate.findMany({
        where: { packId, isPlatform: true },
        select: { id: true, name: true, ticketTypes: true, archivedAt: true },
      });

    const templatesByName = groupByKey<ExistingTemplate>(
      existingTemplates,
      (t) => foldKey(t.name),
      (a, b) => byId(a.id, b.id),
    );
    const unclaimedKeys = new Set(templatesByName.keys());

    for (const template of encoded) {
      const nameKey = foldKey(template.name);
      unclaimedKeys.delete(nameKey);
      const bucket = templatesByName.get(nameKey) ?? [];
      const match = bucket[0];

      if (!match) {
        await prisma.ticketTypeTemplate.create({
          data: {
            ownerId: null,
            isPlatform: true,
            // NOT NULL column; ORGANIZATION by convention on catalogue rows
            // and ignored (spec FR-002).
            ownerScope: "ORGANIZATION",
            packId,
            name: template.name,
            ticketTypes: template.ticketTypes as unknown as Prisma.InputJsonValue,
            createdByHumanId: null,
          },
          select: { id: true },
        });
        createdTemplateNames.push(template.name);
        summary.createdTemplates += 1;
      } else if (refresh && templateContentDiffers(match, template)) {
        await prisma.ticketTypeTemplate.update({
          where: { id: match.id },
          data: {
            name: template.name,
            ticketTypes: template.ticketTypes as unknown as Prisma.InputJsonValue,
            archivedAt: null,
          },
          select: { id: true },
        });
        updatedTemplateNames.push(template.name);
        summary.updatedTemplates += 1;
      }
      summary.templateCount += 1;

      // Case-folded duplicates of a template the baseline DOES name.
      for (const dup of bucket.slice(1)) {
        candidateTemplates.push({ id: dup.id, name: dup.name });
      }
    }

    for (const key of unclaimedKeys) {
      for (const row of templatesByName.get(key) ?? []) {
        candidateTemplates.push({ id: row.id, name: row.name });
      }
    }

    // ── Deletes + audit, in one transaction ────────────────────────────────
    const ops: Prisma.PrismaPromise<unknown>[] = [];
    let templateDeleteAt = -1;

    if (prune) {
      if (candidateTemplates.length > 0) {
        templateDeleteAt = ops.length;
        ops.push(
          prisma.ticketTypeTemplate.deleteMany({
            // `isPlatform: true` pinned again at the delete: an owner's fork
            // sharing this packId is not this seed's to remove.
            where: {
              id: { in: candidateTemplates.map((t) => t.id) },
              isPlatform: true,
            },
          }),
        );
        ops.push(
          prisma.auditLog.create({
            data: {
              entity: "ticket_pack",
              entityId: packId,
              action: "ticket_pack.seed_pruned",
              data: {
                actor: "seed:ticket-packs",
                key: pack.key,
                removedNames: candidateTemplates.map((t) => t.name),
              },
            },
          }),
        );
      }
    } else {
      summary.withheldTemplateDeletes += candidateTemplates.length;
    }

    if (packCreated || createdTemplateNames.length > 0) {
      ops.push(
        prisma.auditLog.create({
          data: {
            entity: "ticket_pack",
            entityId: packId,
            action: "ticket_pack.seed_installed",
            data: {
              actor: "seed:ticket-packs",
              key: pack.key,
              packCreated,
              createdTemplates: createdTemplateNames,
            },
          },
        }),
      );
    }

    if (packRefreshed || updatedTemplateNames.length > 0) {
      ops.push(
        prisma.auditLog.create({
          data: {
            entity: "ticket_pack",
            entityId: packId,
            action: "ticket_pack.seed_refreshed",
            data: {
              actor: "seed:ticket-packs",
              key: pack.key,
              packMetadata: packRefreshed,
              updatedTemplates: updatedTemplateNames,
            },
          },
        }),
      );
    }

    if (ops.length > 0) {
      const results = await prisma.$transaction(ops);
      if (templateDeleteAt >= 0) {
        summary.removedTemplates += (
          results[templateDeleteAt] as { count: number }
        ).count;
      }
    }
  }

  const changes = [
    summary.createdPacks > 0 ? `+${summary.createdPacks} pack(s)` : null,
    summary.createdTemplates > 0
      ? `+${summary.createdTemplates} template(s)`
      : null,
    summary.updatedPacks > 0 ? `~${summary.updatedPacks} pack(s)` : null,
    summary.updatedTemplates > 0
      ? `~${summary.updatedTemplates} template(s)`
      : null,
    summary.removedTemplates > 0
      ? `-${summary.removedTemplates} template(s)`
      : null,
  ].filter(Boolean);

  console.log(
    `  ${summary.packCount} ticket packs, ${summary.templateCount} catalogue templates — ` +
      (changes.length > 0 ? `changes: ${changes.join(", ")}` : "no changes"),
  );

  if (summary.withheldTemplateDeletes > 0) {
    // Loud, not silent: the operator should know the DB holds catalogue rows
    // this file no longer names, and that removing them is a staff action.
    console.log(
      `  NOTE: ${summary.withheldTemplateDeletes} template(s) in the database ` +
        `are not named by the git baseline and were LEFT IN PLACE ` +
        `(pruning is off by default — pass --prune to remove them).`,
    );
  }

  return { ...summary, refresh, prune };
}
