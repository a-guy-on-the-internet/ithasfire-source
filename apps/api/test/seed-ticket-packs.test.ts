import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  LAUNCH_TICKET_PACKS,
  encodeTicketPackTemplates,
  stableStringify,
  templateContentDiffers,
  type EncodedTemplate,
  type ExistingTemplate,
} from "../src/scripts/seed/ticket-packs";

/**
 * Pins the launch ticket-type catalogue (ticket-type-packs spec FR-013 +
 * NFR-003), the way seed-platform-waivers.test.ts pins the waiver seeds:
 * the content ships on every deploy dispatch, so drift here is drift in
 * what every organizer sees.
 */

const MIGRATION_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/prisma/migrations/20260804140000_ticket_type_packs/migration.sql",
);

describe("launch ticket packs (FR-013)", () => {
  it("ships exactly the four launch packs, in curation order", () => {
    expect(LAUNCH_TICKET_PACKS.map((p) => [p.key, p.sortOrder])).toEqual([
      ["general-admission", 0],
      ["advance-plus-door", 1],
      ["early-bird-tiers", 2],
      ["pay-what-you-can", 3],
    ]);
  });

  it("every pack encodes through the staff editor's zod schema", () => {
    for (const pack of LAUNCH_TICKET_PACKS) {
      // Throws on any content the staff editor could not round-trip.
      expect(() => encodeTicketPackTemplates(pack)).not.toThrow();
    }
  });

  it("general-admission: one FIXED GA type, 2000¢, cap 100", () => {
    const [tpl] = encodeTicketPackTemplates(LAUNCH_TICKET_PACKS[0]!);
    expect(tpl!.ticketTypes).toEqual([
      expect.objectContaining({
        name: "General admission",
        priceCents: 2000,
        pricingMode: "FIXED",
        capacity: 100,
        doorPriceCents: null,
      }),
    ]);
  });

  it("advance-plus-door: ONE type, 1500¢ advance, 2000¢ door, one capacity pool (FR-004)", () => {
    const [tpl] = encodeTicketPackTemplates(LAUNCH_TICKET_PACKS[1]!);
    expect(tpl!.ticketTypes).toHaveLength(1);
    expect(tpl!.ticketTypes[0]).toMatchObject({
      pricingMode: "FIXED",
      priceCents: 1500,
      doorPriceCents: 2000,
      capacity: 100,
    });
  });

  it("early-bird-tiers: three capacity-limited tiers, ascending prices", () => {
    const [tpl] = encodeTicketPackTemplates(LAUNCH_TICKET_PACKS[2]!);
    expect(
      tpl!.ticketTypes.map((t) => [t.name, t.priceCents, t.capacity]),
    ).toEqual([
      ["Early bird", 1200, 30],
      ["Advance", 1800, 60],
      ["Day of show", 2200, 30],
    ]);
  });

  it("early-bird blurb promises capacity tiering only — no time-based flips (Phase B)", () => {
    const blurb = LAUNCH_TICKET_PACKS[2]!.blurb.toLowerCase();
    // Nothing that reads as a schedule promise.
    for (const forbidden of ["closes", "deadline", "date", "friday", "until"]) {
      expect(blurb).not.toContain(forbidden);
    }
    expect(blurb).toContain("sells out");
  });

  it("pay-what-you-can: ADJUSTABLE, minimum 0, suggested 1000, cap 60", () => {
    const [tpl] = encodeTicketPackTemplates(LAUNCH_TICKET_PACKS[3]!);
    expect(tpl!.ticketTypes).toEqual([
      expect.objectContaining({
        pricingMode: "ADJUSTABLE",
        minimumCents: 0,
        suggestedCents: 1000,
        capacity: 60,
      }),
    ]);
  });

  it("all entries: integer cents, resale OFF (platform gate), transfers ON (NFR-003 / FR-013)", () => {
    for (const pack of LAUNCH_TICKET_PACKS) {
      for (const tpl of encodeTicketPackTemplates(pack)) {
        for (const entry of tpl.ticketTypes) {
          expect(Number.isInteger(entry.priceCents)).toBe(true);
          if (entry.minimumCents !== null) {
            expect(Number.isInteger(entry.minimumCents)).toBe(true);
          }
          if (entry.suggestedCents !== null) {
            expect(Number.isInteger(entry.suggestedCents)).toBe(true);
          }
          if (entry.doorPriceCents !== null) {
            expect(Number.isInteger(entry.doorPriceCents)).toBe(true);
          }
          expect(entry.resaleAllowed).toBe(false);
          expect(entry.resaleCapCents).toBeNull();
          expect(entry.transferAllowed).toBe(true);
        }
      }
    }
  });

  it("no two templates share a name within one pack (the partial-index invariant)", () => {
    for (const pack of LAUNCH_TICKET_PACKS) {
      const names = encodeTicketPackTemplates(pack).map((t) =>
        t.name.trim().toLowerCase(),
      );
      expect(new Set(names).size).toBe(names.length);
    }
  });
});

describe("refresh-mode convergence (templateContentDiffers)", () => {
  /**
   * Postgres jsonb does NOT preserve key order (keys come back sorted
   * length-then-bytewise), so a row that round-trips through the database
   * carries the same content under a DIFFERENT key order. The compare must
   * canonicalize, or a converged `seed:ticket-packs:refresh` rewrites every
   * template — and emits ticket_pack.seed_refreshed audit rows — on every
   * single run.
   */
  const jsonbOrder = (entry: Record<string, unknown>) => {
    // Emulate jsonb's key ordering: by key length, then bytewise — which is
    // NOT the insertion order the seed writes.
    const sorted = Object.keys(entry).sort(
      (a, b) => a.length - b.length || (a < b ? -1 : 1),
    );
    return Object.fromEntries(sorted.map((k) => [k, entry[k]]));
  };

  const desired: EncodedTemplate = encodeTicketPackTemplates(
    LAUNCH_TICKET_PACKS[1]!,
  )[0]!;

  const roundTripped: ExistingTemplate = {
    id: "row-1",
    name: desired.name,
    ticketTypes: desired.ticketTypes.map((e) =>
      jsonbOrder(e as unknown as Record<string, unknown>),
    ) as never,
    archivedAt: null,
  };

  it("same content under jsonb key order is NOT different (converged refresh writes nothing)", () => {
    expect(
      stableStringify(roundTripped.ticketTypes) ===
        stableStringify(desired.ticketTypes),
    ).toBe(true);
    expect(templateContentDiffers(roundTripped, desired)).toBe(false);
  });

  it("a real content change IS different", () => {
    const edited: ExistingTemplate = {
      ...roundTripped,
      ticketTypes: (
        roundTripped.ticketTypes as Array<Record<string, unknown>>
      ).map((e) => ({ ...e, priceCents: 999 })) as never,
    };
    expect(templateContentDiffers(edited, desired)).toBe(true);
  });

  it("a hand-archived row reads as different so refresh un-archives it", () => {
    expect(
      templateContentDiffers(
        { ...roundTripped, archivedAt: new Date() },
        desired,
      ),
    ).toBe(true);
  });
});

describe("ticket_type_packs migration", () => {
  const sql = readFileSync(MIGRATION_PATH, "utf8");

  it("enforces per-pack platform template names via a partial unique index", () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "TicketTypeTemplate_platform_pack_name_key" ON "TicketTypeTemplate"\("packId", "name"\) WHERE "ownerId" IS NULL/,
    );
  });

  it("CHECK-enforces that platform rows always carry a pack", () => {
    expect(sql).toMatch(
      /ADD CONSTRAINT "TicketTypeTemplate_platform_pack_check" CHECK \(\s*"isPlatform" = false OR "packId" IS NOT NULL\s*\)/,
    );
  });

  it("keeps the fork-safe FK: packId SET NULL, never cascade", () => {
    expect(sql).toContain(
      'FOREIGN KEY ("packId") REFERENCES "TicketPack"("id") ON DELETE SET NULL',
    );
  });
});
