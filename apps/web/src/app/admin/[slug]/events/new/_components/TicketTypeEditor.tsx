"use client";

import {
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ComponentRef,
} from "react";
import { useParams } from "next/navigation";
import { nanoid } from "nanoid";
import { styled, XStack, YStack, useTheme } from "tamagui";
import {
  Plus,
  Ticket,
  Edit3,
  Trash2,
  X,
  Check,
  Repeat,
  CreditCard,
  ExternalLink,
  CalendarClock,
  CalendarRange,
} from "lucide-react";

import {
  Text,
  TextInput,
  Button,
  NextLinkAnchor,
  useNotify,
  useTranslations,
  useFormatters,
} from "@th/ui";

import { trpc } from "@/trpc";
import { useFeatureGates } from "@/hooks/useFeatureGates";
import { useIsMobile } from "@/hooks/useIsMobile";
import { formatErrorMessage } from "@/lib/format-error-message";
import { getAppErrorCode } from "@/lib/app-error";
import { fmtCurrency } from "@/lib/format";
import { parseMoneyInputToCents } from "@/lib/money/parse-money-input";
import { MAX_DONATION_AMOUNT_CENTS } from "@/lib/pricing/pay-what-you-want";
import { FieldLabel } from "./_form-bits";
import { EventEditorSheet } from "./EventEditorSheet";
import { TicketTypeTemplateControls } from "./TicketTypeTemplateControls";
import type { TemplateOwnerRef } from "./TicketTypeTemplateControls";
import { TicketTypePresetPicker } from "./TicketTypePresetPicker";
import { TicketScheduledPriceField } from "./TicketScheduledPriceField";
import { TicketSalesWindowField } from "./TicketSalesWindowField";
import {
  emptyScheduledPriceDraft,
  formatZonedInstant,
  resolveScheduledPriceChange,
  scheduledPriceDraftFromTicketType,
  type ScheduledPriceDraft,
} from "./ticket-type-schedule";
import {
  describeSalesWindow,
  emptySalesWindowDraft,
  resolveSalesWindow,
  salesWindowDraftFromTicketType,
  type SalesWindowDraft,
} from "./ticket-type-sales-window";
import {
  TICKET_TYPE_PRESET_CUSTOM_ID,
  applyPresetToForm,
  type TicketTypePreset,
  type TicketTypePresetId,
} from "./ticket-type-presets";
import { resolvePresetSchedulePrefill } from "./ticket-type-preset-schedule";
import {
  EditorCard,
  EditorCardActions,
  EditorCardMeta,
  EditorCardTitle,
} from "./_mobile-bits";

const TicketRow = styled(XStack, {
  paddingVertical: 12,
  paddingHorizontal: 14,
  borderWidth: 1,
  borderColor: "$borderColor",
  borderLeftWidth: 4,
  borderLeftColor: "$borderColorStrong",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  cursor: "pointer",
  hoverStyle: {
    backgroundColor: "$surfaceMuted",
    borderColor: "$borderColorStrong",
  },
  pressStyle: { backgroundColor: "$surfaceMuted" },
});

/** Minimal shape the mobile card meta needs from a ticket type. */
export type TicketCardMetaInput = {
  pricingMode?: string;
  priceCents: number;
  minimumCents?: number | null;
  suggestedCents?: number | null;
  capacity: number;
  resaleAllowed: boolean;
  resaleCapCents?: number | null;
  /**
   * What this tier costs an online buyer RIGHT NOW, resolved server-side
   * through `resolveUnitPriceCents`. Optional so pre-existing callers/tests
   * keep working; when present and DIFFERENT from `priceCents` it becomes the
   * headline (see `resolvePriceHeadline`).
   */
  effectivePriceCents?: number;
};

/**
 * The price to SHOW for a ticket type, and the stale one to show beside it.
 *
 * `priceCents` is the stored list price. Once a scheduled price change has
 * fired, that is not what anyone is charged — but the fee block rendered two
 * lines below comes from `getEventFeePreview`, which DOES resolve through
 * `resolveUnitPriceCents`. Showing the raw price meant a row could read
 * "$12 · 100 tickets" with "Buyer pays $21.xx" underneath while buyers were
 * charged $20: three numbers, two of them lies.
 *
 * So the headline is the EFFECTIVE price whenever it differs, with the former
 * price kept visible as context rather than dropped — an organizer looking at
 * "$20" needs to see that it used to be $12 to recognise their own tier.
 *
 * DISPLAY ONLY. This must never feed the edit form's Price input: that field
 * is bound to the stored `priceCents`, and projecting the resolved price into
 * it would round-trip the post-flip price back into `priceCents` on the next
 * save, collapsing the schedule (see the doc on
 * `list-event-ticket-types-for-edit.ts`).
 */
export function resolvePriceHeadline(
  tt: Pick<TicketCardMetaInput, "priceCents" | "effectivePriceCents">,
): { cents: number; wasCents: number | null } {
  const effective = tt.effectivePriceCents;
  // `== null` rather than falsy: an effective price of 0 (a tier that has
  // already flipped to free) is a real value and must win the headline.
  if (effective == null || effective === tt.priceCents) {
    return { cents: tt.priceCents, wasCents: null };
  }
  return { cents: effective, wasCents: tt.priceCents };
}

/**
 * Build the single-line muted caption for a ticket type's mobile EditorCard:
 * price (or PWYW summary) · capacity · resale note. Pure so it can be unit
 * tested; the component injects its `formatPrice` and capacity-label callbacks
 * so there's one source of truth with the desktop row's formatters.
 */
export function buildTicketCardMeta(
  tt: TicketCardMetaInput,
  formatPrice: (cents: number) => string,
  capacityLabel: (capacity: number) => string,
  opts: {
    /**
     * When false (the `resale` feature gate is off), the resale note is
     * suppressed even for tickets whose stored `resaleAllowed` is true —
     * display-layer gating only; the stored value is untouched.
     *
     * REQUIRED, and deliberately not defaulted. It used to be optional with a
     * `?? true` fallback, so the gate failed OPEN: any caller that forgot it
     * printed "Resale allowed" for a feature that is switched off. Every other
     * resale check in this codebase reads `gates?.resale === true` and fails
     * closed; make the type force the caller to say which it is.
     */
    resaleEnabled: boolean;
    /**
     * Renders the "was $12" suffix when a scheduled price change has already
     * fired. Optional so existing callers/tests are unaffected; the component
     * always passes the i18n version. The English fallback matches the literals
     * already hardcoded in this function — pre-existing debt, not new.
     */
    wasLabel?: (formattedPrice: string) => string;
  },
): string {
  const headline = resolvePriceHeadline(tt);
  const wasSuffix =
    headline.wasCents == null
      ? ""
      : ` · ${(opts.wasLabel ?? ((p: string) => `was ${p}`))(formatPrice(headline.wasCents))}`;
  const priceLabel =
    tt.pricingMode === "ADJUSTABLE"
      ? `Pay What You Want${tt.minimumCents ? ` (min ${formatPrice(tt.minimumCents)})` : ""}${tt.suggestedCents ? ` · suggested ${formatPrice(tt.suggestedCents)}` : ""}`
      : `${formatPrice(headline.cents)}${wasSuffix}`;
  const resaleLabel =
    tt.resaleAllowed && opts.resaleEnabled
      ? ` · Resale allowed${tt.resaleCapCents != null ? ` (cap: ${formatPrice(tt.resaleCapCents)})` : ""}`
      : "";
  return `${priceLabel} · ${capacityLabel(tt.capacity)}${resaleLabel}`;
}

/**
 * What a money field's raw text means for a submit.
 *
 * `blank` is its own case on purpose: the CALLER decides what blank means (a
 * blank price is a free ticket; a blank minimum / suggested / resale cap is
 * "not set"). `error` carries i18n KEYS, never rendered copy, so this stays
 * pure and locale-agnostic.
 */
export type TicketAmountField =
  | { kind: "cents"; cents: number }
  | { kind: "blank" }
  | { kind: "error"; titleKey: string; messageKey: string };

/**
 * Read one free-text money field, refusing anything unreadable.
 *
 * Every money field in this editor is a plain text input, so the old
 * `Math.round(parseFloat(x) * 100)` silently banked an es-locale "15,50" as
 * $15.00 — real money lost on every sale, with no error shown.
 * `parseMoneyInputToCents` reads both decimal separators and REFUSES what it
 * can't read; this maps a refusal onto the editor's existing
 * error-toast-and-stop idiom.
 *
 * `copy` picks whose voice the toast speaks in: the price field keeps its
 * long-standing "Invalid price" copy, the optional amounts get the generic
 * "Invalid amount" one.
 */
/**
 * Whether a Pay What You Want minimum / suggestion field holds a readable
 * amount above the per-ticket cap checkout enforces ($10,000.00). The server
 * refuses it too (`upsertTicketType` / `updateTicketType`); this is the
 * inline, before-save half.
 */
export function isAbovePwywCap(raw: string): boolean {
  const field = resolveTicketAmountField(raw, "amount");
  return field.kind === "cents" && field.cents > MAX_DONATION_AMOUNT_CENTS;
}

export function resolveTicketAmountField(
  raw: string,
  copy: "price" | "amount",
): TicketAmountField {
  const result = parseMoneyInputToCents(raw);
  if (result.ok) return { kind: "cents", cents: result.cents };
  if (result.reason === "empty") return { kind: "blank" };
  return {
    kind: "error",
    titleKey:
      copy === "price"
        ? "admin.ttInvalidPriceTitle"
        : "admin.ttInvalidAmountTitle",
    messageKey:
      result.reason === "ambiguous"
        ? "admin.ttAmbiguousAmountMessage"
        : copy === "price"
          ? "admin.ttInvalidPriceMessage"
          : "admin.ttInvalidAmountMessage",
  };
}

export type TicketTypeEditorProps = {
  eventId: string;
  /** When true, the editor is read-only (e.g. tickets have been sold). */
  disabled?: boolean;
  /**
   * The EVENT's owner — whose ticket-template library "Save as Template" /
   * "Apply Template" use. Not the URL workspace: a delegate on a principal's
   * event works in the principal's library. Omitted → the controls are hidden.
   */
  templateOwner?: TemplateOwnerRef;
  /**
   * Offer "Customise" on catalogue templates. The fork asks the admin bar
   * (org OWNER/ADMIN; owner or OWNER/ADMIN delegate) — the builder's
   * `canManageEvent`. Defaults to false: never offer what the server refuses.
   */
  canCustomiseTemplates?: boolean;
  /** Current event title (used to persist "return to event" context). */
  eventTitle?: string;
  /** Whether this event already has a seating layout attached. */
  hasSeatingLayout?: boolean;
};

export type ReturnToEventData = {
  eventId: string;
  eventTitle: string;
  slug: string;
};

export function TicketTypeEditor({
  eventId,
  disabled = false,
  templateOwner,
  canCustomiseTemplates = false,
  hasSeatingLayout = false,
}: TicketTypeEditorProps) {
  const { toast } = useNotify();
  const t = useTranslations();
  const fmt = useFormatters();
  const utils = trpc.useUtils();
  const theme = useTheme();
  const isMobile = useIsMobile();

  // `resale` feature gate — off by default until resale is vetted. When off,
  // the per-ticket "Allow resale" toggle + cap UI and the resale badges are
  // hidden entirely (fail-closed while gates load), and the add flow force-
  // submits resaleAllowed:false so a hidden control can never submit stale
  // state. Existing tickets' stored resale values are NOT rewritten — the
  // edit flow round-trips the server-seeded values untouched.
  const { gates } = useFeatureGates();
  const resaleEnabled = gates?.resale === true;

  // Fetch existing ticket types for this event
  const ticketTypesQuery = trpc.events.listTicketTypesForEdit.useQuery(
    { eventId },
    { enabled: !!eventId },
  );

  // Fetch fee breakdown preview per ticket type
  const feePreviewQuery = trpc.events.getEventFeePreview.useQuery(
    { eventId },
    { enabled: !!eventId },
  );

  // The EVENT's timezone, for the scheduled-price-change control (FR-007).
  //
  // Read here rather than drilled down from EventBuilder deliberately: this is
  // byte-identical to the query key EventBuilder already mounts
  // (`getEventForEdit.useQuery({ eventId })`), so react-query serves it from
  // the shared cache entry — no extra request — and the value can never be a
  // stale prop from a render that happened before the event loaded.
  //
  // `null` until it arrives. There is NO browser-timezone fallback: resolving
  // an organizer's wall clock against `Intl...resolvedOptions().timeZone` is
  // precisely the bug FR-007 exists to prevent, so the control disables itself
  // instead of guessing.
  const eventForEditQuery = trpc.events.getEventForEdit.useQuery(
    { eventId },
    { enabled: !!eventId },
  );
  const eventTimezone = eventForEditQuery.data?.timezone ?? null;
  const eventCurrency = eventForEditQuery.data?.currency ?? "usd";
  /**
   * The EVENT_START anchor for a preset's relative sales window (FR-012).
   * Same shared query entry as the timezone above, so it costs no request.
   * `startsAt` crosses tRPC as a Date via superjson; narrowed defensively
   * because a preset that resolved against an unreadable start would place an
   * organizer's day-of cutover at the epoch.
   */
  const eventStartsAtRaw = eventForEditQuery.data?.startsAt;
  const eventStartsAt = useMemo(() => {
    if (!eventStartsAtRaw) return null;
    const parsed =
      eventStartsAtRaw instanceof Date
        ? eventStartsAtRaw
        : new Date(eventStartsAtRaw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }, [eventStartsAtRaw]);

  const feeByTicketType = useMemo(() => {
    const map = new Map<
      string,
      {
        platformFeeCents: number;
        // Null = the venue's tax rate is unknown (lookup failed): no tax,
        // processing (grossed up over tax) or "Buyer pays" figure.
        processorFeeCents: number | null;
        taxEstimateCents: number | null;
        buyerTotalCents: number | null;
        // What the event is credited for one ticket sold now: the full
        // ticket price (docs/decisions/platform-fee-charged-once.md).
        eventCreditCents: number;
      }
    >();
    for (const b of feePreviewQuery.data?.ticketBreakdowns ?? []) {
      map.set(b.ticketTypeId, {
        platformFeeCents: b.platformFeeCents,
        processorFeeCents: b.processorFeeCents,
        taxEstimateCents: b.taxEstimateCents,
        buyerTotalCents: b.buyerTotalCents,
        eventCreditCents: b.eventCreditCents,
      });
    }
    return map;
  }, [feePreviewQuery.data?.ticketBreakdowns]);

  const feeMode = feePreviewQuery.data?.feeMode ?? null;

  const upsertMutation = trpc.ticketTypes.upsertTicketType.useMutation({
    retry: false,
    meta: { silent: true },
    // Optimistically append the new ticket row so the list updates on submit
    // instead of waiting for the create + list refetch round-trips. The temp
    // id is the clientKey; onSettled's invalidate swaps in the real record.
    onMutate: async (vars) => {
      await utils.events.listTicketTypesForEdit.cancel({ eventId });
      const previous = utils.events.listTicketTypesForEdit.getData({ eventId });
      // Status isn't surfaced in the UI; mirror an existing row (status follows
      // event status) only to satisfy the row data shape until reconciliation.
      const status = previous?.ticketTypes[0]?.status ?? "ACTIVE";
      // The schedule pair travels as `Date | null` on the row even though the
      // mutation input accepts anything `z.coerce.date()` reads. `== null` and
      // never a falsy test: a scheduled price of 0 is a real "free after T".
      const listPriceCents = Number(vars.priceCents ?? 0);
      const scheduledCents =
        vars.scheduledPriceCents != null
          ? Number(vars.scheduledPriceCents)
          : null;
      // `z.coerce.date()` types its INPUT as `unknown`, so narrow to the two
      // shapes this editor actually sends (an ISO string) or could be handed
      // (a Date) before constructing one.
      const rawScheduledAt: unknown = vars.scheduledPriceAt;
      const parsedScheduledAt =
        rawScheduledAt instanceof Date
          ? rawScheduledAt
          : typeof rawScheduledAt === "string"
            ? new Date(rawScheduledAt)
            : null;
      const scheduledAt =
        parsedScheduledAt && !Number.isNaN(parsedScheduledAt.getTime())
          ? parsedScheduledAt
          : null;
      // Same narrowing for the two window bounds, which are INDEPENDENT — each
      // is read on its own and either may stay null. Without them the optimistic
      // row would render "no window" for the second or two before the refetch,
      // on a tier the organizer just created WITH one.
      const readBound = (raw: unknown): Date | null => {
        const parsed =
          raw instanceof Date
            ? raw
            : typeof raw === "string"
              ? new Date(raw)
              : null;
        return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
      };
      const salesOpenAt = readBound(vars.salesOpenAt);
      const salesCloseAt = readBound(vars.salesCloseAt);
      utils.events.listTicketTypesForEdit.setData({ eventId }, (old) =>
        old
          ? {
              ...old,
              ticketTypes: [
                ...old.ticketTypes,
                {
                  id: vars.clientKey,
                  name: vars.name,
                  priceCents: Number(vars.priceCents ?? 0),
                  pricingMode: vars.pricingMode ?? "FIXED",
                  minimumCents:
                    vars.minimumCents != null
                      ? Number(vars.minimumCents)
                      : null,
                  suggestedCents:
                    vars.suggestedCents != null
                      ? Number(vars.suggestedCents)
                      : null,
                  capacity: Number(vars.capacity),
                  status,
                  seatSectionId: null,
                  layoutSectionId: null,
                  resaleAllowed: vars.resaleAllowed ?? false,
                  resaleCapCents:
                    vars.resaleCapCents != null
                      ? Number(vars.resaleCapCents)
                      : null,
                  transferAllowed: vars.transferAllowed ?? true,
                  // The optimistic row has to carry the schedule too, or the
                  // list renders "no scheduled change" for the second or two
                  // before the refetch lands — on a ticket that was just
                  // created WITH one.
                  scheduledPriceCents: scheduledCents,
                  scheduledPriceAt: scheduledAt,
                  salesOpenAt,
                  salesCloseAt,
                  // ── THE ONE DELIBERATE EXCEPTION to architecture.layering ──
                  // The spec says "Transport and UI never compute a price; they
                  // display what core resolved." This line breaks that rule on
                  // purpose, and it is the ONLY place in the feature that does.
                  //
                  // Why it is acceptable HERE and nowhere else:
                  //   - it is an OPTIMISTIC cache entry with a lifetime of a
                  //     second or two; the refetch immediately overwrites it
                  //     with the server's resolved value;
                  //   - it is an ADMIN display field, never a charge — no buyer
                  //     ever sees it and no money is computed from it;
                  //   - the alternative is worse: rendering "no scheduled
                  //     change" on a tier the organizer JUST created with one,
                  //     which reads as a failed save.
                  //
                  // It uses `Date.now()` rather than an injected clock because
                  // there is no clock to inject in a React mutation callback —
                  // which is exactly why this must not be copied to any surface
                  // whose value outlives a refetch. If you find yourself
                  // reaching for this pattern elsewhere, resolve server-side
                  // and send the number down instead.
                  //
                  // Mirrors `resolveUnitPriceCents`: before the flip the
                  // effective price is the list price, at or after it the
                  // scheduled one.
                  effectivePriceCents:
                    scheduledAt != null &&
                    scheduledCents != null &&
                    Date.now() >= scheduledAt.getTime()
                      ? scheduledCents
                      : listPriceCents,
                },
              ],
            }
          : old,
      );
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) {
        utils.events.listTicketTypesForEdit.setData({ eventId }, ctx.previous);
      }
    },
    onSettled: () => {
      void utils.events.listTicketTypesForEdit.invalidate({ eventId });
      void utils.events.getEventFeePreview.invalidate({ eventId });
    },
  });

  const updateMutation = trpc.ticketTypes.updateTicketType.useMutation({
    retry: false,
    meta: { silent: true },
    onSuccess: () => {
      void utils.events.listTicketTypesForEdit.invalidate({ eventId });
      void utils.events.getEventFeePreview.invalidate({ eventId });
    },
  });

  const deleteMutation = trpc.ticketTypes.deleteTicketType.useMutation({
    retry: false,
    meta: { silent: true },
    onSuccess: () => {
      void utils.events.listTicketTypesForEdit.invalidate({ eventId });
      void utils.events.getEventFeePreview.invalidate({ eventId });
    },
  });

  // Form state for new ticket type
  const [name, setName] = useState("");
  const [priceDollars, setPriceDollars] = useState("");
  const [capacity, setCapacity] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  // Synchronous mirror of `isAdding` so the re-entrancy guard in `handleAdd`
  // also blocks a true same-tick double-invocation (before React re-renders),
  // matching the publish guard in EventBuilder. The `isAdding` state still
  // drives the disabled/label UI.
  const isAddingRef = useRef(false);
  const [showForm, setShowForm] = useState(false);
  // Sticky callout shown beneath the ticket-type box when the upsert
  // mutation rejects with `PAID_TICKETING_REQUIRES_STRIPE`. Lives outside
  // the toast lifecycle so the user can read it + click the setup link
  // without racing the auto-dismiss.
  const [stripeRequired, setStripeRequired] = useState(false);
  const params = useParams<{ slug: string }>();
  const adminSlug = params?.slug ?? "";
  const payoutsHref = adminSlug ? `/admin/${adminSlug}/payouts` : "/admin";
  const [resaleAllowed, setResaleAllowed] = useState(false);
  const [resaleCapDollars, setResaleCapDollars] = useState("");
  const [pricingMode, setPricingMode] = useState<"FIXED" | "ADJUSTABLE">(
    "FIXED",
  );
  const [minimumDollars, setMinimumDollars] = useState("");
  // Focused when Save is refused for an above-cap amount, so the caret lands
  // on the field the inline message is about.
  const minimumInputRef = useRef<ComponentRef<typeof TextInput>>(null);
  const suggestedInputRef = useRef<ComponentRef<typeof TextInput>>(null);
  const [suggestedDollars, setSuggestedDollars] = useState("");
  // Scheduled price change (FR-005) — collapsed by default.
  const [schedule, setSchedule] = useState<ScheduledPriceDraft>(
    emptyScheduledPriceDraft,
  );
  // Per-type sales window (FR-013) — collapsed by default, and unlike the
  // schedule it is NOT hidden in ADJUSTABLE mode: a window is about
  // sellability, not amount.
  const [salesWindow, setSalesWindow] = useState<SalesWindowDraft>(
    emptySalesWindowDraft,
  );
  // "Start from" preset selection. Purely a record of where the form STARTED —
  // it never travels to the server, and every field it filled stays editable.
  const [presetId, setPresetId] = useState<TicketTypePresetId>(
    TICKET_TYPE_PRESET_CUSTOM_ID,
  );
  /**
   * The last preset pick carried on-sale timing that could NOT be materialized
   * against this event (FR-016 drops, surfaced per FR-012). Drives the one-line
   * note under the window control — see `handleSelectPreset` for why silence
   * here would be a real trap rather than a tidy default.
   */
  const [presetTimingDropped, setPresetTimingDropped] = useState(false);

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editPriceDollars, setEditPriceDollars] = useState("");
  const [editCapacity, setEditCapacity] = useState("");
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [editResaleAllowed, setEditResaleAllowed] = useState(false);
  const [editResaleCapDollars, setEditResaleCapDollars] = useState("");
  const [editPricingMode, setEditPricingMode] = useState<
    "FIXED" | "ADJUSTABLE"
  >("FIXED");
  const [editMinimumDollars, setEditMinimumDollars] = useState("");
  const editMinimumInputRef = useRef<ComponentRef<typeof TextInput>>(null);
  const editSuggestedInputRef = useRef<ComponentRef<typeof TextInput>>(null);
  const [editSuggestedDollars, setEditSuggestedDollars] = useState("");
  const [editSchedule, setEditSchedule] = useState<ScheduledPriceDraft>(
    emptyScheduledPriceDraft,
  );
  /**
   * Has the organizer actually TOUCHED the schedule control on this edit?
   *
   * A data-safety latch, not a nicety. An UNTOUCHED control sends `undefined`
   * for both columns, so `updateTicketType`'s partial-update semantics leave
   * the stored pair exactly as it was; only a touched control sends values (or
   * the null pair). Same reasoning the resale gate documents below: dropping
   * the field preserves, forcing a value destroys.
   *
   * It matters because the seeded draft depends on `eventTimezone`, which can
   * still be in flight when the row is opened. Without the latch, a Save
   * during that window would submit an empty draft as `{ null, null }` and
   * silently DELETE a live scheduled price change on an edit the organizer
   * only meant as a rename. It also keeps the re-seed effect below free to
   * re-derive from the server row for as long as the control is untouched.
   */
  const [editScheduleTouched, setEditScheduleTouched] = useState(false);
  const [editSalesWindow, setEditSalesWindow] = useState<SalesWindowDraft>(
    emptySalesWindowDraft,
  );
  /**
   * The same data-safety latch as `editScheduleTouched`, for the window.
   *
   * Identical reasoning and identical stakes: an UNTOUCHED control sends
   * `undefined` for both bounds, so `updateTicketType`'s partial-update
   * semantics leave the stored window exactly as it was. Without it, a Save
   * during the window where `eventTimezone` is still in flight would submit an
   * empty draft as `{ null, null }` and silently DELETE a live sales window on
   * an edit the organizer only meant as a rename — putting a tier on sale that
   * was deliberately held back.
   */
  const [editSalesWindowTouched, setEditSalesWindowTouched] = useState(false);

  /**
   * ── ONE resolution per form, per control ────────────────────────────────
   *
   * These four memos are the single answer to "would this submit be refused,
   * and why". They feed THREE consumers that used to disagree:
   *
   *   1. the inline message inside the control (`problem`),
   *   2. the Add / Save button's `disabled` state,
   *   3. the submit handler itself.
   *
   * (3) has always refused correctly. (1) covered exactly one of the sales
   * window's five refusals and (2) knew about none of them, so an inverted
   * window rendered its error inline while the Add button stayed enabled —
   * the form telling the organizer, in the same breath, that the click will
   * fail and that they should make it. Resolving once removes the class.
   *
   * `now` is read at memo time and only reaches `isPast`, which is a WARNING
   * the submit ignores; nothing below is time-sensitive.
   */
  const addScheduleResolution = useMemo(
    () =>
      // ADJUSTABLE hides the control and sends the null pair — nothing to
      // refuse. Mirrors the same branch in `handleAdd`, which consumes this.
      pricingMode === "ADJUSTABLE"
        ? null
        : resolveScheduledPriceChange(schedule, {
            timeZone: eventTimezone ?? "",
            readAmount: resolveTicketAmountField,
            now: new Date(),
          }),
    [pricingMode, schedule, eventTimezone],
  );

  const addWindowResolution = useMemo(
    () => resolveSalesWindow(salesWindow, { timeZone: eventTimezone ?? "" }),
    [salesWindow, eventTimezone],
  );

  /**
   * The edit path's copies, gated on the SAME `touched` latches the submit
   * uses. An untouched control sends `undefined` and is never validated, so
   * blocking Save on it would strand an organizer who only wanted to rename a
   * tier — and would do it over a stored value they never edited.
   */
  const editScheduleResolution = useMemo(() => {
    if (!editScheduleTouched) return null;
    // Switching to Pay What You Want removes the flip rather than refusing it.
    if (editPricingMode === "ADJUSTABLE") {
      return {
        kind: "unset",
        scheduledPriceCents: null,
        scheduledPriceAt: null,
      } as const;
    }
    return resolveScheduledPriceChange(editSchedule, {
      timeZone: eventTimezone ?? "",
      readAmount: resolveTicketAmountField,
      now: new Date(),
    });
  }, [editScheduleTouched, editPricingMode, editSchedule, eventTimezone]);

  const editWindowResolution = useMemo(
    () =>
      editSalesWindowTouched
        ? resolveSalesWindow(editSalesWindow, {
            timeZone: eventTimezone ?? "",
          })
        : null,
    [editSalesWindowTouched, editSalesWindow, eventTimezone],
  );

  // Delete state — id of the row showing the inline "confirm delete" prompt.
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(
    null,
  );
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const handleDelete = useCallback(
    async (tt: { id: string; name: string }) => {
      setDeletingId(tt.id);
      try {
        await deleteMutation.mutateAsync({ ticketTypeId: tt.id });
        setConfirmingDeleteId(null);
        toast.success({
          id: "ticket-type-deleted",
          title: t("admin.ttDeletedTitle") as string,
          message: t("admin.ttDeletedMessage", { name: tt.name }) as string,
        });
      } catch (error) {
        const hasSales = getAppErrorCode(error) === "TICKET_TYPE_HAS_SALES";
        toast.danger({
          id: "ticket-type-delete-failed",
          title: hasSales
            ? (t("admin.ttDeleteHasSalesTitle") as string)
            : (t("admin.ttDeleteFailed") as string),
          message: hasSales
            ? (t("admin.ttDeleteHasSalesMessage") as string)
            : formatErrorMessage(error, t),
        });
      } finally {
        setDeletingId(null);
      }
    },
    [deleteMutation, toast, t],
  );

  // ── Create default GA ticket ──────────────────────────────────────────
  const [isCreatingGA, setIsCreatingGA] = useState(false);

  const handleCreateDefaultGA = useCallback(async () => {
    setIsCreatingGA(true);
    try {
      await upsertMutation.mutateAsync({
        eventId,
        name: "General Admission",
        priceCents: 0,
        capacity: 100,
        clientKey: nanoid(12),
        resaleAllowed: false,
        resaleCapCents: null,
      });
      toast.success({
        id: "ga-ticket-created",
        title: t("admin.ttAddedTitle") as string,
        message: t("admin.ttAddedMessage", {
          name: "General Admission",
        }) as string,
      });
    } catch (error) {
      toast.danger({
        id: "ga-ticket-failed",
        title: t("admin.ttAddFailed") as string,
        message: formatErrorMessage(error, t),
      });
    } finally {
      setIsCreatingGA(false);
    }
  }, [eventId, upsertMutation, toast, t]);

  /**
   * `resolveTicketAmountField` + this editor's error-toast idiom.
   *
   * Three-way return, because "blank" is not the caller's problem to detect:
   *   number    → the amount in cents
   *   null      → the field was blank; the CALLER decides what blank means
   *               (a blank price is a free ticket, a blank cap is "no cap")
   *   undefined → unreadable; a toast has been shown, ABORT THE SUBMIT
   */
  const parseAmountField = useCallback(
    (
      raw: string,
      toastId: string,
      copy: "price" | "amount",
    ): number | null | undefined => {
      const field = resolveTicketAmountField(raw, copy);
      if (field.kind === "cents") return field.cents;
      if (field.kind === "blank") return null;
      toast.danger({
        id: toastId,
        title: t(field.titleKey) as string,
        message: t(field.messageKey) as string,
      });
      return undefined;
    },
    [toast, t],
  );

  const handleAdd = useCallback(async () => {
    // Re-entrancy guard: the Add button is disabled while `isAdding`, but the
    // capacity field's Enter handler (`onSubmitEditing`) bypasses that, so a
    // second Enter while the upsert is still in flight would fire a duplicate
    // create with a fresh clientKey. The ref blocks same-tick re-entry; the
    // state covers later ticks (and drives the disabled UI).
    if (isAddingRef.current || isAdding) return;
    if (!name.trim() || !capacity.trim()) return;

    // Gate-off hard floor: the toggle UI is hidden when `resale` is off, so
    // never let previously-toggled state ride along on a new ticket.
    const effectiveResaleAllowed = resaleEnabled && resaleAllowed;
    const isAdjustable = pricingMode === "ADJUSTABLE";

    // Each parse below is gated on EXACTLY the condition that decides whether
    // its value is submitted (see mutateAsync). They have to stay in lockstep:
    // parsing a field whose value is discarded means an organiser can be
    // blocked by an error toast naming a field that isn't on screen — e.g.
    // tick Allow resale, type a bad cap, switch to Pay What You Want (which
    // hides the cap and sends null for it), then get refused by the cap.
    // Blank stays `null` (= "not set"), exactly as before.

    // A blank price is a free ticket — the only field here where blank means 0.
    // ADJUSTABLE hides Price entirely and submits 0, so there's nothing to read.
    const parsedPrice = isAdjustable
      ? null
      : parseAmountField(priceDollars, "ticket-price-invalid", "price");
    if (parsedPrice === undefined) return;
    const priceCents = parsedPrice ?? 0;

    const capacityNum = parseInt(capacity, 10);
    if (isNaN(capacityNum) || capacityNum < 1) {
      toast.danger({
        id: "ticket-capacity-invalid",
        title: t("admin.ttInvalidCapacityTitle") as string,
        message: t("admin.ttInvalidCapacityMessage") as string,
      });
      return;
    }

    const resaleCapCents =
      effectiveResaleAllowed && !isAdjustable
        ? parseAmountField(
            resaleCapDollars,
            "ticket-resale-cap-invalid",
            "amount",
          )
        : null;
    if (resaleCapCents === undefined) return;

    const minCents = isAdjustable
      ? parseAmountField(minimumDollars, "ticket-minimum-invalid", "amount")
      : null;
    if (minCents === undefined) return;

    const sugCents = isAdjustable
      ? parseAmountField(suggestedDollars, "ticket-suggested-invalid", "amount")
      : null;
    if (sugCents === undefined) return;
    // Above the per-ticket cap: the inline message under the field already
    // says so, and the server would refuse it — don't send it.
    if (
      (minCents ?? 0) > MAX_DONATION_AMOUNT_CENTS ||
      (sugCents ?? 0) > MAX_DONATION_AMOUNT_CENTS
    ) {
      ((minCents ?? 0) > MAX_DONATION_AMOUNT_CENTS
        ? minimumInputRef
        : suggestedInputRef
      ).current?.focus();
      return;
    }

    // Scheduled price change (FR-005). ADJUSTABLE hides the control and sends
    // the null PAIR — a buyer-chosen price has nothing to flip — matching how
    // resale and the fixed price are clamped for that mode; `addScheduleResolution`
    // is `null` in exactly that case.
    //
    // Read from the memo rather than re-resolved here: the Add button's
    // disabled state is computed from the same value, so the two cannot drift
    // into "the button says go, the handler says stop".
    const scheduled =
      addScheduleResolution ??
      ({
        kind: "unset",
        scheduledPriceCents: null,
        scheduledPriceAt: null,
      } as const);
    if (scheduled.kind === "error") {
      toast.danger({
        id: "ticket-schedule-invalid",
        title: t(scheduled.titleKey) as string,
        message: t(scheduled.messageKey) as string,
      });
      return;
    }

    // Sales window (FR-013). Deliberately NOT gated on `isAdjustable`: a
    // pay-what-you-can tier that only opens at doors-time is coherent, and
    // `upsertTicketType` does not clear the window for ADJUSTABLE the way it
    // clears the door and scheduled prices.
    // NOT named `window`: this is a "use client" module, and shadowing the DOM
    // global for forty lines is how the next person adding a
    // `window.matchMedia` in here gets a baffling type error. The edit path's
    // equivalent is `editWindow` for the same reason.
    //
    // From the memo, for the same reason as the schedule above: the button and
    // the handler must be looking at one answer.
    const resolvedWindow = addWindowResolution;
    if (resolvedWindow.kind === "error") {
      toast.danger({
        id: "ticket-window-invalid",
        title: t(resolvedWindow.titleKey) as string,
        message: t(resolvedWindow.messageKey) as string,
      });
      return;
    }

    isAddingRef.current = true;
    setIsAdding(true);
    try {
      await upsertMutation.mutateAsync({
        eventId,
        name: name.trim(),
        priceCents: isAdjustable ? 0 : priceCents,
        pricingMode,
        minimumCents: minCents,
        suggestedCents: sugCents,
        capacity: capacityNum,
        clientKey: nanoid(12),
        resaleAllowed: isAdjustable ? false : effectiveResaleAllowed,
        resaleCapCents:
          effectiveResaleAllowed && !isAdjustable ? resaleCapCents : null,
        // Always BOTH, never one: on create the pair is either two values or
        // two nulls, so TICKET_TYPE_SCHEDULE_INCOMPLETE is unreachable.
        scheduledPriceCents: scheduled.scheduledPriceCents,
        scheduledPriceAt: scheduled.scheduledPriceAt,
        // NFR-001, spread rather than sent as explicit nulls: a tier with no
        // window sends the payload it sent before this feature existed, key for
        // key. (The schema defaults both to null, so the stored row would be
        // identical either way — but "identical payload" is the property worth
        // being able to assert, and it keeps the idempotency payload hash of a
        // replayed create from depending on which build wrote it.) The two
        // bounds are INDEPENDENT, so either may still be null inside a `set`.
        ...(resolvedWindow.kind === "set"
          ? {
              salesOpenAt: resolvedWindow.salesOpenAt,
              salesCloseAt: resolvedWindow.salesCloseAt,
            }
          : {}),
      });

      // Reset form
      setName("");
      setPriceDollars("");
      setCapacity("");
      setShowForm(false);
      setResaleAllowed(false);
      setResaleCapDollars("");
      setPricingMode("FIXED");
      setMinimumDollars("");
      setSuggestedDollars("");
      setSchedule(emptyScheduledPriceDraft());
      setSalesWindow(emptySalesWindowDraft());
      setPresetId(TICKET_TYPE_PRESET_CUSTOM_ID);
      setStripeRequired(false);

      toast.success({
        id: "ticket-type-added",
        title: t("admin.ttAddedTitle") as string,
        message: t("admin.ttAddedMessage", { name: name.trim() }) as string,
      });
    } catch (error) {
      const message = formatErrorMessage(error, t);
      const code = getAppErrorCode(error);
      const isStripeError = code === "PAID_TICKETING_REQUIRES_STRIPE";
      const isNameTaken = code === "TICKET_TYPE_NAME_TAKEN";
      // Belt-and-braces: `resolveScheduledPriceChange` never emits a
      // half-configured pair, so this branch should be unreachable. It exists
      // so a future caller/regression surfaces the named code as its own copy
      // instead of the generic "Failed to add" fallback.
      const isScheduleIncomplete = code === "TICKET_TYPE_SCHEDULE_INCOMPLETE";
      // Likewise unreachable through this form — `resolveSalesWindow` refuses
      // an inverted or zero-width pair before the submit starts — and kept for
      // the same reason: a future caller or regression gets the named copy
      // instead of the generic "Failed to add".
      const isWindowInvalid = code === "TICKET_TYPE_SALES_WINDOW_INVALID";
      setStripeRequired(isStripeError);
      toast.danger({
        id: "ticket-type-failed",
        title: isStripeError
          ? (t("admin.ttStripeRequired") as string)
          : isScheduleIncomplete
            ? (t("admin.ttScheduleIncompleteTitle") as string)
            : isWindowInvalid
              ? (t("admin.ttWindowInvalidTitle") as string)
              : isNameTaken
                ? ((t("admin.ttNameTaken", { name: name.trim() }) as string) ??
                  "Name already taken")
                : (t("admin.ttAddFailed") as string),
        message: isScheduleIncomplete
          ? (t("errors.ticketTypeScheduleIncomplete") as string)
          : isWindowInvalid
            ? (t("errors.ticketTypeSalesWindowInvalid") as string)
            : message,
      });
    } finally {
      isAddingRef.current = false;
      setIsAdding(false);
    }
  }, [
    addScheduleResolution,
    addWindowResolution,
    capacity,
    eventId,
    isAdding,
    minimumDollars,
    name,
    parseAmountField,
    priceDollars,
    pricingMode,
    resaleAllowed,
    resaleCapDollars,
    resaleEnabled,
    suggestedDollars,
    toast,
    t,
    upsertMutation,
  ]);

  const handleStartEdit = useCallback(
    (tt: {
      id: string;
      name: string;
      priceCents: number;
      capacity: number;
      resaleAllowed: boolean;
      resaleCapCents: number | null;
      pricingMode?: string;
      minimumCents?: number | null;
      suggestedCents?: number | null;
      /** The stored schedule pair, for Q-002's re-open read-back. */
      scheduledPriceCents?: number | null;
      scheduledPriceAt?: string | Date | null;
      /** The stored window bounds (FR-013), independently nullable. */
      salesOpenAt?: string | Date | null;
      salesCloseAt?: string | Date | null;
    }) => {
      setEditingId(tt.id);
      setEditName(tt.name);
      const mode = (tt.pricingMode ?? "FIXED") as "FIXED" | "ADJUSTABLE";
      setEditPricingMode(mode);
      setEditPriceDollars(
        mode === "ADJUSTABLE"
          ? "0"
          : tt.priceCents === 0
            ? "0"
            : (tt.priceCents / 100).toFixed(2),
      );
      setEditCapacity(String(tt.capacity));
      setEditResaleAllowed(tt.resaleAllowed);
      setEditResaleCapDollars(
        tt.resaleCapCents != null ? (tt.resaleCapCents / 100).toFixed(2) : "",
      );
      setEditMinimumDollars(
        tt.minimumCents != null && tt.minimumCents > 0
          ? (tt.minimumCents / 100).toFixed(2)
          : "",
      );
      setEditSuggestedDollars(
        tt.suggestedCents != null && tt.suggestedCents > 0
          ? (tt.suggestedCents / 100).toFixed(2)
          : "",
      );
      // Only seed once the EVENT's timezone is known — never against a
      // fallback zone, which would show the organizer a wall clock that isn't
      // the one the flip actually fires on. Until then the control is disabled
      // and the effect above fills it in the moment the timezone lands.
      setEditSchedule(
        eventTimezone
          ? scheduledPriceDraftFromTicketType(tt, eventTimezone)
          : emptyScheduledPriceDraft(),
      );
      setEditScheduleTouched(false);
      // Same seed-only-once-the-zone-is-known rule as the schedule above: a
      // window rendered against a fallback zone would show the organizer a wall
      // clock that is not the one sales actually open on.
      setEditSalesWindow(
        eventTimezone
          ? salesWindowDraftFromTicketType(tt, eventTimezone)
          : emptySalesWindowDraft(),
      );
      setEditSalesWindowTouched(false);
      // Close the add form if open
      setShowForm(false);
    },
    [eventTimezone],
  );

  const handleCancelEdit = useCallback(() => {
    setEditingId(null);
    setEditName("");
    setEditPriceDollars("");
    setEditCapacity("");
    setEditResaleAllowed(false);
    setEditResaleCapDollars("");
    setEditPricingMode("FIXED");
    setEditMinimumDollars("");
    setEditSuggestedDollars("");
    setEditSchedule(emptyScheduledPriceDraft());
    setEditScheduleTouched(false);
    setEditSalesWindow(emptySalesWindowDraft());
    setEditSalesWindowTouched(false);
  }, []);

  // `disabled` follows a refetched ticketsSold, so it can flip on while a form
  // or delete confirmation is open. Close them: pointer-events:none does not
  // stop Tab/Enter from reaching Save or Delete-confirm.
  useEffect(() => {
    if (!disabled) return;
    handleCancelEdit();
    setShowForm(false);
    setConfirmingDeleteId(null);
    setStripeRequired(false);
  }, [disabled, handleCancelEdit]);

  const handleSaveEdit = useCallback(async () => {
    if (!editingId || !editName.trim() || !editCapacity.trim()) return;

    const isAdjustable = editPricingMode === "ADJUSTABLE";

    // As in handleAdd: every parse below is gated on EXACTLY the condition that
    // decides whether its value is submitted, so no organiser is ever refused
    // over a field that isn't on screen and isn't being sent.

    // A blank price is a free ticket — the only field here where blank means 0.
    // ADJUSTABLE hides Price entirely and submits 0, so there's nothing to read.
    const parsedPrice = isAdjustable
      ? null
      : parseAmountField(
          editPriceDollars,
          "edit-ticket-price-invalid",
          "price",
        );
    if (parsedPrice === undefined) return;
    const priceCents = parsedPrice ?? 0;

    const capacityNum = parseInt(editCapacity, 10);
    if (isNaN(capacityNum) || capacityNum < 1) {
      toast.danger({
        id: "edit-ticket-capacity-invalid",
        title: t("admin.ttInvalidCapacityTitle") as string,
        message: t("admin.ttInvalidCapacityMessage") as string,
      });
      return;
    }

    // NOTE (resale gate): when the `resale` gate is off the toggle/cap UI is
    // hidden, so `editResaleAllowed`/`editResaleCapDollars` still hold the
    // server-seeded values from handleStartEdit. Passing them through
    // unchanged deliberately PRESERVES existing tickets' resale settings —
    // gating is display-layer only, never a silent data rewrite.
    const resaleCapCents =
      editResaleAllowed && !isAdjustable
        ? parseAmountField(
            editResaleCapDollars,
            "edit-ticket-resale-cap-invalid",
            "amount",
          )
        : null;
    if (resaleCapCents === undefined) return;

    const editMinCents = isAdjustable
      ? parseAmountField(
          editMinimumDollars,
          "edit-ticket-minimum-invalid",
          "amount",
        )
      : null;
    if (editMinCents === undefined) return;

    const editSugCents = isAdjustable
      ? parseAmountField(
          editSuggestedDollars,
          "edit-ticket-suggested-invalid",
          "amount",
        )
      : null;
    if (editSugCents === undefined) return;
    // Above the per-ticket cap: shown inline under the field; never sent.
    if (
      (editMinCents ?? 0) > MAX_DONATION_AMOUNT_CENTS ||
      (editSugCents ?? 0) > MAX_DONATION_AMOUNT_CENTS
    ) {
      ((editMinCents ?? 0) > MAX_DONATION_AMOUNT_CENTS
        ? editMinimumInputRef
        : editSuggestedInputRef
      ).current?.focus();
      return;
    }

    // Scheduled price change (FR-005), with the partial-update semantics the
    // `editScheduleTouched` doc above explains: UNTOUCHED sends `undefined`
    // for BOTH fields (stored pair preserved), TOUCHED sends the resolved
    // pair — two values or two nulls, never one.
    //
    // Read from `editScheduleResolution`, which encodes those three cases
    // (untouched → null, touched+ADJUSTABLE → the cleared pair, touched+FIXED →
    // the resolved draft) and also drives the Save button's disabled state, so
    // the button can never invite a click this handler will refuse.
    const editScheduled = editScheduleResolution;
    if (editScheduled?.kind === "error") {
      toast.danger({
        id: "edit-ticket-schedule-invalid",
        title: t(editScheduled.titleKey) as string,
        message: t(editScheduled.messageKey) as string,
      });
      return;
    }

    // Sales window (FR-013), with the same partial-update semantics: UNTOUCHED
    // sends `undefined` for BOTH bounds (stored window preserved), TOUCHED
    // sends the resolved pair — where either bound may legitimately be null on
    // its own. No ADJUSTABLE branch, unlike the schedule: switching to Pay What
    // You Want does not remove a window, because a window is not a price.
    const editWindow = editWindowResolution;
    if (editWindow?.kind === "error") {
      toast.danger({
        id: "edit-ticket-window-invalid",
        title: t(editWindow.titleKey) as string,
        message: t(editWindow.messageKey) as string,
      });
      return;
    }

    setIsSavingEdit(true);
    try {
      await updateMutation.mutateAsync({
        ticketTypeId: editingId,
        name: editName.trim(),
        priceCents: isAdjustable ? 0 : priceCents,
        pricingMode: editPricingMode,
        minimumCents: editMinCents,
        suggestedCents: editSugCents,
        capacity: capacityNum,
        resaleAllowed: isAdjustable ? false : editResaleAllowed,
        resaleCapCents:
          editResaleAllowed && !isAdjustable ? resaleCapCents : null,
        // `undefined` = leave the stored pair alone (untouched control).
        scheduledPriceCents: editScheduled?.scheduledPriceCents,
        scheduledPriceAt: editScheduled?.scheduledPriceAt,
        // Same contract for the window: `undefined` preserves, `null` clears
        // THAT BOUND ONLY. Clearing one and keeping the other is a supported
        // edit, not a half-configuration.
        salesOpenAt: editWindow?.salesOpenAt,
        salesCloseAt: editWindow?.salesCloseAt,
      });

      toast.success({
        id: "ticket-type-updated",
        title: t("admin.ttUpdatedTitle") as string,
        message: t("admin.ttUpdatedMessage", {
          name: editName.trim(),
        }) as string,
      });

      setStripeRequired(false);
      handleCancelEdit();
    } catch (error) {
      const code = getAppErrorCode(error);
      const isStripeError = code === "PAID_TICKETING_REQUIRES_STRIPE";
      // Unreachable via this form (see the matching note in handleAdd), kept
      // so the named code never degrades to the generic failure copy.
      const isScheduleIncomplete = code === "TICKET_TYPE_SCHEDULE_INCOMPLETE";
      // Reachable in principle where the add path's is not: `updateTicketType`
      // validates the MERGED pair, so clearing only the OPEN bound on a row
      // whose stored CLOSE bound is earlier would be refused server-side. The
      // form's own check reads the same merged draft, so it should catch it
      // first — this is the backstop that keeps the named code from degrading
      // to "Failed to update".
      const isWindowInvalid = code === "TICKET_TYPE_SALES_WINDOW_INVALID";
      setStripeRequired(isStripeError);
      toast.danger({
        id: "ticket-type-update-failed",
        title: isStripeError
          ? (t("admin.ttStripeRequired") as string)
          : isScheduleIncomplete
            ? (t("admin.ttScheduleIncompleteTitle") as string)
            : isWindowInvalid
              ? (t("admin.ttWindowInvalidTitle") as string)
              : (t("admin.ttUpdateFailed") as string),
        message: isScheduleIncomplete
          ? (t("errors.ticketTypeScheduleIncomplete") as string)
          : isWindowInvalid
            ? (t("errors.ticketTypeSalesWindowInvalid") as string)
            : formatErrorMessage(error, t),
      });
    } finally {
      setIsSavingEdit(false);
    }
  }, [
    editCapacity,
    editMinimumDollars,
    editName,
    editPriceDollars,
    editPricingMode,
    editResaleAllowed,
    editResaleCapDollars,
    editScheduleResolution,
    editSuggestedDollars,
    editWindowResolution,
    editingId,
    handleCancelEdit,
    parseAmountField,
    toast,
    t,
    updateMutation,
  ]);

  // Memoized so the `?? []` doesn't mint a new array on every render: the
  // re-seed effect below depends on this, and an unstable identity would make
  // it run on every render (React's exhaustive-deps lint flags exactly this).
  const ticketTypes = useMemo(
    () => ticketTypesQuery.data?.ticketTypes ?? [],
    [ticketTypesQuery.data?.ticketTypes],
  );

  // Re-seed the schedule draft from the server row for as long as the
  // organizer hasn't touched the control.
  //
  // `handleStartEdit` seeds on click, but the wall clock it displays is only
  // correct once `eventTimezone` has arrived — and the click can beat the
  // query. Rather than render a stored instant on the WRONG clock (which would
  // make the read-back actively misleading, the one thing FR-007 can't
  // tolerate), the seed is re-derived whenever the timezone or the row
  // changes. `editScheduleTouched` stops it from ever clobbering typing.
  useEffect(() => {
    if (!editingId || editScheduleTouched || !eventTimezone) return;
    const row = ticketTypes.find((tt) => tt.id === editingId);
    if (!row) return;
    // Idempotent by VALUE, not by reference. `ticketTypes` is derived from the
    // query with a `?? []`, so its identity is not guaranteed stable across
    // renders; setting a freshly-built object unconditionally would re-render,
    // re-run this effect, and spin. Returning `prev` unchanged makes React
    // bail out, so an unstable dep costs a comparison rather than a hang.
    setEditSchedule((prev) => {
      const next = scheduledPriceDraftFromTicketType(row, eventTimezone);
      return prev.enabled === next.enabled &&
        prev.priceDollars === next.priceDollars &&
        prev.atLocal === next.atLocal
        ? prev
        : next;
    });
  }, [editingId, editScheduleTouched, eventTimezone, ticketTypes]);

  // The window's copy of the same re-seed, for the same reason: `handleStartEdit`
  // can beat the `getEventForEdit` query, and a bound rendered on a fallback
  // clock is worse than one not rendered yet. Idempotent BY VALUE so an
  // unstable `ticketTypes` identity costs a comparison rather than a spin.
  useEffect(() => {
    if (!editingId || editSalesWindowTouched || !eventTimezone) return;
    const row = ticketTypes.find((tt) => tt.id === editingId);
    if (!row) return;
    setEditSalesWindow((prev) => {
      const next = salesWindowDraftFromTicketType(row, eventTimezone);
      return prev.enabled === next.enabled &&
        prev.openLocal === next.openLocal &&
        prev.closeLocal === next.closeLocal
        ? prev
        : next;
    });
  }, [editingId, editSalesWindowTouched, eventTimezone, ticketTypes]);

  const formatPrice = (cents: number) => {
    if (cents === 0) return t("admin.ttFree") as string;
    return fmtCurrency(fmt, cents, "usd");
  };

  /**
   * The persisted half of Q-002's read-back: what a SAVED schedule says on the
   * ticket list, without opening the editor.
   *
   * Returns null unless the row carries a complete pair AND the event timezone
   * is known — a schedule shown on the wrong clock is worse than one not shown
   * at all, since the read-back is the organizer's only verification surface.
   *
   * TENSE FOLLOWS THE CLOCK. An elapsed flip reads "Changed to $20 on …", not
   * "Changes to …" — the in-form control has `ttSchedulePastWarning` for this,
   * and a row promising a future change that already happened would contradict
   * the headline price sitting directly above it.
   */
  const scheduleSummary = (tt: {
    scheduledPriceCents?: number | null;
    scheduledPriceAt?: string | Date | null;
  }): string | null => {
    // `== null`, never falsy: a scheduled price of 0 is a real "free after T".
    if (tt.scheduledPriceCents == null || tt.scheduledPriceAt == null) {
      return null;
    }
    if (!eventTimezone) return null;
    const at =
      tt.scheduledPriceAt instanceof Date
        ? tt.scheduledPriceAt.toISOString()
        : tt.scheduledPriceAt;
    const when = formatZonedInstant(at, eventTimezone, fmt.dateTime);
    if (!when) return null;
    // Inclusive at T, matching the resolver: at T the new price is live.
    const hasApplied = new Date(at).getTime() <= Date.now();
    return String(
      t(
        hasApplied
          ? "admin.ttScheduleReadbackApplied"
          : "admin.ttScheduleReadback",
        {
          price: fmtCurrency(fmt, tt.scheduledPriceCents, eventCurrency),
          when,
        },
      ),
    );
  };

  /**
   * The persisted read-back for the sales WINDOW — what a saved window says on
   * the ticket list, without opening the editor (FR-013's acceptance).
   *
   * Same withhold-rather-than-mislead rule as `scheduleSummary`: null until the
   * event's timezone is known, because the zone abbreviation is the whole point
   * of the line. The pure helper picks the key (range / from / until / ended)
   * and pre-formats the instants; this only translates.
   */
  const windowSummary = (tt: {
    salesOpenAt?: string | Date | null;
    salesCloseAt?: string | Date | null;
  }): string | null => {
    const summary = describeSalesWindow(
      tt,
      eventTimezone,
      fmt.dateTime,
      new Date(),
    );
    if (!summary) return null;
    return String(t(summary.key, summary.values));
  };

  // ── Mobile card meta line ──────────────────────────────────────────────
  // Compact, single-string summary for the stacked card on phones. Reuses the
  // same formatters/labels as the desktop row so there's one source of truth.
  const ticketCardMeta = (tt: (typeof ticketTypes)[number]) =>
    buildTicketCardMeta(
      tt,
      formatPrice,
      (capacity) => String(t("admin.ttCapacityCount", { capacity })),
      {
        resaleEnabled,
        wasLabel: (price) => String(t("admin.ttPriceWas", { price })),
      },
    );

  // ── Shared edit-form pieces ────────────────────────────────────────────
  // Extracted so the SAME body/footer renders inline on desktop and inside the
  // EventEditorSheet (full-screen sheet) on mobile, keeping desktop unchanged.
  // Footers are shared between desktop (inline) and mobile (sheet). Buttons grow
  // to a 44px touch target on mobile; desktop keeps the original compact $2 size.
  const footerBtnSize = isMobile ? "$3" : "$2";

  /**
   * A form showing a refusal must not also invite the click that trips it.
   *
   * The two timing panels are the only fields here that can be individually
   * WRONG rather than merely empty, and until this existed they were invisible
   * to the footer: an inverted sales window rendered its inline error and left
   * Add fully enabled, so the organizer's next move was a button press the
   * handler had already decided to reject. Empty name / capacity have always
   * disabled the button; this is the same contract extended to the fields that
   * grew an error state later.
   *
   * The disabled button is the SECOND signal, never the only one — every
   * refusal counted here is rendered inline in its own panel, so a dead button
   * always has an explanation a few lines above it.
   */
  const addBlocked =
    addScheduleResolution?.kind === "error" ||
    addWindowResolution.kind === "error";
  const editBlocked =
    editScheduleResolution?.kind === "error" ||
    editWindowResolution?.kind === "error";

  /** Narrowed for the controls' inline copy — same objects as the gates above. */
  const addScheduleProblem =
    addScheduleResolution?.kind === "error" ? addScheduleResolution : null;
  const addWindowProblem =
    addWindowResolution.kind === "error" ? addWindowResolution : null;
  const editScheduleProblem =
    editScheduleResolution?.kind === "error" ? editScheduleResolution : null;
  const editWindowProblem =
    editWindowResolution?.kind === "error" ? editWindowResolution : null;

  const editFormFooter = (
    <XStack gap={8} justifyContent="flex-end">
      <Button
        variant="ghost"
        size={footerBtnSize}
        onPress={handleCancelEdit}
        borderRadius={0}
        data-testid="ticket-type-edit-cancel"
      >
        {String(t("admin.ttCancel"))}
      </Button>
      <Button
        variant="primary"
        size={footerBtnSize}
        onPress={() => {
          void handleSaveEdit();
        }}
        disabled={
          !editName.trim() ||
          !editCapacity.trim() ||
          isSavingEdit ||
          editBlocked
        }
        borderRadius={0}
        data-testid="ticket-type-edit-save"
      >
        <Check size={14} aria-hidden />
        {isSavingEdit ? String(t("admin.ttSaving")) : String(t("admin.ttSave"))}
      </Button>
    </XStack>
  );

  const editFormFields = (
    <YStack gap={12}>
      <YStack gap={4}>
        <Text
          variant="caption"
          tone="muted"
          style={{ textTransform: "uppercase" }}
        >
          {String(t("admin.ttName"))}
        </Text>
        <TextInput
          value={editName}
          onChangeText={(v: string) => setEditName(v)}
          placeholder={t("admin.ttNamePlaceholder") as string}
          maxLength={80}
          testId="ticket-type-edit-name"
        />
      </YStack>
      <XStack gap={16} flexWrap="wrap">
        {/* Pay What You Want has no list price — the buyer names it, within
            the minimum below — so the field is not shown and 0 is sent. */}
        {editPricingMode !== "ADJUSTABLE" && (
          <YStack gap={4} flex={1} minWidth={120}>
            <Text
              variant="caption"
              tone="muted"
              style={{ textTransform: "uppercase" }}
            >
              {String(t("admin.ttPrice"))}
            </Text>
            <TextInput
              value={editPriceDollars}
              onChangeText={(v: string) => setEditPriceDollars(v)}
              placeholder="0.00"
              keyboardType="numeric"
              testId="ticket-type-edit-price"
            />
          </YStack>
        )}
        <YStack gap={4} flex={1} minWidth={120}>
          <Text
            variant="caption"
            tone="muted"
            style={{ textTransform: "uppercase" }}
          >
            {String(t("admin.ttCapacity"))}
          </Text>
          <TextInput
            value={editCapacity}
            onChangeText={(v: string) => setEditCapacity(v)}
            placeholder="100"
            keyboardType="numeric"
            testId="ticket-type-edit-capacity"
            onSubmitEditing={() => {
              void handleSaveEdit();
            }}
            returnKeyType="done"
          />
        </YStack>
      </XStack>
      {/* Pricing mode toggle */}
      <YStack gap={8}>
        <Text
          variant="caption"
          tone="muted"
          style={{ textTransform: "uppercase" }}
        >
          Pricing
        </Text>
        <XStack
          gap={0}
          borderWidth={2}
          borderColor="$borderColor"
          alignSelf="flex-start"
        >
          <XStack
            paddingHorizontal={12}
            paddingVertical={8}
            cursor="pointer"
            backgroundColor={
              editPricingMode === "FIXED" ? "$accent" : "transparent"
            }
            borderRightWidth={1}
            borderRightColor="$borderColor"
            onPress={() => setEditPricingMode("FIXED")}
          >
            <Text
              variant="caption"
              color={
                editPricingMode === "FIXED"
                  ? "$onBrandSecondary"
                  : "$colorMuted"
              }
              weight={editPricingMode === "FIXED" ? "semibold" : undefined}
            >
              Fixed Price
            </Text>
          </XStack>
          <XStack
            paddingHorizontal={12}
            paddingVertical={8}
            cursor="pointer"
            backgroundColor={
              editPricingMode === "ADJUSTABLE" ? "$accent" : "transparent"
            }
            onPress={() => setEditPricingMode("ADJUSTABLE")}
          >
            <Text
              variant="caption"
              color={
                editPricingMode === "ADJUSTABLE"
                  ? "$onBrandSecondary"
                  : "$colorMuted"
              }
              weight={editPricingMode === "ADJUSTABLE" ? "semibold" : undefined}
            >
              Pay What You Want
            </Text>
          </XStack>
        </XStack>
      </YStack>
      {editPricingMode === "ADJUSTABLE" && (
        <XStack gap={16} flexWrap="wrap">
          <YStack gap={4} flex={1} minWidth={120}>
            <Text
              variant="caption"
              tone="muted"
              style={{ textTransform: "uppercase" }}
            >
              Minimum ($)
            </Text>
            <TextInput
              value={editMinimumDollars}
              onChangeText={(v: string) => setEditMinimumDollars(v)}
              placeholder="0.00"
              keyboardType="numeric"
              testId="ticket-type-edit-minimum"
              ref={editMinimumInputRef}
              aria-invalid={isAbovePwywCap(editMinimumDollars) || undefined}
              aria-describedby={
                isAbovePwywCap(editMinimumDollars) ? "ticket-type-edit-minimum-above-cap" : undefined
              }
            />
            {isAbovePwywCap(editMinimumDollars) && (
              <Text
                variant="caption"
                role="alert"
                color="$danger"
                style={{ fontSize: 11 }}
                id="ticket-type-edit-minimum-above-cap"
                data-testid="ticket-type-edit-minimum-above-cap"
              >
                {String(
                t("admin.ttPwywAboveCap", {
                  max: fmtCurrency(fmt, MAX_DONATION_AMOUNT_CENTS, eventCurrency),
                }),
              )}
              </Text>
            )}
          </YStack>
          <YStack gap={4} flex={1} minWidth={120}>
            <Text
              variant="caption"
              tone="muted"
              style={{ textTransform: "uppercase" }}
            >
              Suggested ($)
            </Text>
            <TextInput
              value={editSuggestedDollars}
              onChangeText={(v: string) => setEditSuggestedDollars(v)}
              placeholder="10.00"
              keyboardType="numeric"
              testId="ticket-type-edit-suggested"
              ref={editSuggestedInputRef}
              aria-invalid={isAbovePwywCap(editSuggestedDollars) || undefined}
              aria-describedby={
                isAbovePwywCap(editSuggestedDollars) ? "ticket-type-edit-suggested-above-cap" : undefined
              }
            />
            {isAbovePwywCap(editSuggestedDollars) && (
              <Text
                variant="caption"
                role="alert"
                color="$danger"
                style={{ fontSize: 11 }}
                id="ticket-type-edit-suggested-above-cap"
                data-testid="ticket-type-edit-suggested-above-cap"
              >
                {String(
                t("admin.ttPwywAboveCap", {
                  max: fmtCurrency(fmt, MAX_DONATION_AMOUNT_CENTS, eventCurrency),
                }),
              )}
              </Text>
            )}
          </YStack>
        </XStack>
      )}
      {editPricingMode === "ADJUSTABLE" && (
        <Text variant="caption" tone="muted" style={{ fontSize: 11 }}>
          Buyers choose their own amount. Non-refundable. Resale disabled.
        </Text>
      )}
      {/* Scheduled price change (FR-005) — FIXED only; a buyer-chosen price
          has nothing to flip to. */}
      {editPricingMode === "FIXED" && (
        <TicketScheduledPriceField
          idPrefix="edit"
          value={editSchedule}
          onChange={(next) => {
            setEditSchedule(next);
            setEditScheduleTouched(true);
          }}
          timeZone={eventTimezone}
          currency={eventCurrency}
          problem={editScheduleProblem}
          // The sales-window panel below carries the form's one zone footnote
          // whenever it is open; two copies of the same sentence a few lines
          // apart is a rendering bug, not emphasis.
          showZoneNote={!editSalesWindow.enabled}
          disabled={disabled}
        />
      )}
      {/* Sales window (FR-013) — NOT gated on pricing mode. A window says
          nothing about the amount, and `upsertTicketType` keeps it for
          ADJUSTABLE tiers, so hiding it here would strip a legitimate setting
          from every pay-what-you-can tier. */}
      <TicketSalesWindowField
        idPrefix="edit"
        value={editSalesWindow}
        onChange={(next) => {
          setEditSalesWindow(next);
          setEditSalesWindowTouched(true);
        }}
        timeZone={eventTimezone}
        problem={editWindowProblem}
        disabled={disabled}
      />
      {/* Resale settings — hidden entirely while the `resale` gate is off */}
      {resaleEnabled && editPricingMode === "FIXED" && (
        <YStack gap={8}>
          <XStack
            gap={8}
            alignItems="center"
            cursor="pointer"
            onPress={() => setEditResaleAllowed(!editResaleAllowed)}
            data-testid="ticket-type-edit-resale-toggle"
          >
            <XStack
              width={18}
              height={18}
              borderWidth={2}
              borderColor={editResaleAllowed ? "$accent" : "$borderColor"}
              borderRadius={0}
              alignItems="center"
              justifyContent="center"
              backgroundColor={
                editResaleAllowed ? "$accentSoft" : "transparent"
              }
            >
              {editResaleAllowed && (
                <Check size={12} color={theme.accent?.val} />
              )}
            </XStack>
            <Repeat size={13} color={theme.colorMuted?.val} />
            <Text variant="caption" color="$color">
              Allow resale
            </Text>
          </XStack>
          {editResaleAllowed && (
            <YStack gap={4} paddingLeft={26}>
              <Text
                variant="caption"
                tone="muted"
                style={{ textTransform: "uppercase" }}
              >
                Resale price cap ($)
              </Text>
              <TextInput
                value={editResaleCapDollars}
                onChangeText={(v: string) => setEditResaleCapDollars(v)}
                placeholder="No cap"
                keyboardType="numeric"
              />
              <Text variant="caption" tone="muted" style={{ fontSize: 11 }}>
                Leave blank for no cap. Sellers cannot list above this price,
                or above what their own ticket cost if that is higher.
              </Text>
            </YStack>
          )}
        </YStack>
      )}
    </YStack>
  );

  // ── Shared add-form pieces ─────────────────────────────────────────────

  /**
   * Fill the add form from a "Start from" preset. Presets own exactly the six
   * fields `applyPresetToForm` returns — resale is deliberately untouched (it
   * is feature-gated and a per-ticket decision, so a preset must never turn it
   * on), and picking "Custom (blank)" clears the same six back to empty.
   *
   * The two TIME controls (scheduled price change, sales window) follow the
   * FR-012 rule: a preset that CARRIES a relative offset seeds that control; a
   * preset that carries none — seven of the nine, including "Custom (blank)" —
   * leaves it exactly as it was. Clearing them unconditionally would silently
   * discard a flip the organizer had already configured merely because they
   * went back to browse the presets, destroying input the preset has nothing to
   * say about. (Switching to Pay What You Want DOES clear the schedule, but
   * that is a pricing-model change with no coherent "flip to" price, not a
   * pre-fill.)
   *
   * Resolution runs through `resolvePresetSchedulePrefill`, which delegates the
   * arithmetic to the SAME `@th/core` resolver `applyTicketTypeTemplate` uses,
   * and refuses (returns nothing to seed) unless BOTH the event's `startsAt`
   * and its `timezone` are known — never the browser's clock, per FR-007.
   * Q-003 (RESOLVED) says both are always known here, since this editor only
   * renders with an `eventId`; the guard exists so "cannot happen" never
   * degrades into "resolved against the wrong clock".
   *
   * The name is resolved through `t()` HERE, at selection time, so the name
   * that gets saved is in the organiser's locale.
   */
  const handleSelectPreset = useCallback(
    (preset: TicketTypePreset) => {
      const values = applyPresetToForm(preset, (key) => String(t(key)));
      setPresetId(preset.id);
      setName(values.name);
      setPriceDollars(values.priceDollars);
      setCapacity(values.capacity);
      setPricingMode(values.pricingMode);
      setMinimumDollars(values.minimumDollars);
      setSuggestedDollars(values.suggestedDollars);

      const prefill = resolvePresetSchedulePrefill(preset, {
        eventStartsAt: eventStartsAt ?? null,
        timeZone: eventTimezone,
        now: new Date(),
      });
      if (prefill.salesWindow) setSalesWindow(prefill.salesWindow);
      if (prefill.schedule) setSchedule(prefill.schedule);
      // A preset whose timing did not survive contact with this event's date
      // must SAY SO. The asymmetry that makes this load-bearing: an elapsed
      // `salesClose` is dropped while a lone elapsed `salesOpen` is kept by
      // design, so inside 24h of doors "Advance" seeds no close (it never
      // stops selling) while "Door" seeds an open in the past (it is already
      // live) — the two tiers then sell SIMULTANEOUSLY and every buyer takes
      // the cheaper advance. The shared handover constant guarantees no gap and
      // no overlap only while the event is more than a day out; inside that
      // window the guarantee inverts, and an un-ticked control is indis-
      // tinguishable from a preset that never had timing at all.
      setPresetTimingDropped(prefill.drops.length > 0);
    },
    [t, eventStartsAt, eventTimezone],
  );

  const resetAddForm = () => {
    setShowForm(false);
    setName("");
    setPriceDollars("");
    setCapacity("");
    setResaleAllowed(false);
    setResaleCapDollars("");
    setPricingMode("FIXED");
    setMinimumDollars("");
    setSuggestedDollars("");
    setSchedule(emptyScheduledPriceDraft());
    setSalesWindow(emptySalesWindowDraft());
    setPresetId(TICKET_TYPE_PRESET_CUSTOM_ID);
    setPresetTimingDropped(false);
  };

  const addFormFooter = (
    <XStack gap={8} justifyContent="flex-end">
      <Button
        variant="ghost"
        size={footerBtnSize}
        onPress={resetAddForm}
        borderRadius={0}
        data-testid="ticket-type-add-cancel"
      >
        {String(t("admin.ttCancel"))}
      </Button>
      <Button
        variant="primary"
        size={footerBtnSize}
        onPress={() => {
          void handleAdd();
        }}
        disabled={!name.trim() || !capacity.trim() || isAdding || addBlocked}
        borderRadius={0}
        data-testid="ticket-type-add-submit"
      >
        {isAdding ? String(t("admin.ttAdding")) : String(t("admin.ttAdd"))}
      </Button>
    </XStack>
  );

  // Prototype field widths: a money box the width of the card reads as an empty
  // bar and tells the organiser nothing about what belongs in it. Applied on
  // desktop only — inside the mobile sheet the fields keep their existing
  // flex/full-width behaviour so they stay at the 44px touch target.
  const nameFieldWidth = isMobile ? undefined : { maxWidth: 400 };
  const moneyFieldWidth = isMobile
    ? { flex: 1, minWidth: 120 }
    : { width: 132, flexGrow: 0, flexShrink: 0 };
  const countFieldWidth = isMobile
    ? { flex: 1, minWidth: 120 }
    : { width: 116, flexGrow: 0, flexShrink: 0 };

  const addFormFields = (
    <YStack gap={12}>
      {/* "Start from" preset — fills the fields below; creates nothing. */}
      <TicketTypePresetPicker value={presetId} onSelect={handleSelectPreset} />
      <YStack gap={4} {...nameFieldWidth}>
        <Text
          tag="span"
          style={{ fontSize: 11, textTransform: "uppercase" }}
          tone="muted"
        >
          {String(t("admin.ttName"))}
        </Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder={t("admin.ttNamePlaceholder") as string}
          maxLength={80}
          fullWidth
          autoFocus
          testId="ticket-type-add-name"
        />
      </YStack>
      <XStack gap={16} flexWrap="wrap">
        {/* Pay What You Want has no list price — the buyer names it, within
            the minimum below — so the field is not shown and 0 is sent. */}
        {pricingMode !== "ADJUSTABLE" && (
          <YStack gap={4} {...moneyFieldWidth}>
            <Text
              tag="span"
              style={{ fontSize: 11, textTransform: "uppercase" }}
              tone="muted"
            >
              {String(t("admin.ttPrice"))}
            </Text>
            <TextInput
              value={priceDollars}
              onChangeText={setPriceDollars}
              placeholder="0.00"
              fullWidth
              testId="ticket-type-add-price"
            />
          </YStack>
        )}
        <YStack gap={4} {...countFieldWidth}>
          <Text
            tag="span"
            style={{ fontSize: 11, textTransform: "uppercase" }}
            tone="muted"
          >
            {String(t("admin.ttCapacity"))}
          </Text>
          <TextInput
            value={capacity}
            onChangeText={setCapacity}
            placeholder="100"
            fullWidth
            testId="ticket-type-add-capacity"
            onSubmitEditing={() => {
              void handleAdd();
            }}
            returnKeyType="done"
          />
        </YStack>
      </XStack>
      {/* Pricing mode toggle */}
      <YStack gap={8}>
        <Text
          tag="span"
          style={{ fontSize: 11, textTransform: "uppercase" }}
          tone="muted"
        >
          Pricing
        </Text>
        <XStack
          gap={0}
          borderWidth={2}
          borderColor="$borderColor"
          alignSelf="flex-start"
        >
          <XStack
            paddingHorizontal={12}
            paddingVertical={8}
            cursor="pointer"
            backgroundColor={
              pricingMode === "FIXED" ? "$accent" : "transparent"
            }
            borderRightWidth={1}
            borderRightColor="$borderColor"
            onPress={() => setPricingMode("FIXED")}
          >
            <Text
              variant="caption"
              color={
                pricingMode === "FIXED" ? "$onBrandSecondary" : "$colorMuted"
              }
              weight={pricingMode === "FIXED" ? "semibold" : undefined}
            >
              Fixed Price
            </Text>
          </XStack>
          <XStack
            paddingHorizontal={12}
            paddingVertical={8}
            cursor="pointer"
            backgroundColor={
              pricingMode === "ADJUSTABLE" ? "$accent" : "transparent"
            }
            onPress={() => setPricingMode("ADJUSTABLE")}
          >
            <Text
              variant="caption"
              color={
                pricingMode === "ADJUSTABLE"
                  ? "$onBrandSecondary"
                  : "$colorMuted"
              }
              weight={pricingMode === "ADJUSTABLE" ? "semibold" : undefined}
            >
              Pay What You Want
            </Text>
          </XStack>
        </XStack>
      </YStack>
      {pricingMode === "ADJUSTABLE" && (
        <XStack gap={16} flexWrap="wrap">
          <YStack gap={4} flex={1} minWidth={120}>
            <Text
              tag="span"
              style={{ fontSize: 11, textTransform: "uppercase" }}
              tone="muted"
            >
              Minimum ($)
            </Text>
            <TextInput
              value={minimumDollars}
              onChangeText={setMinimumDollars}
              placeholder="0.00"
              fullWidth
              testId="ticket-type-add-minimum"
              ref={minimumInputRef}
              aria-invalid={isAbovePwywCap(minimumDollars) || undefined}
              aria-describedby={
                isAbovePwywCap(minimumDollars) ? "ticket-type-add-minimum-above-cap" : undefined
              }
            />
            {isAbovePwywCap(minimumDollars) && (
              <Text
                variant="caption"
                role="alert"
                color="$danger"
                style={{ fontSize: 11 }}
                id="ticket-type-add-minimum-above-cap"
                data-testid="ticket-type-add-minimum-above-cap"
              >
                {String(
                t("admin.ttPwywAboveCap", {
                  max: fmtCurrency(fmt, MAX_DONATION_AMOUNT_CENTS, eventCurrency),
                }),
              )}
              </Text>
            )}
            <Text variant="caption" tone="muted" style={{ fontSize: 11 }}>
              Leave at $0 for truly open
            </Text>
          </YStack>
          <YStack gap={4} flex={1} minWidth={120}>
            <Text
              tag="span"
              style={{ fontSize: 11, textTransform: "uppercase" }}
              tone="muted"
            >
              Suggested ($)
            </Text>
            <TextInput
              value={suggestedDollars}
              onChangeText={setSuggestedDollars}
              placeholder="10.00"
              fullWidth
              testId="ticket-type-add-suggested"
              ref={suggestedInputRef}
              aria-invalid={isAbovePwywCap(suggestedDollars) || undefined}
              aria-describedby={
                isAbovePwywCap(suggestedDollars) ? "ticket-type-add-suggested-above-cap" : undefined
              }
            />
            {isAbovePwywCap(suggestedDollars) && (
              <Text
                variant="caption"
                role="alert"
                color="$danger"
                style={{ fontSize: 11 }}
                id="ticket-type-add-suggested-above-cap"
                data-testid="ticket-type-add-suggested-above-cap"
              >
                {String(
                t("admin.ttPwywAboveCap", {
                  max: fmtCurrency(fmt, MAX_DONATION_AMOUNT_CENTS, eventCurrency),
                }),
              )}
              </Text>
            )}
            <Text variant="caption" tone="muted" style={{ fontSize: 11 }}>
              Shown as the default at checkout
            </Text>
          </YStack>
        </XStack>
      )}
      {/* Scheduled price change (FR-005) — FIXED only; a buyer-chosen price
          has nothing to flip to. */}
      {pricingMode === "FIXED" && (
        <TicketScheduledPriceField
          idPrefix="add"
          value={schedule}
          onChange={setSchedule}
          timeZone={eventTimezone}
          currency={eventCurrency}
          problem={addScheduleProblem}
          // See the matching note on the edit form: one zone footnote per form.
          showZoneNote={!salesWindow.enabled}
          disabled={disabled}
        />
      )}
      {/* Sales window (FR-013) — NOT gated on pricing mode; see the matching
          note in the edit form. */}
      <TicketSalesWindowField
        idPrefix="add"
        value={salesWindow}
        onChange={setSalesWindow}
        timeZone={eventTimezone}
        problem={addWindowProblem}
        disabled={disabled}
      />
      {/* FR-012: the preset HAD timing and it evaporated against this event's
          date. Silence is right when a preset never carried a window — the
          untouched control says so by itself — and wrong here, because those
          two states look identical on screen. See `presetTimingDropped`. */}
      {presetTimingDropped && (
        <Text
          variant="caption"
          tone="muted"
          style={{ fontSize: 11 }}
          data-testid="ticket-type-add-preset-timing-dropped"
        >
          {String(t("admin.ttPresetTimingTooSoon"))}
        </Text>
      )}
      {/* Resale settings — hidden entirely while the `resale` gate is off */}
      {resaleEnabled && pricingMode === "FIXED" && (
        <YStack gap={8}>
          <XStack
            gap={8}
            alignItems="center"
            cursor="pointer"
            onPress={() => setResaleAllowed(!resaleAllowed)}
            data-testid="ticket-type-add-resale-toggle"
          >
            <XStack
              width={18}
              height={18}
              borderWidth={2}
              borderColor={resaleAllowed ? "$accent" : "$borderColor"}
              borderRadius={0}
              alignItems="center"
              justifyContent="center"
              backgroundColor={resaleAllowed ? "$accentSoft" : "transparent"}
            >
              {resaleAllowed && <Check size={12} color={theme.accent?.val} />}
            </XStack>
            <Repeat size={13} color={theme.colorMuted?.val} />
            <Text variant="caption" color="$color">
              Allow resale
            </Text>
          </XStack>
          {resaleAllowed && (
            <YStack gap={4} paddingLeft={26}>
              <Text
                variant="caption"
                tone="muted"
                style={{ textTransform: "uppercase" }}
              >
                Resale price cap ($)
              </Text>
              <TextInput
                value={resaleCapDollars}
                onChangeText={setResaleCapDollars}
                placeholder="No cap"
                fullWidth
                testId="ticket-type-add-resale-cap"
              />
              <Text variant="caption" tone="muted" style={{ fontSize: 11 }}>
                Leave blank for no cap. Sellers cannot list above this price,
                or above what their own ticket cost if that is higher.
              </Text>
            </YStack>
          )}
        </YStack>
      )}
      {pricingMode === "ADJUSTABLE" && (
        <Text variant="caption" tone="muted" style={{ fontSize: 11 }}>
          Buyers choose their own amount. Non-refundable. Resale disabled.
        </Text>
      )}
    </YStack>
  );

  return (
    <YStack
      padding={32}
      gap={16}
      maxWidth={960}
      width="100%"
      marginHorizontal="auto"
      data-testid="ticket-type-editor"
      {...(disabled ? { opacity: 0.5, pointerEvents: "none" } : {})}
    >
      <XStack
        justifyContent="space-between"
        alignItems="center"
        gap={8}
        flexWrap="wrap"
      >
        <FieldLabel>{String(t("admin.ttTicketTypes"))}</FieldLabel>
        {disabled && (
          <Text variant="caption" tone="muted">
            {String(t("admin.ttLocked"))}
          </Text>
        )}
        {!disabled && (
          <XStack
            gap={4}
            alignItems="center"
            justifyContent="flex-end"
            flexWrap="wrap"
            // Without these the row's min-width:auto pins it at its one-line
            // content width (~584px) — flexWrap never engages, and on phones
            // the overflow expands the layout viewport, dragging both fixed
            // bottom bars out of the visible screen.
            flexShrink={1}
            minWidth={0}
          >
            {/* Save/apply owner-scoped ticket-type templates. Thin mount —
                all dialog + mutation logic lives in the controls component. */}
            {templateOwner ? (
              <TicketTypeTemplateControls
                eventId={eventId}
                templateOwner={templateOwner}
                canCustomiseTemplates={canCustomiseTemplates}
                ticketTypes={ticketTypes}
                hasSeatingLayout={hasSeatingLayout}
              />
            ) : null}
            {!showForm && (
              <Button
                variant="ghost"
                size="$2"
                onPress={() => {
                  setShowForm(true);
                  handleCancelEdit();
                }}
                data-testid="ticket-type-add-btn"
              >
                <Plus size={14} aria-hidden />
                {String(t("admin.ttAddTicketType"))}
              </Button>
            )}
          </XStack>
        )}
      </XStack>

      {/* Existing ticket types */}
      {ticketTypes.length === 0 && !showForm && (
        <YStack
          padding={32}
          alignItems="center"
          gap={12}
          borderWidth={2}
          borderColor="$borderColor"
          borderStyle="dashed"
          data-testid="ticket-type-empty-state"
        >
          <Ticket size={24} color={theme.colorMuted?.val} />
          <Text variant="body" tone="muted">
            {String(t("admin.ttEmptyTitle"))}
          </Text>
          <Text variant="caption" color="$borderColor">
            {String(t("admin.ttEmptyMessage"))}
          </Text>
          <XStack
            gap={12}
            marginTop={8}
            flexDirection={isMobile ? "column" : "row"}
            flexWrap="wrap"
            width={isMobile ? "100%" : undefined}
            alignItems={isMobile ? "stretch" : "center"}
          >
            <Button
              size="$3"
              variant="primary"
              width={isMobile ? "100%" : undefined}
              onPress={() => {
                void handleCreateDefaultGA();
              }}
              disabled={disabled || isCreatingGA}
              data-testid="ticket-type-create-ga"
            >
              <Ticket size={14} aria-hidden />
              {String(t("admin.ttDefaultGALabel"))}
            </Button>
            <Button
              size="$3"
              variant="secondary"
              width={isMobile ? "100%" : undefined}
              onPress={() => {
                setShowForm(true);
                handleCancelEdit();
              }}
              disabled={disabled}
              data-testid="ticket-type-custom-btn"
            >
              <Plus size={14} aria-hidden />
              {String(t("admin.ttCustomTicketLabel"))}
            </Button>
          </XStack>
        </YStack>
      )}

      {/* Mobile: stacked EditorCard rows. Editing is routed to a full-screen
          EventEditorSheet (rendered once, below) instead of expanding inline,
          so each ticket type is always a compact card here. */}
      {isMobile
        ? ticketTypes.map((tt) => {
            const isConfirmingDelete = confirmingDeleteId === tt.id;
            return (
              <EditorCard
                key={tt.id}
                data-testid="ticket-type-card"
                actions={
                  <EditorCardActions>
                    {isConfirmingDelete ? (
                      <>
                        <Button
                          variant="ghost"
                          size="$3"
                          borderRadius={0}
                          minHeight={44}
                          disabled={deletingId === tt.id}
                          onPress={() => {
                            void handleDelete(tt);
                          }}
                          data-testid="ticket-type-delete-confirm"
                          color="$danger"
                        >
                          {deletingId === tt.id
                            ? String(t("admin.ttDeleting"))
                            : String(t("admin.ttDelete"))}
                        </Button>
                        <Button
                          variant="ghost"
                          size="$3"
                          borderRadius={0}
                          minHeight={44}
                          onPress={() => setConfirmingDeleteId(null)}
                          data-testid="ticket-type-delete-cancel"
                        >
                          {String(t("admin.ttCancel"))}
                        </Button>
                      </>
                    ) : (
                      <>
                        {!disabled && (
                          <Button
                            variant="secondary"
                            size="$3"
                            borderRadius={0}
                            minHeight={44}
                            onPress={() => handleStartEdit(tt)}
                            aria-label={String(t("admin.ttEdit"))}
                            data-testid="ticket-type-edit-btn"
                          >
                            <Edit3 size={16} color="currentColor" />
                          </Button>
                        )}
                        {!disabled && (
                          <Button
                            variant="ghost"
                            size="$3"
                            borderRadius={0}
                            minHeight={44}
                            onPress={() => setConfirmingDeleteId(tt.id)}
                            aria-label={String(t("admin.ttDelete"))}
                            data-testid="ticket-type-delete-btn"
                          >
                            <Trash2 size={16} color={theme.danger?.val} />
                          </Button>
                        )}
                      </>
                    )}
                  </EditorCardActions>
                }
              >
                <EditorCardTitle>{tt.name}</EditorCardTitle>
                <EditorCardMeta>{ticketCardMeta(tt)}</EditorCardMeta>
                {/* Saved scheduled price change, on the event's clock. Its own
                    line rather than folded into the meta string: the zone
                    abbreviation makes it long, and it must stay readable at
                    320px instead of being truncated out of existence. */}
                {(() => {
                  const summary = scheduleSummary(tt);
                  return summary ? (
                    <EditorCardMeta data-testid="ticket-type-card-schedule">
                      {summary}
                    </EditorCardMeta>
                  ) : null;
                })()}
                {/* Saved sales window, on the event's clock. Its own line for
                    the same reason as the schedule above: a range with two zone
                    abbreviations is the longest string on the card and must
                    stay readable at 320px rather than truncate. */}
                {(() => {
                  const summary = windowSummary(tt);
                  return summary ? (
                    <EditorCardMeta data-testid="ticket-type-card-window">
                      {summary}
                    </EditorCardMeta>
                  ) : null;
                })()}
              </EditorCard>
            );
          })
        : ticketTypes.map((tt) =>
            editingId === tt.id ? (
              /* Inline edit form (desktop) */
              <YStack
                key={tt.id}
                gap={12}
                padding={16}
                borderWidth={2}
                borderColor="$borderColorStrong"
                data-testid="ticket-type-edit-form"
              >
                <XStack justifyContent="space-between" alignItems="center">
                  <Text variant="body" weight="bold" color="$color">
                    {String(t("admin.ttEditTicketType"))}
                  </Text>
                  <XStack
                    cursor="pointer"
                    onPress={handleCancelEdit}
                    padding={4}
                    borderRadius={0}
                    hoverStyle={{ backgroundColor: "$surfaceMuted" }}
                    data-testid="ticket-type-edit-cancel-x"
                  >
                    <X size={16} color={theme.colorMuted?.val} />
                  </XStack>
                </XStack>
                {editFormFields}
                {editFormFooter}
              </YStack>
            ) : (
              /* Read-only row (desktop) */
              <TicketRow
                key={tt.id}
                // Locked once tickets are sold: the row is not a control then.
                {...(disabled
                  ? { cursor: "default" }
                  : { onPress: () => handleStartEdit(tt) })}
                data-testid="ticket-type-row"
              >
                <XStack gap={12} alignItems="center" flex={1}>
                  <YStack gap={4} flex={1}>
                    <Text
                      tag="span"
                      style={{ fontSize: 15, fontWeight: "700" }}
                      color="$color"
                    >
                      {tt.name}
                    </Text>
                    <XStack gap={6} alignItems="baseline" flexWrap="wrap">
                      <Text
                        tag="span"
                        style={{ fontSize: 14, fontWeight: "700" }}
                        color="$color"
                        data-testid="ticket-type-row-price"
                      >
                        {tt.pricingMode === "ADJUSTABLE"
                          ? `Pay What You Want${tt.minimumCents ? ` (min ${formatPrice(tt.minimumCents)})` : ""}${tt.suggestedCents ? ` · suggested ${formatPrice(tt.suggestedCents)}` : ""}`
                          : formatPrice(resolvePriceHeadline(tt).cents)}
                      </Text>
                      {/* Once a flip has fired the headline above is the resolved
                      price, which is what the fee block below is computed from
                      and what buyers are charged. The stored list price stays
                      visible as context so the organizer can still recognise
                      the tier they configured. */}
                      {tt.pricingMode !== "ADJUSTABLE" &&
                        (() => {
                          const wasCents = resolvePriceHeadline(tt).wasCents;
                          if (wasCents == null) return null;
                          return (
                            <Text
                              tag="span"
                              style={{ fontSize: 12 }}
                              tone="muted"
                              data-testid="ticket-type-row-price-was"
                            >
                              ·{" "}
                              {String(
                                t("admin.ttPriceWas", {
                                  price: formatPrice(wasCents),
                                }),
                              )}
                            </Text>
                          );
                        })()}
                      <Text tag="span" style={{ fontSize: 12 }} tone="muted">
                        ·{" "}
                        {String(
                          t("admin.ttCapacityCount", { capacity: tt.capacity }),
                        )}
                      </Text>
                    </XStack>
                    {/* Saved scheduled price change, on the event's clock —
                    Q-002's re-open read-back, visible without opening the
                    editor. */}
                    {(() => {
                      const summary = scheduleSummary(tt);
                      if (!summary) return null;
                      return (
                        <XStack
                          gap={4}
                          alignItems="center"
                          marginTop={2}
                          // The zone abbreviation makes this the longest line in
                          // the row; let it shrink and wrap rather than push the
                          // action buttons off a narrow viewport.
                          flexShrink={1}
                          minWidth={0}
                          flexWrap="wrap"
                        >
                          <CalendarClock
                            size={11}
                            color={theme.colorMuted?.val}
                          />
                          <Text
                            tag="span"
                            style={{ fontSize: 11 }}
                            tone="muted"
                            flexShrink={1}
                            data-testid="ticket-type-row-schedule"
                          >
                            {summary}
                          </Text>
                        </XStack>
                      );
                    })()}
                    {/* Saved sales window, on the event's clock — visible
                    without opening the editor, which is what stops an organizer
                    from having to open every tier to find the one they held
                    back. */}
                    {(() => {
                      const summary = windowSummary(tt);
                      if (!summary) return null;
                      return (
                        <XStack
                          gap={4}
                          alignItems="center"
                          marginTop={2}
                          // A two-bound range carries two zone abbreviations and
                          // is the longest line in the row; let it shrink and
                          // wrap rather than push the actions off a narrow
                          // viewport.
                          flexShrink={1}
                          minWidth={0}
                          flexWrap="wrap"
                        >
                          <CalendarRange
                            size={11}
                            color={theme.colorMuted?.val}
                          />
                          <Text
                            tag="span"
                            style={{ fontSize: 11 }}
                            tone="muted"
                            flexShrink={1}
                            data-testid="ticket-type-row-window"
                          >
                            {summary}
                          </Text>
                        </XStack>
                      );
                    })()}
                    {/* Fee breakdown. Gated on the EFFECTIVE price, not the stored
                    one: a tier scheduled to flip from free to $20 has
                    priceCents 0, and gating on that would hide the fee block
                    for a tier buyers are now being charged for. */}
                    {resolvePriceHeadline(tt).cents > 0 &&
                      feeMode &&
                      (() => {
                        const fees = feeByTicketType.get(tt.id);
                        if (!fees) return null;
                        // Fees are always on top (the server prices every
                        // sale PASS_THROUGH; docs/decisions/absorb-removed.md),
                        // so "Buyer pays" is price + every line shown here.
                        return (
                          <XStack gap={12} marginTop={4} flexWrap="wrap">
                            <Text
                              tag="span"
                              style={{ fontSize: 11 }}
                              tone="muted"
                              data-testid="tt-fee-platform"
                            >
                              {String(t("admin.ttFeePlatformFee"))}:{" "}
                              {formatPrice(fees.platformFeeCents)}
                            </Text>
                            {feeMode === "PASS_THROUGH" &&
                              fees.processorFeeCents != null &&
                              fees.processorFeeCents > 0 && (
                                <Text
                                  tag="span"
                                  style={{ fontSize: 11 }}
                                  tone="muted"
                                >
                                  {String(t("admin.ttFeeProcessor"))}:{" "}
                                  {formatPrice(fees.processorFeeCents)}
                                </Text>
                              )}
                            {/* Tax is part of what the buyer pays — the
                                event page and checkout include it, so this
                                line has to as well for "Buyer pays" to add
                                up and to match them. */}
                            {fees.taxEstimateCents != null &&
                              fees.taxEstimateCents > 0 && (
                                <Text
                                  tag="span"
                                  style={{ fontSize: 11 }}
                                  tone="muted"
                                >
                                  {String(t("admin.ttFeeTax"))}:{" "}
                                  {formatPrice(fees.taxEstimateCents)}
                                </Text>
                              )}
                            {/* Unknown tax rate: say so instead of a total
                                that leaves the tax out. */}
                            {fees.buyerTotalCents == null ? (
                              <Text
                                tag="span"
                                style={{ fontSize: 11 }}
                                tone="muted"
                                data-testid="tt-fee-tax-unavailable"
                              >
                                {String(t("admin.ttFeeTaxUnavailable"))}
                              </Text>
                            ) : (
                              <Text
                                tag="span"
                                style={{ fontSize: 11, fontWeight: "700" }}
                                tone="muted"
                              >
                                {String(t("admin.ttFeeBuyerTotal"))}:{" "}
                                {formatPrice(fees.buyerTotalCents)}
                              </Text>
                            )}
                            {/* The fee is on top, so the event is credited
                                the full price; shown whether or not tax
                                could be calculated. */}
                            <Text
                              tag="span"
                              style={{ fontSize: 11 }}
                              tone="muted"
                              data-testid="tt-fee-event-credit"
                            >
                              {String(t("admin.ttFeeEventCredit"))}:{" "}
                              {formatPrice(fees.eventCreditCents)}
                            </Text>
                          </XStack>
                        );
                      })()}
                    {/* Resale badge — suppressed while the `resale` gate is off */}
                    {resaleEnabled && tt.resaleAllowed && (
                      <XStack gap={4} marginTop={4} alignItems="center">
                        <Repeat size={11} color={theme.colorMuted?.val} />
                        <Text tag="span" style={{ fontSize: 11 }} tone="muted">
                          Resale allowed
                          {tt.resaleCapCents != null
                            ? ` (cap: ${formatPrice(tt.resaleCapCents)})`
                            : ""}
                        </Text>
                      </XStack>
                    )}
                  </YStack>
                </XStack>
                <XStack gap={8} alignItems="center">
                  {confirmingDeleteId === tt.id ? (
                    <XStack gap={4} alignItems="center">
                      <Text tag="span" style={{ fontSize: 12 }} tone="muted">
                        {String(t("admin.ttDeleteConfirm"))}
                      </Text>
                      <Button
                        variant="ghost"
                        size="$2"
                        borderRadius={0}
                        disabled={deletingId === tt.id}
                        onPress={(e) => {
                          e.stopPropagation();
                          void handleDelete(tt);
                        }}
                        data-testid="ticket-type-delete-confirm"
                        color="$danger"
                      >
                        {deletingId === tt.id
                          ? String(t("admin.ttDeleting"))
                          : String(t("admin.ttDelete"))}
                      </Button>
                      <Button
                        variant="ghost"
                        size="$2"
                        borderRadius={0}
                        onPress={(e) => {
                          e.stopPropagation();
                          setConfirmingDeleteId(null);
                        }}
                        data-testid="ticket-type-delete-cancel"
                      >
                        {String(t("admin.ttCancel"))}
                      </Button>
                    </XStack>
                  ) : (
                    <>
                      {!disabled && (
                        <Button
                          variant="secondary"
                          size="$2"
                          borderRadius={0}
                          onPress={(e) => {
                            e.stopPropagation();
                            handleStartEdit(tt);
                          }}
                          data-testid="ticket-type-edit-btn"
                        >
                          <Edit3 size={15} aria-hidden />
                          {String(t("admin.ttEdit"))}
                        </Button>
                      )}
                      {!disabled && (
                        <Button
                          variant="ghost"
                          size="$2"
                          borderRadius={0}
                          onPress={(e) => {
                            e.stopPropagation();
                            setConfirmingDeleteId(tt.id);
                          }}
                          data-testid="ticket-type-delete-btn"
                          color="$danger"
                        >
                          <Trash2 size={15} aria-hidden />
                          {String(t("admin.ttDelete"))}
                        </Button>
                      )}
                    </>
                  )}
                </XStack>
              </TicketRow>
            ),
          )}

      {/* Edit sheet (mobile only) — full-screen EventEditorSheet. On desktop,
          editing stays inline within the list above, byte-identical to before.
          The form body is the single scroll region; Save sits in the footer. */}
      {isMobile && (
        <EventEditorSheet
          open={editingId !== null}
          onClose={handleCancelEdit}
          title={String(t("admin.ttEditTicketType"))}
          footer={editFormFooter}
        >
          {editFormFields}
        </EventEditorSheet>
      )}

      {/* Add form — inline on desktop (byte-identical to before); routed through
          EventEditorSheet on mobile so it's a full-screen sheet with a pinned
          Save footer reachable without scrolling. */}
      {showForm &&
        (isMobile ? (
          <EventEditorSheet
            open={showForm}
            onClose={resetAddForm}
            title={String(t("admin.ttNewTicketType"))}
            footer={addFormFooter}
          >
            {addFormFields}
          </EventEditorSheet>
        ) : (
          <YStack
            gap={12}
            padding={16}
            borderWidth={2}
            borderColor="$borderColor"
            data-testid="ticket-type-add-form"
          >
            <Text
              tag="span"
              style={{ fontSize: 13, fontWeight: "700" }}
              color="$color"
            >
              {String(t("admin.ttNewTicketType"))}
            </Text>
            {addFormFields}
            {addFormFooter}
          </YStack>
        ))}

      {/* Stripe-setup callout — surfaces under the ticket-type box whenever
          the upsert mutation rejected with `PAID_TICKETING_REQUIRES_STRIPE`.
          The toast alone disappears quickly; this sticks around so the user
          can read the explanation and click straight to the Payouts page. */}
      {stripeRequired && (
        <YStack
          gap={8}
          padding={16}
          borderWidth={1}
          borderColor="$borderColor"
          borderLeftWidth={3}
          borderLeftColor="$accent"
          backgroundColor="$surfaceMuted"
          data-testid="ticket-type-stripe-required-callout"
        >
          <XStack gap={8} alignItems="center">
            <CreditCard size={16} color={theme.accent?.val} />
            <Text variant="bodySmall" weight="bold">
              {String(t("admin.ttStripeRequiredTitle"))}
            </Text>
          </XStack>
          <Text variant="caption" tone="muted">
            {String(t("admin.ttStripeRequiredBody"))}
          </Text>
          <XStack gap={8} alignItems="center" flexWrap="wrap">
            <NextLinkAnchor href={payoutsHref}>
              <Button
                tag="span"
                variant="primary"
                size="$2"
                data-testid="ticket-type-stripe-setup-link"
              >
                {String(t("admin.ttSetUpPayouts"))}
                <ExternalLink size={12} aria-hidden />
              </Button>
            </NextLinkAnchor>
            <Button
              variant="ghost"
              size="$2"
              onPress={() => setStripeRequired(false)}
            >
              {String(t("admin.ttStripeRequiredDismiss"))}
            </Button>
          </XStack>
        </YStack>
      )}

      {/* Seating layout blurb removed — seating is behind feature gate and accessible via the Seating tab */}
    </YStack>
  );
}
