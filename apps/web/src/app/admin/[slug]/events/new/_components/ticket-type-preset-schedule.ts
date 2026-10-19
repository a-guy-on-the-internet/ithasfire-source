import {
  materializeTemplateEntrySchedule,
  type TemplateScheduleDrop,
} from "@th/core/lib/ticket-types/template-relative-schedule";

import { parseMoneyInputToCents } from "@/lib/money/parse-money-input";
import { toDateTimeLocalValue } from "./event-builder-helpers";
import { isKnownTimeZone, type ScheduledPriceDraft } from "./ticket-type-schedule";
import type { SalesWindowDraft } from "./ticket-type-sales-window";
import type { TicketTypePreset } from "./ticket-type-presets";

/**
 * Materialize a "Start from" preset's RELATIVE schedule and sales window into
 * the ticket-type editor's draft fields
 * (docs/specs/2026-08-10/completed/time-based-ticket-pricing.spec.yaml FR-012, encoding
 * per ticket-type-packs FR-015, resolution per FR-016).
 *
 * ── ONE RESOLVER, NOT TWO ───────────────────────────────────────────────────
 * The arithmetic is NOT reimplemented here. It is
 * `materializeTemplateEntrySchedule` from `@th/core/lib/ticket-types`, the same
 * function `applyTicketTypeTemplate` calls server-side, imported the way this
 * app already imports pure core helpers (`@th/core/lib/ical`,
 * `@th/core/lib/payments/chargeback-terms`). A preset and a template that
 * encode the same intent therefore cannot resolve to different instants, and
 * the drop rules — already-elapsed, inverted, lone-open-is-fine — are stated in
 * exactly one place. A hand-copied second implementation would be green by
 * construction and wrong the first time either side changed.
 *
 * ── Q-003, RESOLVED: NOTHING TO GATE ────────────────────────────────────────
 * The worry was that a preset runs before the event's date is settled and so
 * has nothing to resolve against. It cannot happen: `TicketTypeEditor` only
 * renders with an `eventId`, so by the time any preset is pickable the event —
 * and therefore its `startsAt` and `timezone` — is persisted. This module still
 * REFUSES rather than guesses when either is missing, because "cannot happen"
 * and "silently resolves against the browser's clock if it does" are not the
 * same promise (the FR-007 lesson).
 *
 * ── WHAT IT RETURNS, AND WHY IT IS DRAFTS AND NOT INSTANTS ──────────────────
 * The editor already owns two collapsible controls for exactly these fields
 * (Phase 1c's scheduled price, Phase 2c's window), each holding a WALL CLOCK in
 * the event's timezone with a read-back. Seeding those drafts — rather than
 * stashing hidden instants until Add — means the organizer SEES what the preset
 * chose on their venue's clock, can edit it, and can switch it off. Q-003's
 * "materializes on Add" is satisfied in the only sense that matters (nothing is
 * written until Add), with the resolution visible in between instead of not.
 *
 * The instant → wall clock direction uses `toDateTimeLocalValue`, which formats
 * a real instant through `Intl` and is DST-exact by construction. It is NOT the
 * inverse `toIsoInTimeZone`, whose single-probe implementation is an hour wrong
 * across a transition.
 */

/** What a preset asks the editor to pre-fill for the two time controls. */
export type PresetSchedulePrefill = {
  /**
   * `null` = the preset says nothing about this control, so LEAVE IT ALONE.
   * Distinct from a disabled draft, which would clear a schedule the organizer
   * had already configured merely because they browsed the preset list.
   */
  schedule: ScheduledPriceDraft | null;
  salesWindow: SalesWindowDraft | null;
  /**
   * FR-016 drops — a bound that could not be materialized against THIS event
   * and was therefore not pre-filled. NON-EMPTY MEANS THE EDITOR MUST SAY SO.
   *
   * It is tempting to stay quiet here, on the grounds that a preset writes
   * nothing and an un-ticked control is not a loss. That reasoning is wrong,
   * and specifically wrong for the Advance/Door pair, because the two halves
   * degrade ASYMMETRICALLY: an elapsed `salesClose` is dropped while a lone
   * elapsed `salesOpen` is KEPT (it means "already open"). Inside 24h of doors
   * that turns the pair inside out — Advance seeds no close and never stops
   * selling, Door seeds an open in the past and is already live, both sell at
   * once, and every buyer takes the $12 advance over the $20 door. The shared
   * handover constant guarantees no gap and no overlap only OUTSIDE that
   * window; inside it the guarantee inverts.
   *
   * And the organizer cannot see it: a control left un-ticked because the
   * timing evaporated is pixel-identical to one left un-ticked because the
   * preset never had timing. `TicketTypeEditor` renders a note when this is
   * non-empty.
   */
  drops: TemplateScheduleDrop[];
};

const NOTHING: PresetSchedulePrefill = {
  schedule: null,
  salesWindow: null,
  drops: [],
};

export type PresetScheduleTarget = {
  /** `Event.startsAt`. */
  eventStartsAt: Date | null;
  /** `Event.timezone` — the venue's clock, NEVER the browser's. */
  timeZone: string | null;
  /** Injected so "already elapsed" is testable. */
  now: Date;
};

/**
 * Resolve a preset's relative fields against the event being edited.
 *
 * Returns {@link NOTHING} — all nulls, no drops — when the preset carries no
 * relative fields at all, which is seven of the nine catalog entries and the
 * overwhelming majority of picks (NFR-001: the untouched path stays untouched).
 * Also returns it when the event's start or zone is unknown: refusing is the
 * FR-007 discipline, and a preset that silently resolved against the browser's
 * clock would put an organizer's day-of cutover hours out with nothing on
 * screen to show for it.
 */
export function resolvePresetSchedulePrefill(
  preset: TicketTypePreset,
  target: PresetScheduleTarget,
): PresetSchedulePrefill {
  const carriesNothing =
    preset.salesOpen == null &&
    preset.salesClose == null &&
    preset.scheduledPriceChange == null;
  if (carriesNothing) return NOTHING;

  const { eventStartsAt, timeZone } = target;
  if (!eventStartsAt || Number.isNaN(eventStartsAt.getTime())) return NOTHING;
  if (!timeZone || !isKnownTimeZone(timeZone)) return NOTHING;

  // The post-flip price is read by the SAME parser as every other money field
  // in this editor. A preset carrying an unreadable amount drops its whole
  // schedule rather than banking a 0 — the `presetDollarsToCents` display
  // fallback is explicitly not reusable on a path that leads to a price.
  const flipPrice = preset.scheduledPriceChange
    ? parseMoneyInputToCents(preset.scheduledPriceChange.priceDollars)
    : null;
  const scheduledPriceChange =
    preset.scheduledPriceChange && flipPrice?.ok
      ? {
          at: preset.scheduledPriceChange.at,
          priceCents: flipPrice.cents,
        }
      : null;

  const resolved = materializeTemplateEntrySchedule(
    {
      salesOpen: preset.salesOpen,
      salesClose: preset.salesClose,
      scheduledPriceChange,
    },
    { eventStartsAt, appliedAt: target.now },
  );

  const salesWindow: SalesWindowDraft | null =
    preset.salesOpen != null || preset.salesClose != null
      ? {
          // Both bounds drop together (FR-016 nulls the window as a pair), so
          // a dropped window leaves the control off rather than half-filled.
          enabled:
            resolved.salesOpenAt != null || resolved.salesCloseAt != null,
          openLocal: toDateTimeLocalValue(resolved.salesOpenAt, timeZone),
          closeLocal: toDateTimeLocalValue(resolved.salesCloseAt, timeZone),
        }
      : null;

  const schedule: ScheduledPriceDraft | null = preset.scheduledPriceChange
    ? {
        enabled:
          resolved.scheduledPriceCents != null &&
          resolved.scheduledPriceAt != null,
        priceDollars:
          resolved.scheduledPriceCents != null
            ? (resolved.scheduledPriceCents / 100).toFixed(2)
            : "",
        atLocal: toDateTimeLocalValue(resolved.scheduledPriceAt, timeZone),
      }
    : null;

  return { schedule, salesWindow, drops: resolved.drops };
}
