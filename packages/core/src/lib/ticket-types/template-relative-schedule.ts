import type {
  TicketTypeTemplateEntry,
  TicketTypeTemplateRelativeInstant,
} from "@th/types";

/**
 * Materialization of a ticket-type TEMPLATE's relative schedule and sales
 * window into the absolute instants a `TicketType` row stores
 * (docs/specs/2026-08-04/completed/ticket-type-packs.spec.yaml FR-015/FR-016, adopted by
 * docs/specs/2026-08-10/completed/time-based-ticket-pricing.spec.yaml FR-011/FR-012).
 *
 * ── WHY RELATIVE AT ALL ─────────────────────────────────────────────────────
 * Templates are org-scoped and reused across events. An absolute
 * `scheduledPriceAt` in a template is meaningless the moment the date passes:
 * "early bird until 3 March" cannot be applied in April. Phases 1–2 shipped the
 * absolute columns, which is the right shape for a real event; the template
 * carries the INTENT ("14 days before the show") and resolves it against
 * whichever event it lands on.
 *
 * ── THE ENCODING, AND THE PRECEDENT IT MIRRORS ──────────────────────────────
 * `{ anchor, offsetMinutes }`, signed, negative = before. This is
 * `VolunteerRoleTemplateShift`'s encoding (packages/db/prisma/volunteer.prisma:
 * `anchor VolunteerShiftAnchor @default(WALL_CLOCK)` + `offsetMinutes Int`),
 * deliberately reused rather than a second invention. Two differences, both
 * forced by the domain:
 *
 *  - No `WALL_CLOCK` member. A volunteer shift has a time-of-day carrier to
 *    fall back to (`startMinuteOfDay`); a sales bound has none, so "unset" is
 *    the field being null rather than an anchor value meaning nothing.
 *  - `EVENT_PUBLISH` replaces `EVENT_END`. `Event.endsAt` is nullable, and
 *    tickets go on sale relative to announcement, not to the encore.
 *
 * There is NO doors anchor. RE-VERIFIED 2026-08-12 against packages/db/prisma:
 * `Event` has no `doorsAt` column — the same finding the volunteer spec
 * recorded, still true.
 *
 * ── DST: OFFSETS ARE ELAPSED TIME, NOT CALENDAR TIME ────────────────────────
 * `offsetMinutes` is applied as absolute milliseconds to the anchor instant —
 * exactly what `resolveTemplateShift`'s anchored branch does
 * (apps/web/src/lib/template-shift-offset.ts). It is NOT converted into
 * calendar days and re-stamped as a wall clock, and that is a decision, not an
 * oversight:
 *
 *  1. FR-016 says "resolved in absolute time".
 *  2. THE FIELD IS `offsetMinutes`, NOT `offsetDays`, AND THAT SETTLES IT.
 *     Calendar arithmetic on a scalar minute count is not merely partial — it
 *     is UNDEFINED, because the count has no canonical decomposition. −20161
 *     is "14 days and 1 minute" or "13 days and 1441 minutes" with equal
 *     justification, and across a transition those two readings give DIFFERENT
 *     instants. There is no rule to appeal to, because the caller never told us
 *     where the day boundary in their number was. (This is exactly why the
 *     volunteer encoding can afford calendar semantics: it carries a SEPARATE
 *     `startDayOffset` for the coarse part and caps `offsetMinutes` at ±1440,
 *     so its decomposition is given rather than guessed. We have no such field,
 *     by FR-015's design.)
 *  3. Absolute arithmetic is TOTAL. Calendar arithmetic is partial even once
 *     you have picked a decomposition: "1440 minutes before a 02:30 show on a
 *     spring-forward morning" names a wall clock that does not exist, and
 *     "…on a fall-back morning" names one that happens twice. Every such
 *     resolution would need a gap/ambiguity policy on a value the organizer
 *     never typed and cannot see. An elapsed-time offset always names exactly
 *     one instant.
 *  4. A sales bound is a DEADLINE ("stop selling a fortnight out"), not an
 *     appointment. Elapsed time is what a deadline means.
 *
 * THE CONSEQUENCE, STATED SO NOBODY REDISCOVERS IT AS A BUG: when the offset
 * spans a DST transition, the resolved instant's WALL CLOCK differs from the
 * anchor's by the transition step. A `-20160` (14-day) close on a 20:00
 * America/New_York show on 2026-11-14 lands at 21:00 on 2026-10-31, because
 * those 14 days contain 337 hours, not 336. Pinned in both directions by
 * `__tests__/template-relative-schedule.test.ts`.
 *
 * Note what this module therefore does NOT need: `Event.timezone`. It performs
 * no zone arithmetic at all, so it cannot repeat the FR-007 failure of
 * resolving against the browser's clock or against a hardcoded
 * `PAYOUT_TZ`/`REFUND_TZ`. The zone still matters for DISPLAY — the organizer
 * reads the resolved instant back on the venue's clock — and that stays the
 * caller's job.
 *
 * ── LAYERING ────────────────────────────────────────────────────────────────
 * Pure functions. No repo access, no clock of its own: the caller passes
 * `deps.clock.now()` as `appliedAt`. Shared by `applyTicketTypeTemplate`
 * (server) and the preset picker (apps/web) so a preset and a template that
 * encode the same intent cannot resolve to different instants.
 */

const MS_PER_MINUTE = 60_000;

/**
 * Bound on `offsetMinutes`, in minutes: one leap year either side.
 *
 * Generous because there is no day-offset field to carry the coarse part (the
 * volunteer encoding caps at ±1440 precisely because `startDayOffset` does),
 * and FR-015's own worked example is already −20160. It exists for the same
 * reason theirs does: to stop a minutes-vs-seconds confusion (−20160 typed as
 * −1209600) scheduling a flip two and a half years out.
 */
export const MAX_TEMPLATE_OFFSET_MINUTES = 366 * 24 * 60;

/** Everything a relative template instant can be resolved against. */
export interface RelativeTemplateTarget {
  /** `Event.startsAt` — a non-null column, so EVENT_START always resolves. */
  eventStartsAt: Date;
  /**
   * When the apply is happening (`deps.clock.now()`), and the EVENT_PUBLISH
   * anchor's reference. See {@link resolveRelativeTemplateInstant} for why it
   * is apply time and not `Event.publishedAt`.
   */
  appliedAt: Date;
}

/**
 * Resolve one `{ anchor, offsetMinutes }` to the instant it names, or `null`
 * when the stored value is not a resolvable relative instant at all.
 *
 * ── WHY THIS RETURNS `Date | null` AND NOT AN INVALID DATE ──────────────────
 * These values arrive from a `Json` column. Zod guards every write path today,
 * but nothing guards a row written before the schema existed, by a future
 * migration, or by hand. An earlier revision "defended" with `Math.trunc`,
 * which is no defence at all: `Math.trunc(NaN)` is `NaN`, as are `undefined`
 * and any non-numeric string, so the result was an INVALID DATE that then
 * slipped through BOTH drop rules — `NaN <= now` is false and `NaN >= NaN` is
 * false — and landed in `upsertTicketType`, where `normalizeSalesWindow` throws
 * TICKET_TYPE_SALES_WINDOW_INVALID. That throw is not caught by
 * `createEntries` (which only absorbs TICKET_TYPE_NAME_TAKEN), so ONE corrupt
 * entry would abort a multi-entry apply with the earlier entries already
 * committed — precisely the partial-commit failure that
 * {@link materializeTemplateEntrySchedule} degrades-and-warns to avoid for the
 * inverted case. A bad bound must fail the same way every other bad bound does.
 *
 * The anchor is checked against the two literals for the same reason: a
 * corrupt or future anchor string used to fall through to `EVENT_PUBLISH`
 * (anything-but-EVENT_START), silently resolving a window against apply time.
 * An unrecognized anchor is not an EVENT_PUBLISH window; it is an unresolvable
 * one, and it says so.
 *
 * Given a well-formed input it is TOTAL. `EVENT_START` reads `Event.startsAt`,
 * a required column. `EVENT_PUBLISH` reads APPLY TIME, deliberately and in both
 * publication states:
 *
 *  - DRAFT event: publish has not happened and its instant is unknowable, so
 *    apply time is the only reference available. (FR-016's own phrasing only
 *    covers the published case; the draft case is the common one in the
 *    builder and is answered here.)
 *  - PUBLISHED event: `Event.publishedAt` EXISTS and is deliberately NOT used.
 *    FR-016 says the publish anchor resolves against apply time when the event
 *    is already published, and the reason holds up: a historical publish
 *    instant can only ever produce a bound in the PAST. For `salesOpen` that is
 *    harmless but useless ("already open" — which is what no bound means
 *    anyway); for `salesClose` and for a scheduled price change it is actively
 *    destructive, because an already-elapsed value trips the drop-and-warn path
 *    in {@link materializeTemplateEntrySchedule} on EVERY template applied to a
 *    live event. Apply time keeps "goes on sale when this is announced"
 *    meaningful for a tier added after the announcement.
 *
 * Consequence worth naming: applying the same template to the same published
 * event twice, an hour apart, yields EVENT_PUBLISH bounds an hour apart. That
 * is inherent to anchoring on apply time and is why the resolved instants are
 * shown back to the organizer rather than assumed.
 *
 * A POSITIVE OFFSET ON `EVENT_PUBLISH` LOSES ITS MEANING ON A DRAFT, and only
 * offset 0 is exercised by anything shipped. `{ EVENT_PUBLISH, +1440 }` means
 * "on sale a day after the announcement"; applied to a draft that the organizer
 * publishes five days later, it resolves to four days BEFORE the announcement,
 * because apply time is all a draft has. Offset 0 is immune (a bound at apply
 * time is "already open" either way), which is why FR-015's only publish
 * example is 0. Anything else wants a real publish instant and a re-resolve at
 * publish, which no phase has specified — do not introduce a `+N` publish
 * preset without answering that first.
 */
export function resolveRelativeTemplateInstant(
  relative: TicketTypeTemplateRelativeInstant,
  target: RelativeTemplateTarget,
): Date | null {
  const anchorInstant =
    relative.anchor === "EVENT_START"
      ? target.eventStartsAt
      : relative.anchor === "EVENT_PUBLISH"
        ? target.appliedAt
        : null;
  if (anchorInstant == null) return null;

  // `Number.isFinite` and not `Math.trunc`: trunc launders NaN into NaN and an
  // Invalid Date past every downstream check. See the docblock.
  const offsetMinutes = relative.offsetMinutes;
  if (typeof offsetMinutes !== "number" || !Number.isFinite(offsetMinutes)) {
    return null;
  }

  const resolved = new Date(
    anchorInstant.getTime() + Math.trunc(offsetMinutes) * MS_PER_MINUTE,
  );
  // The anchor itself can be an Invalid Date (a malformed `Event.startsAt`
  // reaching core), which no arithmetic above would catch.
  return Number.isNaN(resolved.getTime()) ? null : resolved;
}

/**
 * Why a relative field could not be materialized. Each maps to organizer-facing
 * copy at the transport edge; the codes stay here so core owns the vocabulary.
 */
export type TemplateScheduleDropReason =
  /** The resolved instant is at or before apply time. */
  | "already_elapsed"
  /** Both bounds resolved, but the opening one is not strictly before the close. */
  | "inverted"
  /**
   * The stored relative value could not be read at all — an unrecognized
   * anchor, or a non-finite `offsetMinutes` — so it names no instant.
   * Structurally unreachable through any write path zod guards; it exists so a
   * corrupt `Json` row degrades like every other bad bound instead of throwing
   * out of `upsertTicketType` and aborting a part-committed apply.
   */
  | "unresolvable";

/** Which half of the entry was dropped. */
export type TemplateScheduleDropField = "salesWindow" | "scheduledPrice";

export interface TemplateScheduleDrop {
  field: TemplateScheduleDropField;
  reason: TemplateScheduleDropReason;
}

/** The absolute fields a materialized entry contributes to `upsertTicketType`. */
export interface MaterializedTemplateSchedule {
  salesOpenAt: Date | null;
  salesCloseAt: Date | null;
  scheduledPriceCents: number | null;
  scheduledPriceAt: Date | null;
  /** Empty for the overwhelming majority of entries (NFR-001). */
  drops: TemplateScheduleDrop[];
}

/**
 * Materialize one template entry's relative fields against a target event.
 *
 * NFR-001, structurally: an entry carrying none of the three relative fields
 * returns all-nulls and no drops, which is byte-identical to what
 * `applyTicketTypeTemplate` sent before this existed.
 *
 * ── WHAT GETS DROPPED, AND WHY EACH RULE IS THE RULE ────────────────────────
 * FR-016's standing instruction is "never a silently unsellable or mispriced
 * type". Each field is judged against apply time:
 *
 *  - SCHEDULED PRICE, resolved at or before now → DROPPED as a pair, reason
 *    `already_elapsed`. Keeping it would create a tier that is already past its
 *    own flip, i.e. one whose list price is a number nobody will ever be
 *    charged. Note this is STRICTER than the admin UI, which permits an
 *    organizer to backdate a flip deliberately (with a visible warning) — there
 *    the instant was typed; here it fell out of arithmetic the organizer never
 *    saw. The post-flip price is NOT promoted into `priceCents`: rewriting a
 *    price the organizer did not ask for is the mispricing this rule exists to
 *    prevent.
 *
 *  - SALES CLOSE, resolved at or before now → the WHOLE WINDOW is dropped
 *    (both bounds), reason `already_elapsed`. Born-closed is the unsellable
 *    tier FR-016 names. Both bounds go, not just the close: leaving a future
 *    `salesOpen` behind would silently convert "opens Friday, closes Saturday"
 *    into "opens Friday, never closes", which is a different product. Same
 *    pairing as `generate-events-from-series`' Q-005 guard.
 *
 *  - BOTH BOUNDS RESOLVED AND NOT open < close → whole window dropped, reason
 *    `inverted`. `normalizeSalesWindow` would reject the write outright with
 *    TICKET_TYPE_SALES_WINDOW_INVALID, which on a multi-entry apply would abort
 *    the run partway and leave earlier entries committed. Degrading to "no
 *    window" plus a named warning is the behaviour FR-016 asks for. Zero-width
 *    counts as inverted, exactly as the write boundary treats it. MIXED ANCHORS
 *    ARE THE ONLY ROUTE TO IT: the entry schema statically rejects an inverted
 *    same-anchor pair, and a shared anchor cannot be inverted by DST either —
 *    `t + a` versus `t + b` preserves the ordering of `a` and `b` with no
 *    reference to any calendar, which is elapsed-time arithmetic's whole point.
 *    (An earlier revision of this comment claimed a DST route. It was wrong,
 *    and wrong in the one module whose job is to document the DST decision.)
 *
 *  - SALES OPEN alone, resolved in the past → KEPT, NOT a drop. "Already open"
 *    is exactly what no lower bound means; the series generator reached the
 *    same conclusion in as many words. Nulling it would be indistinguishable in
 *    effect and would spend a warning the organizer cannot act on.
 *
 *  - EITHER FIELD UNREADABLE (`resolveRelativeTemplateInstant` → null) →
 *    dropped, reason `unresolvable`. Never propagated as an Invalid Date: see
 *    that function's docblock for the part-committed apply this prevents.
 */
export function materializeTemplateEntrySchedule(
  entry: Pick<
    TicketTypeTemplateEntry,
    "salesOpen" | "salesClose" | "scheduledPriceChange"
  >,
  target: RelativeTemplateTarget,
): MaterializedTemplateSchedule {
  const drops: TemplateScheduleDrop[] = [];
  const nowMs = target.appliedAt.getTime();

  // ── Sales window ──────────────────────────────────────────────────────────
  let salesOpenAt =
    entry.salesOpen != null
      ? resolveRelativeTemplateInstant(entry.salesOpen, target)
      : null;
  let salesCloseAt =
    entry.salesClose != null
      ? resolveRelativeTemplateInstant(entry.salesClose, target)
      : null;

  // An unreadable bound takes the whole window with it, for the same reason an
  // elapsed close does: half a window is a different product from the one the
  // template describes, and there is no honest way to keep the other half.
  const windowUnresolvable =
    (entry.salesOpen != null && salesOpenAt == null) ||
    (entry.salesClose != null && salesCloseAt == null);

  if (windowUnresolvable) {
    salesOpenAt = null;
    salesCloseAt = null;
    drops.push({ field: "salesWindow", reason: "unresolvable" });
  } else if (salesCloseAt != null && salesCloseAt.getTime() <= nowMs) {
    salesOpenAt = null;
    salesCloseAt = null;
    drops.push({ field: "salesWindow", reason: "already_elapsed" });
  } else if (
    salesOpenAt != null &&
    salesCloseAt != null &&
    salesOpenAt.getTime() >= salesCloseAt.getTime()
  ) {
    salesOpenAt = null;
    salesCloseAt = null;
    drops.push({ field: "salesWindow", reason: "inverted" });
  }

  // ── Scheduled price change ────────────────────────────────────────────────
  let scheduledPriceCents: number | null = null;
  let scheduledPriceAt: Date | null = null;
  if (entry.scheduledPriceChange != null) {
    const at = resolveRelativeTemplateInstant(
      entry.scheduledPriceChange.at,
      target,
    );
    const priceCents = entry.scheduledPriceChange.priceCents;
    if (at == null || !Number.isInteger(priceCents) || priceCents < 0) {
      // The price is validated here as well as at the write boundary because
      // `normalizeScheduledPrice` THROWS on a bad one, and a throw mid-apply
      // is the part-committed failure this whole path exists to avoid.
      drops.push({ field: "scheduledPrice", reason: "unresolvable" });
    } else if (at.getTime() <= nowMs) {
      drops.push({ field: "scheduledPrice", reason: "already_elapsed" });
    } else {
      scheduledPriceCents = priceCents;
      scheduledPriceAt = at;
    }
  }

  return {
    salesOpenAt,
    salesCloseAt,
    scheduledPriceCents,
    scheduledPriceAt,
    drops,
  };
}
