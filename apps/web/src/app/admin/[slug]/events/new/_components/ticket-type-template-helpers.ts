import type { TicketTypeTemplateEntry } from "@th/types";

/** Owner pair as the ticketTypeTemplates router expects it. */
export type TemplateOwnerRef = {
  ownerScope: "HUMAN" | "ORGANIZATION";
  ownerId: string;
};

/**
 * The builder's `ownerType`/`ownerId` (the EVENT's owner, set by
 * `EventAdminPageShell`) as the template API's `{ownerScope, ownerId}` pair.
 */
export function toTemplateOwnerRef(
  ownerType: "human" | "org",
  ownerId: string,
): TemplateOwnerRef {
  return ownerType === "org"
    ? { ownerScope: "ORGANIZATION", ownerId }
    : { ownerScope: "HUMAN", ownerId };
}

/**
 * Structural subset of a `listTicketTypesForEdit` row that a ticket-type
 * template captures. Event-specific fields (`id`, `status`, `seatSectionId`,
 * `layoutSectionId`) are deliberately absent — templates must stay portable
 * across events, so seating assignments never travel with them (the backend
 * entry schema is `.strict()` and would reject extras anyway).
 */
export type TicketTypeForTemplate = {
  name: string;
  priceCents: number;
  pricingMode: "FIXED" | "ADJUSTABLE";
  minimumCents: number | null;
  suggestedCents: number | null;
  capacity: number;
  resaleAllowed: boolean;
  resaleCapCents: number | null;
  transferAllowed: boolean;
  /**
   * Read ONLY to answer "does this tier have time-based configuration that the
   * template will not carry?" ({@link hasTimeBasedConfig}). Never mapped into a
   * template entry — see the round-trip decision on
   * {@link toTicketTypeTemplateEntries}. Optional because the projection gained
   * them recently and a caller without them must degrade to "no note", not
   * crash.
   */
  salesOpenAt?: Date | string | null;
  salesCloseAt?: Date | string | null;
  scheduledPriceAt?: Date | string | null;
};

/**
 * Maps the event's current ticket types (as returned by
 * `events.listTicketTypesForEdit`) into `TicketTypeTemplateEntry[]` for
 * `ticketTypeTemplates.createTicketTypeTemplate`.
 *
 * - Picks ONLY the template fields (the entry schema is `.strict()`, so
 *   passing `id`/`status`/`seatSectionId`/`layoutSectionId` through would be
 *   a server-side validation error).
 * - Trims names and drops entries whose trimmed name is empty (the schema
 *   requires non-empty plain text).
 * - Dedupes names case-insensitively, keeping the FIRST occurrence — the
 *   backend rejects case-insensitive duplicates outright, and the event's own
 *   list is the source of truth for ordering.
 *
 * ── THE ROUND-TRIP DECISION (time-based-ticket-pricing FR-011) ──────────────
 * A template entry can now carry a RELATIVE `salesOpen` / `salesClose` /
 * `scheduledPriceChange` (`{ anchor, offsetMinutes }`). Save-as-Template
 * DELIBERATELY DOES NOT INFER ONE from the ticket type's absolute instants, and
 * this is a decision with reasons, not an unfinished edge:
 *
 *  1. THE ANCHOR IS UNRECOVERABLE, and it is the half that decides what the
 *     template MEANS on its next use. "On sale when I announced it"
 *     (EVENT_PUBLISH) and "on sale three days before the show" (EVENT_START)
 *     produce the SAME stored `salesOpenAt`. Nothing in the row distinguishes
 *     them, so an inference must pick one; picking EVENT_START silently
 *     converts every announce-time on-sale into a fixed countdown to doors on
 *     every future event the template touches. No amount of disclosure repairs
 *     a reuse semantics chosen by coin flip.
 *
 *  2. THE OFFSET WOULD BE NOISE. A Tuesday-17:00 cutoff on a Saturday-20:00
 *     show infers as −5820 minutes. Nobody chose "4 days 3 hours before"; it
 *     is an artefact of one calendar, and it reads back as exactly that
 *     nonsense on the next event.
 *
 *  3. DECLINING IS SAFE BY CONSTRUCTION. The applied tier simply has no window
 *     — today's behaviour, never unsellable. A wrong inference produces a tier
 *     that stops selling at a moment nobody chose, which is precisely the
 *     "silently unsellable type" that FR-016 spends an entire warning path
 *     avoiding. The asymmetry of harm is not close.
 *
 * NOT SILENT, though: {@link hasTimeBasedConfig} lets the save dialog tell the
 * organizer, before they save, that these settings stay with the event.
 *
 * KNOWN GAP, stated because the decision above makes it load-bearing: owned
 * templates are created ONLY here and have no editor, so an organizer cannot
 * add a relative window to their own template by any route today. Relative
 * windows currently reach organizers through the PLATFORM catalogue (authored
 * in /platform/ticket-packs, which does have an entry editor) and through
 * presets. Giving owned templates an editor is the right fix and is its own
 * piece of work; inferring offsets from one event's calendar is not.
 */
export function toTicketTypeTemplateEntries(
  ticketTypes: readonly TicketTypeForTemplate[],
): TicketTypeTemplateEntry[] {
  const seen = new Set<string>();
  const entries: TicketTypeTemplateEntry[] = [];

  for (const tt of ticketTypes) {
    const name = tt.name.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    entries.push({
      name,
      priceCents: tt.priceCents,
      pricingMode: tt.pricingMode,
      minimumCents: tt.minimumCents,
      suggestedCents: tt.suggestedCents,
      capacity: tt.capacity,
      resaleAllowed: tt.resaleAllowed,
      resaleCapCents: tt.resaleCapCents,
      transferAllowed: tt.transferAllowed,
    });
  }

  return entries;
}

/**
 * Does any tier being captured carry time-based configuration that the template
 * will NOT take with it?
 *
 * Drives the save dialog's one-line note. The whole point of the note is that
 * {@link toTicketTypeTemplateEntries}' refusal to infer a relative offset is a
 * DISCLOSED decision rather than a silent drop — an organizer who set an
 * on-sale time and then saved a template is entitled to know it stayed behind.
 *
 * Every check is `!= null` and never falsy: these are instants, and the epoch is
 * a legitimate (if strange) one.
 */
export function hasTimeBasedConfig(
  ticketTypes: readonly TicketTypeForTemplate[],
): boolean {
  return ticketTypes.some(
    (tt) =>
      tt.salesOpenAt != null ||
      tt.salesCloseAt != null ||
      tt.scheduledPriceAt != null,
  );
}

/**
 * One-line preview of a template's entries for the picker list:
 * `"GA (Free), VIP ($60)"`. Pure so the truncation-free content is testable;
 * the row applies its own CSS ellipsis.
 */
export function buildTemplateEntryPreview(
  entries: readonly Pick<TicketTypeTemplateEntry, "name" | "priceCents">[],
  formatPrice: (cents: number) => string,
): string {
  return entries
    .map((entry) => `${entry.name} (${formatPrice(entry.priceCents)})`)
    .join(", ");
}

/**
 * Localized copy hooks for {@link buildCatalogueEntryPreview}. The dialog
 * resolves these through `t()`; the helper stays pure and testable.
 */
export type CatalogueEntryPreviewLabels = {
  /** e.g. `"pay what you can · {suggested} suggested"`. */
  adjustable: (suggested: string) => string;
  /** e.g. `"cap {capacity}"`. */
  capacity: (capacity: number) => string;
};

/**
 * Richer per-entry preview for the catalogue section (ticket-type-packs spec
 * FR-011): face price, capacity and pricing mode. One line per
 * entry — platform templates are small by curation, and the section gives
 * each entry its own row rather than the owned rows' single ellipsized line.
 */
export function buildCatalogueEntryPreview(
  entry: Pick<
    TicketTypeTemplateEntry,
    | "name"
    | "priceCents"
    | "pricingMode"
    | "suggestedCents"
    | "capacity"
  >,
  formatPrice: (cents: number) => string,
  labels: CatalogueEntryPreviewLabels,
): string {
  const price =
    entry.pricingMode === "ADJUSTABLE"
      ? labels.adjustable(formatPrice(entry.suggestedCents ?? 0))
      : formatPrice(entry.priceCents);
  return `${entry.name} — ${price} · ${labels.capacity(entry.capacity)}`;
}
