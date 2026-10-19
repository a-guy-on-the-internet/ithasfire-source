"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslations } from "@th/ui";

import { trpc } from "@/trpc";

import { BookingBillEditor } from "./BookingBillEditor";
import { BookingDatePicker } from "./BookingDatePicker";
import { BookingSubmitButton } from "./BookingSubmitButton";
import { IntentPicker } from "./IntentPicker";
import { SpaceRequestForm } from "./SpaceRequestForm";
import { usePlaceBookingOptions } from "./use-place-booking-options";
import { useEventOwnerEntities } from "@/hooks/useEventOwnerEntities";

import {
  BOOKING_ACT_NAME_MAX,
  BOOKING_FEE_CURRENCY,
  BOOKING_FEE_TYPES,
  BOOKING_LINEUP_MAX,
  BOOKING_LINEUP_MIN,
  BOOKING_MAX_DATES,
  BOOKING_SET_LENGTH_PRESETS,
  BOOKING_TECH_NEEDS_MAX,
  buildBookingRequestPayloadWithBill,
  calendarsForIntent,
  centsToFeeAmountInput,
  defaultCalendarId,
  formatSetLength,
  mapCreateBookingRequestError,
  pickDefaultIntent,
  pitchStandardsPayload,
  type BookingIntent,
  type BookingOptionCalendar,
  type BookingRequestFormValues,
  type BookingSender,
} from "./request-to-play-form.helpers";
import {
  countOutlineBrackets,
  firstOutlineBracketRange,
  normaliseOutline,
  resolveStandardsList,
  shouldOfferOutline,
  type BookingStandardField,
  type BookingStandardsByIntent,
} from "./booking-standards.helpers";
import { BookingStandardsRail } from "./BookingStandardsRail";
import { useBookingStandards } from "./use-booking-standards";
import { RequestToPlayStatsLine } from "./RequestToPlayStatsLine";
import {
  BOOKING_BILL_MAX_ROWS,
  type BookingBillActDraft,
} from "./booking-bill.helpers";
import formStyles from "./RequestToPlayBlock.module.css";
import standardsStyles from "./BookingStandards.module.css";

/**
 * Shared booking-request form surface.
 *
 * Extracted from `RequestToPlayBlock` so BOTH hosts render the exact same
 * sender list, bill and submit logic (performer mode gates only the sender's
 * own row on the bill — see `BookingBillEditor`):
 *  - the in-column `request_to_play` block CTA (RequestToPlayBlock), and
 *  - the venue hero's "Booking request" dialog (HeroBookingRequestButton).
 *
 * The form inherits the venue theme via the `--th-color-*` custom properties
 * when they are in scope (entity page main column), and falls back to sensible
 * defaults otherwise (e.g. inside the portaled hero dialog, where the caller
 * re-seeds those vars from the live theme).
 */

/** Org roles that may send a request on the org's behalf (core ORG_EDIT_ROLES). */
const SENDER_ORG_ROLES = ["OWNER", "ADMIN", "EDITOR"] as const;

/* ── Intent switch → form ─────────────────────────────────────────────────── */

/**
 * Step 1 is the INTENT (venue-confirmation-and-booking-intents spec): PERFORM
 * opens the pitch form, where performer mode gates only the sender's own row
 * on the bill (lineup v2 D3); RENT / USE open the room-hire variant to any
 * signed-in human (or an org they can edit). Performer mode also picks the
 * DEFAULT intent. The place's calendars decide which
 * intents are offered at all (`places.getBookingOptions`); a single offered
 * intent skips the picker.
 */
export function RequestToPlayPanel({
  placeId,
  placeName = null,
  intent: requestedIntent = null,
  onSuccess,
}: {
  placeId: string;
  /**
   * The place's name, for the standards panel ("What Marrow Hall expects")
   * and its lines. Both hosts pass it; without it the copy says "this place".
   */
  placeName?: string | null;
  /**
   * The trigger's preselect ("Play here" → PERFORM, "Rent or use a space" →
   * RENT). Falls back per `pickDefaultIntent` when the place does not offer
   * it, so a stale link never lands on a form the venue cannot answer.
   */
  intent?: BookingIntent | null;
  onSuccess: (result: { intent: BookingIntent }) => void;
}) {
  const t = useTranslations();
  const utils = trpc.useUtils();
  const options = usePlaceBookingOptions(placeId);

  const statusQuery = trpc.performers.getMyStatus.useQuery(undefined, {
    staleTime: 30_000,
    retry: false,
    meta: { silent: true },
  });
  const ownersQuery = useEventOwnerEntities();
  const [enableError, setEnableError] = useState<string | null>(null);

  const setModeMutation = trpc.performers.setMode.useMutation({
    retry: false,
    meta: { silent: true },
    onMutate: (vars) => {
      setEnableError(null);
      // Optimistic: flip the sender's status on so "I'm on the bill" unlocks
      // immediately. The bill's enable is per sender — the person, or an org
      // the actor administers (setPerformerMode's own authz).
      const previous = utils.performers.getMyStatus.getData();
      if (previous) {
        utils.performers.getMyStatus.setData(
          undefined,
          vars.ownerType === "human"
            ? { ...previous, human: { ...previous.human, enabled: true } }
            : {
                ...previous,
                orgs: previous.orgs.map((org) =>
                  org.ownerId === vars.ownerId ? { ...org, enabled: true } : org,
                ),
              },
        );
      }
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        utils.performers.getMyStatus.setData(undefined, context.previous);
      }
      setEnableError(String(t("admin.bkEnablePerformerModeFailed")));
    },
    onSettled: () => {
      void utils.performers.getMyStatus.invalidate();
    },
  });

  // PERFORM senders (lineup v2 D3 / v3 FR-002): performer mode gates the
  // sender's OWN ROW on the bill, not sending — a promoter pitching a night
  // of other acts needs none. So: the person plus every org whose performer
  // status the actor can read (the orgs they administer), each carrying its
  // mode. Mode-on identities lead, so the default sender is the one it was
  // before the bill (the first performer).
  const performerSenders = useMemo<BookingSender[]>(() => {
    const status = statusQuery.data;
    if (!status) return [];
    const owners = ownersQuery.ownersWithSlugs ?? [];

    const result: BookingSender[] = [];
    const human = owners.find((o) => o.kind === "human");
    result.push({
      ownerType: "human",
      ownerId: status.human.ownerId,
      label:
        human?.kind === "human" && human.humanName
          ? human.humanName
          : String(t("admin.bkSenderSelf")),
      performerEnabled: status.human.enabled,
    });
    for (const org of status.orgs) {
      const match = owners.find(
        (o) => o.kind === "org" && o.orgId === org.ownerId,
      );
      result.push({
        ownerType: "org",
        ownerId: org.ownerId,
        label:
          match?.kind === "org"
            ? match.orgName
            : String(t("admin.bkSenderOrgFallback")),
        performerEnabled: org.enabled,
      });
    }
    return [
      ...result.filter((s) => s.performerEnabled),
      ...result.filter((s) => !s.performerEnabled),
    ];
  }, [statusQuery.data, ownersQuery.ownersWithSlugs, t]);

  // RENT / USE senders: the requester is ANY human, plus every org they hold
  // an edit role in (the server asserts the same roles). No performer mode.
  const requesterSenders = useMemo<BookingSender[]>(() => {
    const status = statusQuery.data;
    if (!status) return [];
    const owners = ownersQuery.ownersWithSlugs ?? [];
    const human = owners.find((o) => o.kind === "human");
    const result: BookingSender[] = [
      {
        ownerType: "human",
        ownerId: status.human.ownerId,
        label:
          human?.kind === "human" && human.humanName
            ? human.humanName
            : String(t("admin.bkSenderSelf")),
      },
    ];
    for (const owner of owners) {
      if (
        owner.kind !== "org" ||
        !(SENDER_ORG_ROLES as readonly string[]).includes(owner.role)
      ) {
        continue;
      }
      result.push({
        ownerType: "org",
        ownerId: owner.orgId,
        label: owner.orgName,
      });
    }
    return result;
  }, [statusQuery.data, ownersQuery.ownersWithSlugs, t]);

  // The intent: the reader's pick while the place still offers it, else the
  // default (trigger's request → performer mode → first offered).
  const performerModeOn = performerSenders.some((s) => s.performerEnabled);
  const [chosenIntent, setChosenIntent] = useState<BookingIntent | null>(null);
  const intent =
    chosenIntent && options.offered.includes(chosenIntent)
      ? chosenIntent
      : pickDefaultIntent({
          offered: options.offered,
          requested: requestedIntent,
          performerModeOn,
        });

  // The sender list's labels come from the owners query; rendering before it
  // settles would print every org as the same fallback ("Group").
  const ownersPending =
    ownersQuery.isPending && ownersQuery.ownersWithSlugs === undefined;
  if (statusQuery.isLoading || options.query.isPending || ownersPending) {
    return (
      <div className={formStyles.panel}>
        <p className={formStyles.statusText}>{String(t("common.loading"))}</p>
      </div>
    );
  }

  // Gate on MISSING data, not the error flag: in react-query v5 a failed
  // BACKGROUND refetch (stale after 60s, window refocus) sets isError while
  // the cached data stays — swapping a filled pitch for this line would throw
  // away everything the reader typed.
  if (
    (statusQuery.isError && statusQuery.data === undefined) ||
    (options.query.isError && options.query.data === undefined) ||
    (ownersQuery.isError && ownersQuery.data === undefined)
  ) {
    // A LOAD failure, not a send failure: its own copy ("couldn't load")
    // and a Retry that refetches only what failed.
    const retry = () => {
      if (statusQuery.isError) void statusQuery.refetch();
      if (options.query.isError) void options.query.refetch();
      if (ownersQuery.isError) void ownersQuery.refetch();
    };
    const retrying =
      statusQuery.isFetching ||
      options.query.isFetching ||
      ownersQuery.isFetching;
    return (
      <div className={formStyles.panel}>
        <p className={formStyles.errorText} role="alert">
          {String(t("admin.bkPanelLoadError"))}
        </p>
        <button
          type="button"
          className={formStyles.inlineButton}
          onClick={retry}
          disabled={retrying}
          aria-busy={retrying || undefined}
        >
          {String(t("admin.bkPanelLoadRetry"))}
        </button>
      </div>
    );
  }

  const status = statusQuery.data;

  // Nothing offered (a claimed venue that opted out, or calendars that take
  // no intent at all): the CTAs already hide on this, so this is the stale
  // tab's copy.
  if (!intent || !options.acceptsBookingRequests) {
    return (
      <div className={formStyles.panel}>
        <p className={formStyles.gateBody}>
          {String(t("admin.bkErrNotAccepting"))}
        </p>
      </div>
    );
  }

  const picker =
    options.offered.length > 1 ? (
      <IntentPicker
        value={intent}
        onChange={setChosenIntent}
        label={String(t("admin.bkIntentLabel"))}
        options={options.offered.map((value) => ({
          value,
          label: String(t(INTENT_LABEL_KEYS[value])),
        }))}
      />
    ) : null;

  if (intent !== "PERFORM") {
    return (
      <>
        {picker}
        <SpaceRequestForm
          key={intent}
          placeId={placeId}
          placeName={placeName}
          placeStandards={options.placeStandards}
          intent={intent}
          calendars={calendarsForIntent(options.calendars, intent)}
          senders={requesterSenders}
          onSuccess={(result) => onSuccess({ intent: result.intent })}
        />
      </>
    );
  }

  return (
    <>
      {picker}
      <BookingRequestForm
        placeId={placeId}
        placeName={placeName}
        placeStandards={options.placeStandards}
        calendars={calendarsForIntent(options.calendars, "PERFORM")}
        senders={performerSenders}
        // Only humans with a share-worthy stats aggregate (3+ shows) see the
        // verified-stats opt-in — an ineligible sender would just snapshot null.
        humanStatsEligible={status?.human.statsEligible === true}
        // The one-click performer-mode enable, offered beside "I'm on the
        // bill" for a sender without it (it used to be a full-panel gate).
        onEnablePerformerMode={(target) =>
          setModeMutation.mutate({
            ownerType: target.ownerType,
            ownerId: target.ownerId,
            enabled: true,
          })
        }
        enablePending={setModeMutation.isPending}
        enableError={enableError}
        onSuccess={() => onSuccess({ intent: "PERFORM" })}
      />
    </>
  );
}

const INTENT_LABEL_KEYS: Record<BookingIntent, string> = {
  PERFORM: "admin.bkIntentPerform",
  RENT: "admin.bkIntentRent",
  USE: "admin.bkIntentUse",
};

/* ── Booking-request form ────────────────────────────────────────────────── */

function BookingRequestForm({
  placeId,
  placeName,
  placeStandards,
  calendars,
  senders,
  humanStatsEligible,
  onEnablePerformerMode,
  enablePending,
  enableError,
  onSuccess,
}: {
  placeId: string;
  placeName: string | null;
  /** The place-wide standards: what an UNROUTED pitch is held to. */
  placeStandards: BookingStandardsByIntent | null;
  /**
   * Calendars accepting PERFORM. Empty on a pre-hierarchy place, where the
   * request stays unrouted (no `calendarId`) exactly as before.
   */
  calendars: BookingOptionCalendar[];
  senders: BookingSender[];
  humanStatsEligible: boolean;
  onEnablePerformerMode: (sender: BookingSender) => void;
  enablePending: boolean;
  enableError: string | null;
  onSuccess: () => void;
}) {
  const t = useTranslations();
  const idBase = useId();

  // The sender is held by IDENTITY, not list index: turning performer mode on
  // re-sorts the list, and an index would silently switch who is sending.
  const [senderKey, setSenderKey] = useState<string | null>(null);
  // ONE state value feeds both the picker and the mutation (the invariant on
  // `BookingDatePicker.calendarId`): the nights shown are the nights the
  // request is validated against.
  const [calendarId, setCalendarId] = useState<string | null>(() =>
    defaultCalendarId(calendars),
  );
  const [message, setMessage] = useState("");
  const [dates, setDates] = useState<string[]>([""]);
  const [expectedDraw, setExpectedDraw] = useState("");
  const [genre, setGenre] = useState("");
  // ── Expanded pitch fields (2026-07-11) ────────────────────────────────────
  const [actName, setActName] = useState("");
  const [lineupSize, setLineupSize] = useState("");
  const [setLength, setSetLength] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [techNeeds, setTechNeeds] = useState("");
  const [feeType, setFeeType] =
    useState<BookingRequestFormValues["feeType"]>("");
  const [feeAmountDollars, setFeeAmountDollars] = useState("");
  const [linkMusic, setLinkMusic] = useState("");
  const [linkVideo, setLinkVideo] = useState("");
  const [linkSocial, setLinkSocial] = useState("");
  const [linkEpk, setLinkEpk] = useState("");
  const [includeVerifiedStats, setIncludeVerifiedStats] = useState(false);
  // The bill (lineup v3, board F1). `selfChoice` is the reader's switch; the
  // effective value is derived below, forced off while the sender has no
  // performer mode, so a sender switch can never carry a stale "on".
  const [billSelfChoice, setBillSelfChoice] = useState(true);
  const [billActs, setBillActs] = useState<BookingBillActDraft[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Prefill from the sender's saved booking defaults, but never clobber a field
  // the user has already edited this session. A field is seeded only while it's
  // still untouched; touching it (any keystroke/selection) pins it. Switching
  // sender re-seeds the untouched fields from the new sender's defaults.
  const touchedRef = useRef<Set<string>>(new Set());
  const touch = (field: string) => {
    touchedRef.current.add(field);
  };

  // A concrete fee amount only makes sense for GUARANTEE / DOOR_SPLIT. When the
  // fee type is Negotiable or unspecified the amount field is hidden AND the
  // value is cleared so it can never be submitted (mirrors the server refine).
  const showFeeAmount = feeType === "GUARANTEE" || feeType === "DOOR_SPLIT";

  const createMutation = trpc.bookingRequests.create.useMutation({
    retry: false,
    meta: { silent: true },
  });

  const keyOf = (s: BookingSender) => `${s.ownerType}:${s.ownerId}`;
  // Pin the default once, so a later re-sort (performer mode turned on) or a
  // late label never moves the request to someone else. Until the pin lands
  // (the first commit), the first sender stands in — the same identity.
  const firstSenderKey = senders[0] ? keyOf(senders[0]) : null;
  useEffect(() => {
    if (senderKey === null && firstSenderKey !== null) {
      setSenderKey(firstSenderKey);
    }
  }, [senderKey, firstSenderKey]);
  const sender =
    senderKey === null
      ? senders[0]
      : senders.find((s) => keyOf(s) === senderKey);
  // A pinned identity that left the list is an error to show, never a silent
  // fallback to whoever is first now.
  const senderGone = senderKey !== null && sender === undefined;
  const senderPerformerEnabled = sender?.performerEnabled !== false;
  // The bill never exceeds 12 rows, the sender's own included: a sender who
  // gains performer mode (or a switch to one) with 12 acts already listed
  // stays off the bill until a row is freed — and the switch is turned off,
  // so freeing a row does not silently put them back on.
  const selfWouldOverflow = billActs.length >= BOOKING_BILL_MAX_ROWS;
  useEffect(() => {
    if (senderPerformerEnabled && billSelfChoice && selfWouldOverflow) {
      setBillSelfChoice(false);
    }
  }, [senderPerformerEnabled, billSelfChoice, selfWouldOverflow]);
  const billIncludeSelf =
    senderPerformerEnabled && billSelfChoice && !selfWouldOverflow;

  // Saved defaults for the selected sender (keyed by owner — a sender switch
  // swaps the data). Signed-out/gated paths never reach this form.
  const defaultsQuery = trpc.performers.getBookingDefaults.useQuery(
    {
      ownerType: sender?.ownerType ?? "human",
      ownerId: sender?.ownerId ?? "",
    },
    {
      enabled: Boolean(sender?.ownerId),
      staleTime: 60_000,
      retry: false,
      meta: { silent: true },
    },
  );

  useEffect(() => {
    // NOTE: no early-return on missing data. When the sender switches and the
    // new sender's defaults are uncached (or errored — retry:false/silent),
    // `d` is undefined and every untouched field resets to "" so the PREVIOUS
    // sender's values (phone/links/act/message) can never linger and be
    // submitted under a different identity. Touched (user-edited) fields are
    // always preserved. Once the new sender's data lands the effect re-runs and
    // fills the untouched fields.
    const d = defaultsQuery.data?.defaults;
    const touched = touchedRef.current;
    const seed = (field: string, setter: (v: string) => void, value: string) => {
      if (!touched.has(field)) setter(value);
    };
    seed("actName", setActName, d?.actName ?? "");
    seed(
      "lineupSize",
      setLineupSize,
      d?.lineupSize != null ? String(d.lineupSize) : "",
    );
    seed(
      "setLength",
      setSetLength,
      d?.setLengthMinutes != null ? String(d.setLengthMinutes) : "",
    );
    seed("contactPhone", setContactPhone, d?.contactPhone ?? "");
    seed("techNeeds", setTechNeeds, d?.techNeeds ?? "");
    // The message template seeds the required `message` field — only until the
    // user has typed their own.
    seed("message", setMessage, d?.messageTemplate ?? "");
    seed("linkMusic", setLinkMusic, d?.linkMusic ?? "");
    seed("linkVideo", setLinkVideo, d?.linkVideo ?? "");
    seed("linkSocial", setLinkSocial, d?.linkSocial ?? "");
    seed("linkEpk", setLinkEpk, d?.linkEpk ?? "");
    if (!touched.has("feeType")) {
      setFeeType((d?.feeType ?? "") as BookingRequestFormValues["feeType"]);
    }
    if (!touched.has("feeAmount")) {
      setFeeAmountDollars(
        d?.feeAmountCents != null ? centsToFeeAmountInput(d.feeAmountCents) : "",
      );
    }
    // Verified-stats preference applies to HUMAN senders only (FR-009), and
    // only when their stats clear the sharing threshold — a saved `true`
    // default stays inert (never seeded) while the sender is ineligible, since
    // the checkbox isn't rendered and the server would only snapshot null.
    if (sender?.ownerType === "human" && !touched.has("includeVerifiedStats")) {
      setIncludeVerifiedStats(
        humanStatsEligible && d?.includeVerifiedStats === true,
      );
    }
    // Seeds on data arrival and on sender switch; field state is intentionally
    // read via closures (not deps) so typing doesn't re-run the seeding.
  }, [defaultsQuery.data, sender?.ownerType, sender?.ownerId, humanStatsEligible]);

  // ONE values object feeds the submit builder and the live standards
  // payload, so the rail's ticks read exactly what Send would build.
  const formValues: BookingRequestFormValues = {
    message,
    preferredDates: dates,
    expectedDraw,
    genre,
    actName,
    lineupSize,
    setLengthMinutes: setLength,
    contactPhone,
    techNeeds,
    feeType,
    feeAmountDollars,
    linkMusic,
    linkVideo,
    linkSocial,
    linkEpk,
    ...(sender
      ? { senderOwnerType: sender.ownerType, senderOwnerId: sender.ownerId }
      : {}),
    senderStatsEligible: humanStatsEligible,
    includeVerifiedStats,
    billIncludeSelf,
    billActs,
  };
  const livePayload = pitchStandardsPayload(formValues);

  // ── What the place expects (venue-booking-standards FR-005) ──────────────
  // The list follows the calendar the request routes to — the same one the
  // picker and the mutation use — so a calendar switch swaps it.
  const routedCalendar = calendarId
    ? (calendars.find((c) => c.id === calendarId) ?? null)
    : null;
  const standardsList = resolveStandardsList({
    calendar: routedCalendar,
    placeStandards,
    intent: "PERFORM",
  });
  const controlIds = useMemo<Partial<Record<BookingStandardField, string>>>(
    () => ({
      LINEUP_SIZE: `${idBase}-lineup`,
      BILL: `${idBase}-bill-name`,
      MESSAGE: `${idBase}-message`,
      SET_LENGTH: `${idBase}-setLength`,
      EXPECTED_DRAW: `${idBase}-draw`,
      GENRE: `${idBase}-genre`,
      TECH_NEEDS: `${idBase}-tech`,
      FEE: `${idBase}-feeType`,
      LINK_MUSIC: `${idBase}-linkMusic`,
      LINK_VIDEO: `${idBase}-linkVideo`,
      LINK_SOCIAL: `${idBase}-linkSocial`,
      LINK_EPK: `${idBase}-linkEpk`,
    }),
    [idBase],
  );
  const std = useBookingStandards({
    placeId,
    idBase,
    list: standardsList,
    intent: "PERFORM",
    payload: livePayload,
    placeName,
    controlIds,
  });
  const hasRail = std.checklist !== null;

  // ── Pitch outline (FR-010, board T1) ────────────────────────────────────
  // Offered only while the message is empty. A saved template prefills the
  // message, so while the sender's defaults are still loading the button
  // waits rather than flashing up and vanishing.
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const [outlineUsed, setOutlineUsed] = useState(false);
  const selectFirstBracket = useRef(false);
  const defaultsSettling = defaultsQuery.isLoading === true;
  const offerOutline = shouldOfferOutline(message) && !defaultsSettling;
  const bracketsLeft = outlineUsed ? countOutlineBrackets(message) : 0;
  const showOutlineHint = outlineUsed && bracketsLeft > 0;
  useEffect(() => {
    if (!selectFirstBracket.current) return;
    selectFirstBracket.current = false;
    const el = messageRef.current;
    if (!el) return;
    // The button that was focused is gone now (the message is not empty):
    // focus moves to the message, the first prompt selected to type over.
    el.focus();
    const range = firstOutlineBracketRange(el.value);
    if (range) el.setSelectionRange(range.start, range.end);
  }, [message]);
  const startFromOutline = () => {
    touch("message");
    setOutlineUsed(true);
    selectFirstBracket.current = true;
    setMessage(
      normaliseOutline(String(t("bookingStandards.platform.perform.outline"))),
    );
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // While performer mode is being turned on, the sender's status is only
    // optimistic: a send now could be refused (or race the revert).
    if (createMutation.isPending || enablePending || !sender) return;

    const result = buildBookingRequestPayloadWithBill(formValues);
    if (!result.ok) {
      // Show every unmet REQUIRED item now too, so one round of fixes covers
      // both problems.
      std.flagLive();
      setError(
        String(
          result.errorKey === "admin.bkErrBillTooLong"
            ? t(result.errorKey, { max: BOOKING_BILL_MAX_ROWS })
            : t(result.errorKey),
        ),
      );
      return;
    }

    // V1: REQUIRED items block Send here too (the server is the authority).
    // Checked over the BUILT payload — what the server will check.
    const unmet = std.gate(result.payload);
    if (unmet) {
      setError(unmet);
      return;
    }

    setError(null);
    createMutation.mutate(
      {
        performerOwnerType: sender.ownerType,
        performerOwnerId: sender.ownerId,
        placeId,
        ...(calendarId ? { calendarId } : {}),
        ...result.payload,
      },
      {
        onSuccess,
        onError: (err) => {
          setError(
            std.serverError(err) ??
              String(t(mapCreateBookingRequestError(err))),
          );
        },
      },
    );
  };

  const partClass = hasRail ? standardsStyles.part : standardsStyles.partFlat;

  /** A field's label, with the place's marker beside it when it lists one. */
  const labelRow = (field: BookingStandardField, label: ReactNode) => {
    const marker = std.marker(field);
    return marker ? (
      <div className={standardsStyles.labelRow}>
        {label}
        {marker}
      </div>
    ) : (
      label
    );
  };

  return (
    <div className={standardsStyles.container}>
    <form
      className={
        hasRail
          ? `${formStyles.panel} ${standardsStyles.withRail}`
          : formStyles.panel
      }
      onSubmit={handleSubmit}
      aria-label={String(t("admin.peBlockKindRequestToPlay"))}
    >
      <div className={`${partClass} ${standardsStyles.head}`}>
      {senderGone && (
        <p className={formStyles.errorText} role="alert">
          {String(t("admin.bkBillSenderGone"))}
        </p>
      )}

      {(senders.length > 1 || senderGone) && (
        <div className={formStyles.fieldGroup}>
          <label className={formStyles.fieldLabel} htmlFor={`${idBase}-sender`}>
            {String(t("admin.bkFormSenderLabel"))}
          </label>
          <select
            id={`${idBase}-sender`}
            className={formStyles.select}
            value={sender ? keyOf(sender) : ""}
            onChange={(e) => setSenderKey(e.target.value)}
          >
            {!sender && <option value="" disabled />}
            {senders.map((s) => (
              <option key={keyOf(s)} value={keyOf(s)}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Which programming stream the pitch is for; hidden when the place
          has only one that takes pitches (the default is preselected). */}
      {calendars.length > 1 && (
        <div className={formStyles.fieldGroup}>
          <label
            className={formStyles.fieldLabel}
            htmlFor={`${idBase}-calendar`}
          >
            {String(t("admin.bkFormCalendarLabel"))}
          </label>
          <select
            id={`${idBase}-calendar`}
            className={formStyles.select}
            value={calendarId ?? ""}
            onChange={(e) => {
              setCalendarId(e.target.value || null);
              // The shortlist was picked against the old calendar's nights.
              setDates([""]);
            }}
          >
            {calendars.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Quiet affordance so a pre-filled form doesn't look mysterious — only
          when the selected sender actually has saved defaults. */}
      {defaultsQuery.data?.hasSaved && (
        <p className={formStyles.fieldHint}>
          {String(t("admin.bkFormPrefillNote"))}
        </p>
      )}

      {/* FR-008: crowd-sourced venue context (review count, would-play-again,
          median payout). Lives with the other read-only meta notes — below the
          sender chrome, above the first input section. A late-arriving line
          nudges the fields down once (same behavior as the prefill note
          above); it resolves a single query (retry: false) and never blocks
          interaction. Renders nothing while loading or when no snapshot is
          published. */}
      <RequestToPlayStatsLine placeId={placeId} />
      </div>

      {/* ── What the place expects (FR-005, board S1): beside the fields
          when there is room, above them (folded after the first view)
          when there is not. ─────────────────────────────────────────── */}
      {std.checklist && (
        <BookingStandardsRail
          idBase={idBase}
          placeId={placeId}
          placeName={placeName}
          calendarName={routedCalendar?.name ?? null}
          checklist={std.checklist}
        />
      )}

      <div className={`${partClass} ${standardsStyles.body}`}>
      {/* ── Your act ──────────────────────────────────────────────────── */}
      <div
        className={formStyles.section}
        role="group"
        aria-labelledby={`${idBase}-sec-act`}
      >
        <p className={formStyles.sectionHeading} id={`${idBase}-sec-act`}>
          {String(t("admin.bkFormSectionAct"))}
        </p>

        <div className={formStyles.fieldGroup}>
          <label
            className={formStyles.fieldLabel}
            htmlFor={`${idBase}-actName`}
          >
            {String(t("admin.bkFormActNameLabel"))} ·{" "}
            {String(t("admin.bkFormOptional"))}
          </label>
          <input
            id={`${idBase}-actName`}
            type="text"
            maxLength={BOOKING_ACT_NAME_MAX}
            className={formStyles.input}
            value={actName}
            onChange={(e) => {
              touch("actName");
              setActName(e.target.value);
            }}
            placeholder={String(t("admin.bkFormActNamePlaceholder"))}
          />
        </div>

        <div className={formStyles.fieldRow}>
          <div className={formStyles.fieldGroup}>
            {labelRow(
              "LINEUP_SIZE",
              <label
                className={formStyles.fieldLabel}
                htmlFor={`${idBase}-lineup`}
              >
                {String(t("admin.bkFormLineupLabel"))}
                {std.optionalSuffix("LINEUP_SIZE")}
              </label>,
            )}
            <input
              id={`${idBase}-lineup`}
              type="number"
              inputMode="numeric"
              min={BOOKING_LINEUP_MIN}
              max={BOOKING_LINEUP_MAX}
              step={1}
              className={formStyles.input}
              value={lineupSize}
              aria-required={std.isRequired("LINEUP_SIZE") || undefined}
              aria-invalid={std.invalid("LINEUP_SIZE")}
              aria-describedby={std.describedBy("LINEUP_SIZE")}
              onChange={(e) => {
                touch("lineupSize");
                std.clear("LINEUP_SIZE");
                setLineupSize(e.target.value);
              }}
            />
            {std.line("LINEUP_SIZE")}
          </div>

          <div className={formStyles.fieldGroup}>
            <label
              className={formStyles.fieldLabel}
              htmlFor={`${idBase}-phone`}
            >
              {String(t("admin.bkFormPhoneLabel"))} ·{" "}
              {String(t("admin.bkFormOptional"))}
            </label>
            <input
              id={`${idBase}-phone`}
              type="tel"
              inputMode="tel"
              maxLength={30}
              className={formStyles.input}
              value={contactPhone}
              onChange={(e) => {
                touch("contactPhone");
                setContactPhone(e.target.value);
              }}
              placeholder={String(t("admin.bkFormPhonePlaceholder"))}
            />
          </div>
        </div>

        {sender && (
          <BookingBillEditor
            idBase={idBase}
            sender={{
              ownerType: sender.ownerType,
              ownerId: sender.ownerId,
              performerEnabled: senderPerformerEnabled,
            }}
            selfName={actName.trim() || sender.label}
            includeSelf={billIncludeSelf}
            onIncludeSelfChange={setBillSelfChoice}
            acts={billActs}
            onActsChange={(next) => {
              std.clear("BILL");
              setBillActs(next);
            }}
            onEnablePerformerMode={() => onEnablePerformerMode(sender)}
            enablePending={enablePending}
            enableError={enableError}
            required={std.isRequired("BILL")}
            standardMarker={std.marker("BILL")}
            describedBy={std.describedBy("BILL")}
          />
        )}
        {sender && std.line("BILL")}
      </div>

      {/* ── The pitch ─────────────────────────────────────────────────── */}
      <div
        className={formStyles.section}
        role="group"
        aria-labelledby={`${idBase}-sec-pitch`}
      >
        <p className={formStyles.sectionHeading} id={`${idBase}-sec-pitch`}>
          {String(t("admin.bkFormSectionPitch"))}
        </p>

        <div className={formStyles.fieldGroup}>
          <div className={standardsStyles.labelRow}>
            <label
              className={formStyles.fieldLabel}
              htmlFor={`${idBase}-message`}
            >
              {String(t("admin.bkFormMessageLabel"))}
            </label>
            {std.marker("MESSAGE")}
            {/* FR-010 / T1: only while the message is empty. */}
            {offerOutline && (
              <button
                type="button"
                className={standardsStyles.textAction}
                onClick={startFromOutline}
                disabled={createMutation.isPending}
              >
                {String(t("admin.bkStdOutlineButton"))}
              </button>
            )}
          </div>
          <textarea
            id={`${idBase}-message`}
            ref={messageRef}
            className={formStyles.textarea}
            value={message}
            onChange={(e) => {
              touch("message");
              setMessage(e.target.value);
            }}
            placeholder={String(t("admin.bkFormMessagePlaceholder"))}
            maxLength={2000}
            required
            aria-describedby={std.describedBy(
              "MESSAGE",
              `${idBase}-message-hint`,
              showOutlineHint && `${idBase}-outline-hint`,
            )}
          />
          <p className={formStyles.fieldHint} id={`${idBase}-message-hint`}>
            {String(t("admin.bkFormMessageHint"))}
          </p>
          {std.line("MESSAGE")}
          <div className={standardsStyles.pitchFooter}>
            {showOutlineHint && (
              <p className={formStyles.fieldHint} id={`${idBase}-outline-hint`}>
                {String(t("admin.bkStdOutlineHint"))}
              </p>
            )}
            {/* A hint, never a block: the server knows nothing of outlines. */}
            <span className={standardsStyles.bracketCount} aria-live="polite">
              {showOutlineHint
                ? String(t("admin.bkStdOutlineLeft", { count: bracketsLeft }))
                : ""}
            </span>
          </div>
        </div>

        <div className={formStyles.fieldGroup}>
          {labelRow(
            "PREFERRED_DATES",
            <span
              className={formStyles.fieldLabel}
              id={`${idBase}-dates-label`}
            >
              {String(t("admin.bkFormDatesLabel"))}
            </span>,
          )}
          <p className={formStyles.fieldHint}>
            {String(t("booking.pickerHint"))}
          </p>
          {std.line("PREFERRED_DATES")}
          <BookingDatePicker
            placeId={placeId}
            {...(calendarId ? { calendarId } : {})}
            value={dates.filter(Boolean)}
            onChange={setDates}
            max={BOOKING_MAX_DATES}
            disabled={createMutation.isPending}
          />
        </div>
      </div>

      {/* ── Performance ───────────────────────────────────────────────── */}
      <div
        className={formStyles.section}
        role="group"
        aria-labelledby={`${idBase}-sec-performance`}
      >
        <p
          className={formStyles.sectionHeading}
          id={`${idBase}-sec-performance`}
        >
          {String(t("admin.bkFormSectionPerformance"))}
        </p>

        <div className={formStyles.fieldRow}>
          <div className={formStyles.fieldGroup}>
            {labelRow(
              "SET_LENGTH",
              <label
                className={formStyles.fieldLabel}
                htmlFor={`${idBase}-setLength`}
              >
                {String(t("admin.bkFormSetLengthLabel"))}
                {std.optionalSuffix("SET_LENGTH")}
              </label>,
            )}
            <select
              id={`${idBase}-setLength`}
              className={formStyles.select}
              value={setLength}
              aria-required={std.isRequired("SET_LENGTH") || undefined}
              aria-invalid={std.invalid("SET_LENGTH")}
              aria-describedby={std.describedBy("SET_LENGTH")}
              onChange={(e) => {
                touch("setLength");
                std.clear("SET_LENGTH");
                setSetLength(e.target.value);
              }}
            >
              <option value="">{String(t("admin.bkFormUnspecified"))}</option>
              {BOOKING_SET_LENGTH_PRESETS.map((minutes) => (
                <option key={minutes} value={String(minutes)}>
                  {formatSetLength(minutes)}
                </option>
              ))}
            </select>
            {std.line("SET_LENGTH")}
          </div>

          <div className={formStyles.fieldGroup}>
            {labelRow(
              "EXPECTED_DRAW",
              <label
                className={formStyles.fieldLabel}
                htmlFor={`${idBase}-draw`}
              >
                {String(t("admin.bkFormDrawLabel"))}
                {std.optionalSuffix("EXPECTED_DRAW")}
              </label>,
            )}
            <input
              id={`${idBase}-draw`}
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              className={formStyles.input}
              value={expectedDraw}
              aria-required={std.isRequired("EXPECTED_DRAW") || undefined}
              aria-invalid={std.invalid("EXPECTED_DRAW")}
              aria-describedby={std.describedBy(
                "EXPECTED_DRAW",
                `${idBase}-draw-hint`,
              )}
              onChange={(e) => {
                std.clear("EXPECTED_DRAW");
                setExpectedDraw(e.target.value);
              }}
            />
            <p className={formStyles.fieldHint} id={`${idBase}-draw-hint`}>
              {String(t("admin.bkFormDrawHint"))}
            </p>
            {std.line("EXPECTED_DRAW")}
          </div>
        </div>

        <div className={formStyles.fieldGroup}>
          {labelRow(
            "GENRE",
            <label className={formStyles.fieldLabel} htmlFor={`${idBase}-genre`}>
              {String(t("admin.bkFormGenreLabel"))}
              {std.optionalSuffix("GENRE")}
            </label>,
          )}
          <input
            id={`${idBase}-genre`}
            type="text"
            maxLength={120}
            className={formStyles.input}
            value={genre}
            aria-required={std.isRequired("GENRE") || undefined}
            aria-invalid={std.invalid("GENRE")}
            aria-describedby={std.describedBy("GENRE")}
            onChange={(e) => {
              touch("genre");
              std.clear("GENRE");
              setGenre(e.target.value);
            }}
            placeholder={String(t("admin.bkFormGenrePlaceholder"))}
          />
          {std.line("GENRE")}
        </div>

        <div className={formStyles.fieldGroup}>
          {labelRow(
            "TECH_NEEDS",
            <label className={formStyles.fieldLabel} htmlFor={`${idBase}-tech`}>
              {String(t("admin.bkFormTechNeedsLabel"))}
              {std.optionalSuffix("TECH_NEEDS")}
            </label>,
          )}
          <textarea
            id={`${idBase}-tech`}
            className={formStyles.textarea}
            value={techNeeds}
            aria-required={std.isRequired("TECH_NEEDS") || undefined}
            aria-invalid={std.invalid("TECH_NEEDS")}
            aria-describedby={std.describedBy("TECH_NEEDS")}
            onChange={(e) => {
              touch("techNeeds");
              std.clear("TECH_NEEDS");
              setTechNeeds(e.target.value);
            }}
            placeholder={String(t("admin.bkFormTechNeedsPlaceholder"))}
            maxLength={BOOKING_TECH_NEEDS_MAX}
          />
          {std.line("TECH_NEEDS")}
        </div>
      </div>

      {/* ── Fee ───────────────────────────────────────────────────────── */}
      <div
        className={formStyles.section}
        role="group"
        aria-labelledby={`${idBase}-sec-fee`}
      >
        <p className={formStyles.sectionHeading} id={`${idBase}-sec-fee`}>
          {String(t("admin.bkFormSectionFee"))}
        </p>

        <div className={formStyles.fieldRow}>
          <div
            className={`${formStyles.fieldGroup} ${formStyles.feeTypeGroup}`}
          >
            {labelRow(
              "FEE",
              <label
                className={formStyles.fieldLabel}
                htmlFor={`${idBase}-feeType`}
              >
                {String(t("admin.bkFormFeeTypeLabel"))}
                {std.optionalSuffix("FEE")}
              </label>,
            )}
            <select
              id={`${idBase}-feeType`}
              className={formStyles.select}
              value={feeType}
              aria-required={std.isRequired("FEE") || undefined}
              aria-invalid={std.invalid("FEE")}
              aria-describedby={std.describedBy("FEE")}
              onChange={(e) => {
                touch("feeType");
                std.clear("FEE");
                const next = e.target
                  .value as BookingRequestFormValues["feeType"];
                setFeeType(next);
                // Clear the amount whenever it can't be submitted, so a stale
                // value is never sent for Negotiable / unspecified.
                if (next !== "GUARANTEE" && next !== "DOOR_SPLIT") {
                  setFeeAmountDollars("");
                }
              }}
            >
              <option value="">{String(t("admin.bkFormUnspecified"))}</option>
              {BOOKING_FEE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {String(t(`admin.bkFeeType${type}` as const))}
                </option>
              ))}
            </select>
            {std.line("FEE")}
          </div>

          {showFeeAmount && (
            <div className={formStyles.fieldGroup}>
              <label
                className={formStyles.fieldLabel}
                htmlFor={`${idBase}-feeAmount`}
              >
                {String(t("admin.bkFormFeeAmountLabel"))} ·{" "}
                {BOOKING_FEE_CURRENCY.toUpperCase()}
              </label>
              <div className={formStyles.moneyRow}>
                <span className={formStyles.moneyPrefix} aria-hidden>
                  $
                </span>
                <input
                  id={`${idBase}-feeAmount`}
                  type="text"
                  inputMode="decimal"
                  maxLength={12}
                  className={formStyles.moneyInput}
                  value={feeAmountDollars}
                  onChange={(e) => {
                    touch("feeAmount");
                    setFeeAmountDollars(e.target.value);
                  }}
                  placeholder="0.00"
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Links ─────────────────────────────────────────────────────── */}
      <div
        className={formStyles.section}
        role="group"
        aria-labelledby={`${idBase}-sec-links`}
      >
        <p className={formStyles.sectionHeading} id={`${idBase}-sec-links`}>
          {String(t("admin.bkFormSectionLinks"))}
        </p>

        {(
          [
            {
              id: `${idBase}-linkMusic`,
              touchKey: "linkMusic",
              field: "LINK_MUSIC",
              label: "admin.bkFormLinkMusicLabel",
              value: linkMusic,
              set: setLinkMusic,
            },
            {
              id: `${idBase}-linkVideo`,
              touchKey: "linkVideo",
              field: "LINK_VIDEO",
              label: "admin.bkFormLinkVideoLabel",
              value: linkVideo,
              set: setLinkVideo,
            },
            {
              id: `${idBase}-linkSocial`,
              touchKey: "linkSocial",
              field: "LINK_SOCIAL",
              label: "admin.bkFormLinkSocialLabel",
              value: linkSocial,
              set: setLinkSocial,
            },
            {
              id: `${idBase}-linkEpk`,
              touchKey: "linkEpk",
              field: "LINK_EPK",
              label: "admin.bkFormLinkEpkLabel",
              value: linkEpk,
              set: setLinkEpk,
            },
          ] as const
        ).map((link) => (
          <div className={formStyles.fieldGroup} key={link.id}>
            {labelRow(
              link.field,
              <label className={formStyles.fieldLabel} htmlFor={link.id}>
                {String(t(link.label))}
                {/* FR-005: a link the place requires is not optional. */}
                {std.optionalSuffix(link.field)}
              </label>,
            )}
            <input
              id={link.id}
              type="url"
              className={formStyles.input}
              value={link.value}
              placeholder="https://"
              aria-required={std.isRequired(link.field) || undefined}
              aria-invalid={std.invalid(link.field)}
              aria-describedby={std.describedBy(link.field)}
              onChange={(e) => {
                touch(link.touchKey);
                std.clear(link.field);
                link.set(e.target.value);
              }}
            />
            {std.line(link.field)}
          </div>
        ))}
      </div>

      {/* Verified-stats opt-in — HUMAN senders only (FR-009), and only when
          their stats clear the sharing threshold: orgs have no stats aggregate
          and an ineligible human would just snapshot null. Independent of the
          public stats block's visibility. */}
      {sender?.ownerType === "human" && humanStatsEligible && (
        <div className={formStyles.fieldGroup}>
          <label className={formStyles.checkboxRow} htmlFor={`${idBase}-stats`}>
            <input
              id={`${idBase}-stats`}
              type="checkbox"
              className={formStyles.checkbox}
              checked={includeVerifiedStats}
              onChange={(e) => {
                touch("includeVerifiedStats");
                setIncludeVerifiedStats(e.target.checked);
              }}
            />
            <span className={formStyles.checkboxText}>
              <span>{String(t("admin.bkFormIncludeStatsLabel"))}</span>
              <span className={formStyles.fieldHint}>
                {String(t("admin.bkFormIncludeStatsHint"))}
              </span>
            </span>
          </label>
        </div>
      )}

      {error && (
        <p className={formStyles.errorText} role="alert" aria-live="assertive">
          {error}
        </p>
      )}

      <div className={formStyles.submitRow}>
        <BookingSubmitButton
          pending={createMutation.isPending || enablePending}
        />
      </div>
      </div>
    </form>
    </div>
  );
}
