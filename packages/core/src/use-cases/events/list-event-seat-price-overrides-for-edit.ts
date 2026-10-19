import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type {
  ReadSeatPriceOverride,
  SeatSectionSummary,
} from "@th/ports/repos/seats";
import type { ReporterPort } from "@th/ports/reporter";
import type { EventTicketTypeSummary } from "@th/types";

import { AppError, fail } from "@th/errors";
import { parseInput } from "../../lib/io";
import { resolveUnitPriceCents } from "../../lib/orders/door-pricing";
import { seatOverrideCents } from "../../lib/orders/seat-pricing";
import {
  resolveUpcomingPriceChange,
  upcomingPriceChangeSchema,
} from "../../lib/orders/ticket-type-sellability";
import { glyphIdsByLabel } from "../../lib/seating/layout-seat-id";
import {
  ensureActorCanEditSeatPriceOverrides,
  paidOverrideGates,
  probePaidOverrideGates,
  seatPriceOverrideRefusal,
  seatPriceOverridesEditable,
  tiersForSections,
} from "./_shared/seat-price-override-rules";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const listEventSeatPriceOverridesForEditInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    eventId: z.uuid(),
  })
  .strict();

const tierSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    pricingMode: z.enum(["FIXED", "ADJUSTABLE"]),
    status: z.enum(["DRAFT", "ACTIVE"]),
    /**
     * What a seat of this tier without an override costs right now
     * (`resolveUnitPriceCents`, schedule applied). `null` for an ADJUSTABLE
     * tier: its buyer names the price.
     */
    currentPriceCents: z.number().int().nullable(),
    /** The tier's next scheduled price flip, if one is still ahead. */
    upcomingPriceChange: upcomingPriceChangeSchema.nullable(),
  })
  .strict();

const seatSchema = z
  .object({
    id: z.uuid(),
    label: z.string(),
    row: z.string().nullable(),
    number: z.number().int().nullable(),
    status: z.enum(["AVAILABLE", "HELD", "SOLD", "BLOCKED"]),
    /**
     * The id of the layout glyph this seat was materialised from, or `null`
     * when no glyph of the section's layout maps to it (manually created
     * section or seat, layout edited since, layout unreadable). Unique within
     * a section; look a glyph up in the section whose `layoutSectionId` is the
     * glyph's own `sectionId`.
     */
    glyphKey: z.string().nullable(),
    /** The stored override, with the organizer's private `reason`. */
    priceOverride: z
      .object({
        priceCents: z.number().int().nonnegative(),
        reason: z.string().nullable(),
      })
      .strict()
      .nullable(),
    /**
     * A stored override that checkout refuses (not `{ priceCents: number }`,
     * or a negative / fractional amount). Shown as `priceOverride: null`; the
     * seat cannot be sold until the override is cleared or set again.
     */
    overrideInvalid: z.boolean(),
  })
  .strict();

const sectionSchema = z
  .object({
    seatSectionId: z.uuid(),
    name: z.string(),
    type: z.enum(["GA", "RESERVED"]),
    layoutSectionId: z.string().nullable(),
    placeLayoutId: z.string().nullable(),
    /**
     * The tiers an override on this section's seats replaces, by the write's
     * own rule: on a DRAFT event every tier, otherwise ACTIVE tiers only.
     */
    tiers: z.array(tierSchema),
    /**
     * Why `setSeatPriceOverrides` refuses to SET a price here (clearing is
     * always allowed), from the same predicate the write runs; `null` when
     * a price may be set.
     */
    overrideRefusal: z.enum(["ADJUSTABLE_TIER", "NO_FIXED_TIER"]).nullable(),
    /**
     * Why `setSeatPriceOverrides` would refuse a PAID (> 0) price here right
     * now, though $0 is allowed: a FREE tier sells the section, and a paid
     * seat on it is the free→paid flip, gated like the tier editor's.
     * `STRIPE` (`PAID_TICKETING_REQUIRES_STRIPE`: no linked Connect account)
     * wins over `FEE_POLICY` (`PAID_TICKETING_REQUIRES_FEE_POLICY`), the
     * write's order. Same predicates and gate functions as the write.
     * `null` when nothing blocks a paid price, and whenever
     * `overrideRefusal` is set (that refusal comes first).
     */
    paidOverrideBlockedBy: z.enum(["STRIPE", "FEE_POLICY"]).nullable(),
    /**
     * FR-008 / D-003: a FIXED tier of this section has a scheduled price flip
     * still ahead. Overridden seats keep their override through it; the
     * editor must say so.
     */
    hasPendingScheduledPriceChange: z.boolean(),
    seats: z.array(seatSchema),
  })
  .strict();

export const listEventSeatPriceOverridesForEditOutputSchema = z
  .object({
    eventId: z.uuid(),
    /**
     * `false` once the event is cancelled, completed or archived: the write
     * refuses every edit (`EVENT_NOT_EDITABLE`).
     */
    editable: z.boolean(),
    sections: z.array(sectionSchema),
  })
  .strict();

export type ListEventSeatPriceOverridesForEditInput = z.infer<
  typeof listEventSeatPriceOverridesForEditInputSchema
>;
export type ListEventSeatPriceOverridesForEditOutput = z.infer<
  typeof listEventSeatPriceOverridesForEditOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type ListEventSeatPriceOverridesForEditDeps = {
  /**
   * Full `Repos`, like the write's: the paid-seat gates it shares with the
   * write take a `TxRepos` (they read `payees` and `feePolicies`).
   */
  repos: Repos;
  /**
   * The instant tier prices, pending schedule flips and the fee-policy gate
   * are judged at.
   */
  clock: ClockPort;
  /**
   * Called (once per read) when stored overrides are corrupt, and when a
   * section's layout cannot be read so its glyph keys fall back to `null`.
   * Both are swallowed so one bad row cannot blank the editor. Also passed to
   * the fee-policy scope walk, which reports what it fails on (and throws).
   */
  reportError?: ReporterPort;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/** Corrupt seat ids named in one report; the count carries the rest. */
const MAX_REPORTED_SEAT_IDS = 20;

/**
 * The organizer's seat price override editor read (spec
 * docs/specs/2026-08-12/seat-price-overrides.spec.yaml FR-006, FR-008).
 *
 * Every section of the event with its seats, each seat's stored override
 * (WITH its private `reason`, which the public `listEventSeatAvailability`
 * strips), the tiers the override replaces, whether the write would refuse a
 * price on the section, and whether a tier's scheduled flip is still ahead.
 *
 * AUTHZ is the write's own gate (`ensureActorCanEditSeatPriceOverrides`),
 * after the same `EVENT_NOT_FOUND` check, so this read tells a caller nothing
 * about an event the write would not. Any event status: a DRAFT is edited
 * before it is on sale, and a closed event is shown read-only (`editable`).
 *
 * Reads: the event, its sections, its seats and its tiers (one query each),
 * plus one layout read per distinct `placeLayoutId` (usually one), plus the
 * paid-seat gates' payee and fee-policy reads, once per event and only when a
 * section has a free tier. No per-seat or per-section queries.
 *
 * A payee or fee-policy read that FAILS throws, deliberately: it is never
 * turned into a STRIPE / FEE_POLICY block, which would send the organizer to
 * fix a setup that is fine, and the thrown error reaches the transport's
 * Sentry backstop. A layout read that fails, by contrast, only costs glyph
 * keys, so it degrades (reported, `glyphKey: null`).
 */
export async function listEventSeatPriceOverridesForEdit(
  deps: ListEventSeatPriceOverridesForEditDeps,
  rawInput: unknown,
): Promise<ListEventSeatPriceOverridesForEditOutput> {
  const logger = deps.logger?.child({
    useCase: "listEventSeatPriceOverridesForEdit",
  });

  const execute = async (): Promise<ListEventSeatPriceOverridesForEditOutput> => {
    const input = parseInput(
      listEventSeatPriceOverridesForEditInputSchema,
      rawInput,
    );

    const event = await deps.repos.events.getById(input.eventId);
    if (!event) {
      throw fail("EVENT_NOT_FOUND");
    }

    await ensureActorCanEditSeatPriceOverrides(
      deps.repos,
      event,
      input.actorHumanId,
    );

    const [sections, seats, ticketTypes] = await Promise.all([
      deps.repos.seats.listSectionsByEvent(event.id),
      deps.repos.seats.listPriceOverridesByEvent({ eventId: event.id }),
      deps.repos.events.listTicketTypes(event.id),
    ]);

    const now = deps.clock.now();
    const glyphMaps = await loadGlyphMaps(deps, event.id, sections);
    const tiersBySection = tiersForSections(
      event,
      ticketTypes,
      sections.map((section) => section.id),
    );

    // Paid-seat gates (WRITE RULES 4), judged only where the section rule
    // lets a price through, as in the write.
    const gatesBySection = new Map(
      sections.flatMap((section) => {
        const tiers = tiersBySection.get(section.id) ?? [];
        return seatPriceOverrideRefusal(tiers) === null
          ? [[section.id, paidOverrideGates(tiers)] as const]
          : [];
      }),
    );
    const neededGates = {
      stripe: [...gatesBySection.values()].some((g) => g.stripe),
      feePolicy: [...gatesBySection.values()].some((g) => g.feePolicy),
    };
    const paidBlockFor = await probePaidOverrideGates(
      deps.repos,
      event,
      neededGates,
      now,
      {
        logger,
        reportError: deps.reportError,
        source: "listEventSeatPriceOverridesForEdit",
      },
    );

    const seatsBySection = new Map<string, typeof seats>();
    for (const seat of seats) {
      const list = seatsBySection.get(seat.seatSectionId) ?? [];
      list.push(seat);
      seatsBySection.set(seat.seatSectionId, list);
    }

    const invalidSeatIds: string[] = [];
    const output = {
      eventId: event.id,
      editable: seatPriceOverridesEditable(event),
      sections: sections.map((section) => {
        const tiers = tiersBySection.get(section.id) ?? [];
        const glyphIds = glyphMaps.get(section.id);
        const gates = gatesBySection.get(section.id);
        return {
          seatSectionId: section.id,
          name: section.name,
          type: section.type,
          layoutSectionId: section.layoutSectionId,
          placeLayoutId: section.placeLayoutId,
          tiers: tiers.map((tier) => toTier(tier, now)),
          overrideRefusal: seatPriceOverrideRefusal(tiers),
          paidOverrideBlockedBy: gates ? paidBlockFor(gates) : null,
          hasPendingScheduledPriceChange: tiers.some(
            (tier) =>
              tier.pricingMode === "FIXED" &&
              resolveUpcomingPriceChange(tier, now) !== null,
          ),
          seats: (seatsBySection.get(section.id) ?? []).map((seat) => {
            const override = toEditorOverride(seat.id, seat.priceOverride);
            if (override.invalid) invalidSeatIds.push(seat.id);
            return {
              id: seat.id,
              label: seat.label,
              row: seat.row,
              number: seat.number,
              status: seat.status,
              glyphKey: glyphIds?.get(seat.label) ?? null,
              priceOverride: override.value,
              overrideInvalid: override.invalid,
            };
          }),
        };
      }),
    };

    if (invalidSeatIds.length > 0) {
      report(
        deps,
        new AppError("INTERNAL", {
          message: "seat_price_override_invalid",
          meta: { eventId: event.id },
        }),
        {
          eventId: event.id,
          invalidCount: invalidSeatIds.length,
          seatIds: invalidSeatIds.slice(0, MAX_REPORTED_SEAT_IDS),
        },
      );
    }

    return listEventSeatPriceOverridesForEditOutputSchema.parse(output);
  };

  if (logger) {
    return logger.withTime("listEventSeatPriceOverridesForEdit", execute);
  }

  return execute();
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function toTier(tier: EventTicketTypeSummary, now: Date) {
  return {
    id: tier.id,
    name: tier.name,
    pricingMode: tier.pricingMode,
    status: tier.status,
    currentPriceCents:
      tier.pricingMode === "FIXED" ? resolveUnitPriceCents(tier, { now }) : null,
    upcomingPriceChange: resolveUpcomingPriceChange(tier, now),
  };
}

/**
 * The stored override as the editor shows it. Validity is `seatOverrideCents`
 * (the check checkout runs), so the editor flags exactly the seats checkout
 * would refuse.
 */
function toEditorOverride(
  seatId: string,
  stored: ReadSeatPriceOverride,
):
  | { value: { priceCents: number; reason: string | null } | null; invalid: false }
  | { value: null; invalid: true } {
  if (stored == null) return { value: null, invalid: false };
  let cents: number | null;
  try {
    cents = seatOverrideCents(stored, seatId);
  } catch {
    // Reported once for the whole read, by the caller.
    return { value: null, invalid: true };
  }
  // Unreachable at runtime (a non-null stored value either throws above or
  // yields cents), kept so TypeScript narrows `stored` to the override shape.
  if (cents === null || "invalid" in stored) {
    return { value: null, invalid: false };
  }
  return {
    value: { priceCents: cents, reason: stored.reason ?? null },
    invalid: false,
  };
}

/**
 * Per section id, the glyph id of each materialised seat label (see
 * `glyphIdsByLabel`). Sections without a layout are absent. A layout that is
 * gone leaves its sections absent; one that cannot be read is reported and
 * leaves them absent too, so the editor still opens with `glyphKey: null`.
 */
async function loadGlyphMaps(
  deps: ListEventSeatPriceOverridesForEditDeps,
  eventId: string,
  sections: readonly SeatSectionSummary[],
): Promise<Map<string, Map<string, string>>> {
  const layoutIds = [
    ...new Set(
      sections
        .filter((section) => section.layoutSectionId && section.placeLayoutId)
        .map((section) => section.placeLayoutId as string),
    ),
  ];
  const layouts = await Promise.all(
    layoutIds.map(async (layoutId) => {
      try {
        return [layoutId, await deps.repos.placeLayouts.getById(layoutId)] as const;
      } catch (err) {
        report(deps, err, { eventId, placeLayoutId: layoutId });
        return [layoutId, null] as const;
      }
    }),
  );
  const seatIdsByLayout = new Map(
    layouts.flatMap(([id, layout]) => (layout ? [[id, layout.seatIds]] : [])),
  );

  const maps = new Map<string, Map<string, string>>();
  for (const section of sections) {
    if (!section.layoutSectionId || !section.placeLayoutId) continue;
    const layoutSeatIds = seatIdsByLayout.get(section.placeLayoutId);
    if (!layoutSeatIds) continue;
    maps.set(
      section.id,
      glyphIdsByLabel(section.layoutSectionId, layoutSeatIds),
    );
  }
  return maps;
}

/** Best-effort: a throwing reporter never changes what this read returns. */
function report(
  deps: ListEventSeatPriceOverridesForEditDeps,
  err: unknown,
  extra: Record<string, unknown>,
): void {
  try {
    deps.reportError?.(err, {
      tags: { useCase: "listEventSeatPriceOverridesForEdit" },
      extra,
    });
  } catch {
    // Reporting is best-effort (ReporterPort contract).
  }
}
