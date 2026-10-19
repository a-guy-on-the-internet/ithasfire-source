/**
 * "Start from" presets for the ticket-type ADD form.
 *
 * A preset PRE-FILLS the add form — it never creates a ticket type. Nothing is
 * written until the organiser presses Add, so a wrong pick costs nothing and
 * every value stays editable.
 *
 * Why the names live as i18n KEYS and the numbers live as constants:
 * the chosen name is what gets SAVED as the ticket type's name, so a Spanish
 * organiser must get the Spanish name ("Entrada general", not "General
 * Admission"). Prices/capacities are not locale-dependent, so they stay plain
 * constants here and are resolved once, at render time, by `applyPresetToForm`
 * calling back into the caller's `t()`.
 *
 * Dollar STRINGS, not cents: the add form holds price/capacity/minimum/
 * suggested as raw dollar strings and converts them in `handleAdd` via
 * `parseMoneyInputToCents`. Presets therefore speak the same dialect
 * ("15.00", "100") so a preset value is indistinguishable from something the
 * organiser typed. They stay in the unambiguous en form on purpose: the reader
 * accepts `,` as a decimal separator too, but a catalog constant has no reason
 * to lean on that.
 *
 * Resale is deliberately ABSENT from this module. It is feature-gated and a
 * per-ticket judgement call; a preset must never smuggle it on. Seat sections
 * are absent for the same reason (they're event-specific, not portable).
 */

import type { TicketTypeTemplateRelativeInstant } from "@th/types";

import { parseMoneyInputToCents } from "@/lib/money/parse-money-input";

export type TicketTypePricingMode = "FIXED" | "ADJUSTABLE";

export type TicketTypePresetId =
  | "custom"
  | "ga"
  | "advance"
  | "door"
  | "vip"
  | "student"
  | "pwyw"
  | "sliding"
  | "industry";

/** The leading "Custom (blank)" entry — the default selection. */
export const TICKET_TYPE_PRESET_CUSTOM_ID = "custom" satisfies TicketTypePresetId;

export type TicketTypePreset = {
  readonly id: TicketTypePresetId;
  /**
   * i18n key (`admin.*`) for the preset's display name. Resolved at render
   * time so the SAVED ticket-type name follows the organiser's locale.
   */
  readonly nameKey: string;
  readonly pricingMode: TicketTypePricingMode;
  /** Dollar string. Empty for ADJUSTABLE presets (the form hides Price there). */
  readonly priceDollars: string;
  /** Integer-as-string. Empty only for the custom (blank) entry. */
  readonly capacity: string;
  /** Dollar string; only meaningful when `pricingMode` is ADJUSTABLE. */
  readonly minimumDollars: string;
  /** Dollar string; only meaningful when `pricingMode` is ADJUSTABLE. */
  readonly suggestedDollars: string;
  /**
   * RELATIVE sales window (time-based-ticket-pricing FR-012, encoding per
   * ticket-type-packs FR-015) — `{ anchor, offsetMinutes }`, signed, negative =
   * before. NEVER an absolute instant: a catalog constant cannot name a date.
   *
   * Materialized against the event's own `startsAt` when the preset is picked,
   * through the SAME `@th/core` resolver `applyTicketTypeTemplate` uses, so a
   * preset and a template that encode the same intent cannot resolve to
   * different instants.
   *
   * Q-003 (RESOLVED) removes the sequencing worry that made this look hard:
   * `TicketTypeEditor` only renders with an `eventId`, so the event — and
   * therefore its start date and timezone — is always persisted by the time a
   * preset can be picked. No gating is needed.
   */
  readonly salesOpen: TicketTypeTemplateRelativeInstant | null;
  readonly salesClose: TicketTypeTemplateRelativeInstant | null;
  /**
   * RELATIVE scheduled price change (FR-011's shape) — a SHARED-POOL flip:
   * one row, one capacity pool, two prices either side of an instant.
   *
   * Null on all eight shipped presets, and that is a statement rather than an
   * omission: every entry in this catalog is a SEPARATE-POOL tier, where "the
   * price goes up" is expressed by a second row (Advance closes, Door opens —
   * see the pair below). The field exists because the resolution path is shared
   * with templates and a preset that wants a flip must not need a second
   * mechanism to get one; it is exercised by
   * `__tests__/ticket-type-preset-schedule.test.ts`.
   */
  readonly scheduledPriceChange: {
    readonly at: TicketTypeTemplateRelativeInstant;
    /** Dollar string, read by the same money parser as every other amount. */
    readonly priceDollars: string;
  } | null;
};

/**
 * Minutes from the show at which "advance" hands over to "at the door".
 *
 * ONE constant for BOTH presets, and that is the whole point. `salesCloseAt` is
 * EXCLUSIVE and `salesOpenAt` is INCLUSIVE (`resolveTicketTypeSaleState`), so
 * closing Advance and opening Door at the SAME instant leaves neither a gap
 * with nothing on sale nor an overlap with two tiers competing. Two constants
 * would drift apart on the first edit and nobody would notice until an
 * organizer's advance tier closed a day before the door tier opened.
 *
 * −1440 = 24 hours before doors, i.e. "day of show" pricing starts the day
 * before — FR-015's own worked example for a day-of opener.
 */
const DAY_OF_SHOW_OFFSET_MINUTES = -1440;

/**
 * The exact set of add-form fields a preset owns. Anything absent from this
 * shape (resale, seat section, transferability) is NOT a preset's business.
 */
export type TicketTypePresetFormValues = {
  name: string;
  priceDollars: string;
  capacity: string;
  pricingMode: TicketTypePricingMode;
  minimumDollars: string;
  suggestedDollars: string;
};

/**
 * The catalog. Ordered as it renders: "Custom (blank)" first (it is the
 * default and the way back to an empty form), then the presets roughly by how
 * often a grassroots organiser reaches for them.
 */
export const TICKET_TYPE_PRESETS: readonly TicketTypePreset[] = [
  {
    id: "custom",
    nameKey: "admin.ttPresetCustom",
    pricingMode: "FIXED",
    priceDollars: "",
    capacity: "",
    minimumDollars: "",
    suggestedDollars: "",
    salesOpen: null,
    salesClose: null,
    scheduledPriceChange: null,
  },
  {
    id: "ga",
    nameKey: "admin.ttPresetGa",
    pricingMode: "FIXED",
    priceDollars: "15.00",
    capacity: "100",
    minimumDollars: "",
    suggestedDollars: "",
    salesOpen: null,
    salesClose: null,
    scheduledPriceChange: null,
  },
  {
    id: "advance",
    nameKey: "admin.ttPresetAdvance",
    pricingMode: "FIXED",
    priceDollars: "12.00",
    capacity: "50",
    minimumDollars: "",
    suggestedDollars: "",
    salesOpen: null,
    // FR-012: "Advance / Early Bird" finally means what it is named. It stops
    // selling when day-of pricing starts — until now the preset was a name and
    // a lower number, with nothing to make it stop being early.
    salesClose: {
      anchor: "EVENT_START",
      offsetMinutes: DAY_OF_SHOW_OFFSET_MINUTES,
    },
    scheduledPriceChange: null,
  },
  {
    id: "door",
    nameKey: "admin.ttPresetDoor",
    pricingMode: "FIXED",
    priceDollars: "20.00",
    capacity: "50",
    // The other half of the pair: opens at the exact instant Advance closes.
    // Half-open bounds make that seamless — see DAY_OF_SHOW_OFFSET_MINUTES.
    salesOpen: {
      anchor: "EVENT_START",
      offsetMinutes: DAY_OF_SHOW_OFFSET_MINUTES,
    },
    salesClose: null,
    minimumDollars: "",
    suggestedDollars: "",
    scheduledPriceChange: null,
  },
  {
    id: "vip",
    nameKey: "admin.ttPresetVip",
    pricingMode: "FIXED",
    priceDollars: "50.00",
    capacity: "20",
    minimumDollars: "",
    suggestedDollars: "",
    salesOpen: null,
    salesClose: null,
    scheduledPriceChange: null,
  },
  {
    id: "student",
    nameKey: "admin.ttPresetStudent",
    pricingMode: "FIXED",
    priceDollars: "10.00",
    capacity: "25",
    minimumDollars: "",
    suggestedDollars: "",
    salesOpen: null,
    salesClose: null,
    scheduledPriceChange: null,
  },
  {
    id: "pwyw",
    nameKey: "admin.ttPresetPwyw",
    pricingMode: "ADJUSTABLE",
    priceDollars: "",
    capacity: "100",
    minimumDollars: "0.00",
    suggestedDollars: "10.00",
    salesOpen: null,
    salesClose: null,
    scheduledPriceChange: null,
  },
  {
    id: "sliding",
    nameKey: "admin.ttPresetSliding",
    pricingMode: "ADJUSTABLE",
    priceDollars: "",
    capacity: "100",
    minimumDollars: "10.00",
    suggestedDollars: "20.00",
    salesOpen: null,
    salesClose: null,
    scheduledPriceChange: null,
  },
  {
    id: "industry",
    nameKey: "admin.ttPresetIndustry",
    pricingMode: "FIXED",
    priceDollars: "0.00",
    capacity: "10",
    minimumDollars: "",
    suggestedDollars: "",
    salesOpen: null,
    salesClose: null,
    scheduledPriceChange: null,
  },
] as const;

/** Look a preset up by id. Falls back to the custom (blank) entry. */
export function findTicketTypePreset(
  id: TicketTypePresetId | null | undefined,
): TicketTypePreset {
  return (
    TICKET_TYPE_PRESETS.find((preset) => preset.id === id) ??
    TICKET_TYPE_PRESETS[0]!
  );
}

/**
 * Dollar string → cents for the DROPDOWN META LINE only.
 *
 * Runs the SAME reader as the submit path (`parseMoneyInputToCents`), so the
 * meta line can never quote an amount `handleAdd` wouldn't send. The only
 * difference is what happens when the reader refuses: a meta line has to render
 * *something*, so it falls back to 0, whereas `handleAdd` shows an error toast
 * and refuses the submit.
 *
 * That fallback is safe HERE and only here — it is display of a constant from
 * the catalog below, never a number on its way to the database. Do not reuse it
 * on a submit path; coercing a typo to 0 is how you ship a silent $0 ticket.
 * `__tests__/ticket-type-presets.test.ts` pins both halves of that contract.
 */
export function presetDollarsToCents(dollars: string): number {
  const parsed = parseMoneyInputToCents(dollars);
  return parsed.ok ? parsed.cents : 0;
}

/**
 * The whole point of the module: map a preset to the add form's field values.
 *
 * Pure — `translate` is injected so the catalog stays a constant and the
 * caller (which has the `t()` from context) owns locale resolution.
 *
 * The custom entry resolves to an EMPTY name: its label ("Custom (blank)") is
 * a UI affordance, not a ticket-type name anyone would want saved.
 */
export function applyPresetToForm(
  preset: TicketTypePreset,
  translate: (key: string) => string,
): TicketTypePresetFormValues {
  const isCustom = preset.id === TICKET_TYPE_PRESET_CUSTOM_ID;
  return {
    name: isCustom ? "" : translate(preset.nameKey),
    priceDollars: preset.priceDollars,
    capacity: preset.capacity,
    pricingMode: preset.pricingMode,
    minimumDollars: preset.minimumDollars,
    suggestedDollars: preset.suggestedDollars,
  };
}

export type PresetMetaDeps = {
  /** Resolve an `admin.*` key, with optional ICU values. */
  translate: (key: string, values?: Record<string, string | number>) => string;
  /**
   * Currency for an EXACT amount. Never substitutes a "Free" word — a $0.00
   * minimum on a pay-what-you-want tier reads as "min $0.00", not "min Free".
   */
  formatAmount: (cents: number) => string;
  /** Currency for a headline price, where 0 reads as the "Free" word. */
  formatPrice: (cents: number) => string;
};

/**
 * The muted mono second line of a dropdown row:
 *   "$15.00 · 100 cap" · "Free · 10 cap"
 *   "min $0.00 · suggested $10.00 · 100 cap"
 * Every word in it comes from the catalog, so it translates with the rest.
 */
export function buildPresetMetaLine(
  preset: TicketTypePreset,
  deps: PresetMetaDeps,
): string {
  if (preset.id === TICKET_TYPE_PRESET_CUSTOM_ID) {
    return deps.translate("admin.ttPresetCustomMeta");
  }

  if (preset.pricingMode === "ADJUSTABLE") {
    return deps.translate("admin.ttPresetMetaAdjustable", {
      min: deps.formatAmount(presetDollarsToCents(preset.minimumDollars)),
      suggested: deps.formatAmount(
        presetDollarsToCents(preset.suggestedDollars),
      ),
      capacity: preset.capacity,
    });
  }

  return deps.translate("admin.ttPresetMetaFixed", {
    price: deps.formatPrice(presetDollarsToCents(preset.priceDollars)),
    capacity: preset.capacity,
  });
}
