"use client";

import { memo } from "react";
import { useParams } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { styled, XStack, YStack } from "tamagui";
import type { inferRouterOutputs } from "@trpc/server";

import {
  Badge,
  NextLinkAnchor,
  Text,
  useFormatters,
  useTranslations,
} from "@th/ui";
import type { AppRouter } from "@th/trpc";

import { trpc } from "@/trpc";
import {
  adminAgreementHref,
  adminBookingHref,
  standaloneAgreementHref,
} from "@/lib/agreement-routes";
import {
  AGREEMENT_STATUS_LABEL_KEYS,
  agreementStatusTone,
} from "@/lib/booking-agreements";
import { fmtCurrency, fmtDateShort } from "@/lib/format";

import { FormSection } from "./_builder-styled";

/**
 * "Where did this event come from?" — the breadcrumb back up the booking chain,
 * rendered at the top of the event's Build surface.
 *
 * Two chains land here, told apart by whether an AGREEMENT exists:
 *
 *  - REQUEST-FIRST (agreement present): the event was minted from a booking
 *    (event → agreement → booking request). The note is the agreement's
 *    breadcrumb — status, terms summary, links to the agreement and thread —
 *    plus the requester's "confirmed by the venue" line.
 *  - EVENT-FIRST (agreement null): the organizer named a third-party venue in
 *    THIS builder and the save created the booking request the venue
 *    confirms (venue-confirmation spec, "Two entry paths, one request"). No
 *    agreement exists until the venue accepts. The note is the TIE BAND —
 *    where the venue's confirmation of this event stands: awaiting / venue
 *    not yet claimed / confirmed / withdrawn — with a link into the request.
 *    It is also rendered straight from the save's `bookingRequest` result
 *    (`bookingRequest` prop) so it appears the moment the save lands, before
 *    the provenance refetch.
 *
 * THREE RULES THIS COMPONENT EXISTS TO HOLD.
 *
 * 1. NOTHING AT ALL when there is no provenance. `events.getEventProvenance`
 *    returns `null` for the COMMON case — most events were never booked
 *    through a request, and an OWNED or GRANTED venue's event has no request
 *    (confirmed by construction). Rendering an empty "no booking request"
 *    panel on every event would put a permanent piece of noise on the busiest
 *    admin surface in the product. No wrapper, no gap, no heading: the
 *    component returns `null`.
 *
 * 2. NEVER LOAD-BEARING. This is progressive enhancement over an editor that
 *    has to keep working. A failed/loading query renders nothing (never an
 *    error box, never a skeleton that flashes on an event that has no
 *    provenance anyway), and the query is `meta: { silent: true }` so
 *    `GlobalQueryErrorLogger` does not toast "Something went wrong" over an
 *    editor whose actual job is unaffected. Sentry still sees it through the
 *    console/react-query path.
 *
 * 3. `direction` DRIVES THE WORDING, in both directions. `senderDisplayName`
 *    is always the ACT — but the act is the one who ASKED under `TO_VENUE`
 *    (a performer pitched this venue) and the one who WAS asked under
 *    `TO_PERFORMER` (the organizer went out to the act). One sentence for both
 *    would state the relationship backwards half the time, so there are two
 *    keys and the direction picks between them. When the name doesn't resolve
 *    (a deleted owner, a corrupt sender row the use case degrades to `null`)
 *    the DIRECTION still survives — the sentence keeps its shape and takes a
 *    generic act noun, rather than collapsing to a directionless line.
 *
 * Authorization: the procedure is gated by `ensureActorCanEditEvent`, so this
 * only mounts inside the builder's edit-capable branch. Read-only roles
 * (FINANCE / VIEWER / SCANNER) get the preview surface, which never renders
 * this — the query is therefore never fired into a guaranteed FORBIDDEN.
 *
 * TWO LINKS, both into the admin shell the editor is already in. "View
 * agreement" goes to `/admin/[slug]/bookings/agreement/[id]` (the editor's
 * copy of the agreement, one click from the booking); "Open booking thread" /
 * "Open the request" go to `/admin/[slug]/bookings?request=<id>`, which the
 * inbox honours by landing on the row's stage tab with the row expanded. The
 * thread link only renders when the request row still exists — a severed
 * thread has nowhere to go. All go through `@/lib/agreement-routes`, so a
 * route rename is one edit. The slug comes from the route params; if this
 * ever mounts outside `/admin/[slug]/…` the agreement link degrades to the
 * standalone page and the thread link is withheld rather than pointing at a
 * 404.
 *
 * READ-ONLY. The terms summary (date, guarantee, how many payout lines the
 * terms carry) is a statement of what the agreement says, read straight off
 * its row by `getEventProvenance`; the event never edits the deal. The line
 * count counts EVERY line on the terms — declined and countered included —
 * which is why the copy says "listed", not "agreed".
 */

/**
 * Strict Swiss aside: square, a 2px rule on the leading edge (a GRAPHIC — it
 * carries no text, so the raw state hues are legal there at the 3:1 non-text
 * floor), muted fill so it reads as history rather than as an alert. Mirrors
 * `EventTimezoneNote`'s `AdoptedNote`, the builder's existing idiom for "a
 * calm statement of fact about this event".
 *
 * The `state` variant recolours ONLY the rule: awaiting keeps the accent
 * (history), parked warns, confirmed is success, withdrawn is danger. Colour
 * is never the only signal — every state has its own sentence.
 */
const ProvenanceAside = styled(YStack, {
  gap: 8,
  paddingVertical: 12,
  paddingHorizontal: 14,
  borderRadius: 0,
  borderLeftWidth: 2,
  borderLeftColor: "$accent",
  backgroundColor: "$surfaceMuted",
  variants: {
    state: {
      awaiting: { borderLeftColor: "$accent" },
      parked: { borderLeftColor: "$warning" },
      confirmed: { borderLeftColor: "$success" },
      withdrawn: { borderLeftColor: "$danger" },
    },
  } as const,
});

/**
 * Header row and footer row both wrap. Tamagui inherits RN's `flexShrink: 0`,
 * so `flexWrap` only helps children narrower than the row (they move to a new
 * line). A child that can be wider than the row — user text, a long
 * translation — also needs `flexShrink: 1` + `maxWidth: 100%` so it wraps its
 * own text instead of overflowing (see `TermItem`, `LinkTarget`).
 */
const ProvenanceRow = styled(XStack, {
  gap: 10,
  alignItems: "center",
  flexWrap: "wrap",
});

/**
 * The agreed-terms summary: a wrapping row of label-over-value pairs, on the
 * aside's compact scale. Not a nested card — no fill, no border — just a
 * hairline rule above it so it reads as a second paragraph of the same note.
 */
const TermsRow = styled(XStack, {
  gap: 20,
  rowGap: 8,
  flexWrap: "wrap",
  paddingTop: 8,
  borderTopWidth: 1,
  borderTopColor: "$borderColorSoft",
});

// Tamagui inherits RN's `flexShrink: 0`, so in this wrapping row a value wider
// than the line (a long agreement title) kept its full single-line width and
// overflowed the aside instead of wrapping. `flexShrink: 1` + `maxWidth: 100%`
// lets an item that is alone on its line shrink to it and wrap its text.
const TermItem = styled(YStack, {
  gap: 2,
  minWidth: 0,
  flexShrink: 1,
  maxWidth: "100%",
});

/** Wrapper carries the 44px touch target; the anchor itself stays text-sized. */
const LinkTarget = styled(XStack, {
  alignItems: "center",
  gap: 6,
  minHeight: 44,
  minWidth: 0,
  flexShrink: 1,
  maxWidth: "100%",
});

/**
 * lucide takes a real CSS colour, not a Tamagui token. `accentText`, not
 * `accent`: this glyph belongs to an interactive control's label, and raw
 * accent is 3.57:1 as small text on Stub. The Stub hex is the fallback because
 * that is what first paint renders.
 */
const ARROW_COLOR = "var(--accentText, #A8300F)";

type Provenance = NonNullable<
  inferRouterOutputs<AppRouter>["events"]["getEventProvenance"]
>;

/**
 * The save's own account of the booking request it created or found
 * (`events.createEventForHuman` / `createEventForOrg` → `bookingRequest`).
 * The builder hands it here straight from the mutation result. The wire is
 * a union on `outcome`; the `skipped` member (the venue refused the ask) is
 * not a request and is narrowed away by the builder before it gets here —
 * rendering the refusal is its own surface, not this band's.
 */
export type JustSavedBookingRequest = Extract<
  NonNullable<
    inferRouterOutputs<AppRouter>["events"]["createEventForHuman"]["bookingRequest"]
  >,
  { outcome: "created" | "existing" }
>;

/** The tie band's four states. */
export type VenueTieBandState =
  | "awaiting"
  | "parked"
  | "confirmed"
  | "withdrawn";

type RequestStatus = NonNullable<Provenance["bookingRequest"]>["status"];

/** A request the venue answered no to, the requester pulled, or that lapsed. */
const TERMINAL_REQUEST_STATUSES: ReadonlySet<RequestStatus> = new Set([
  "DECLINED",
  "WITHDRAWN",
  "EXPIRED",
]);

/**
 * Which band a request + stance resolves to, or `null` for NO band.
 *
 * The venue's STAMP wins: confirmed and withdrawn are explicit acts on this
 * event and render whatever the request row says. Without a stamp, a request
 * that is declined, withdrawn by the requester, or expired is not "awaiting"
 * anything — nothing is coming — so no band renders (ruling 2026-09-08; the
 * copy for a fifth state is the owner's call, not invented here). `parked`
 * (the venue has not claimed its page) only matters while nothing has been
 * decided.
 */
export function venueTieBandState(args: {
  state: Provenance["venueConfirmation"]["state"] | undefined;
  parked: boolean;
  status?: RequestStatus;
}): VenueTieBandState | null {
  switch (args.state) {
    case "confirmed":
      return "confirmed";
    case "withdrawn":
      return "withdrawn";
    default:
      if (args.status !== undefined && TERMINAL_REQUEST_STATUSES.has(args.status)) {
        return null;
      }
      return args.parked ? "parked" : "awaiting";
  }
}

const BAND_HEADLINE_KEY: Record<VenueTieBandState, string> = {
  awaiting: "admin.ebReqSent",
  parked: "admin.ebReqParked",
  confirmed: "admin.ebReqConfirmed",
  withdrawn: "admin.ebReqWithdrawn",
};

const BAND_NOTE_KEY: Record<VenueTieBandState, string> = {
  awaiting: "admin.ebReqAddressOnly",
  parked: "admin.ebReqAddressOnly",
  confirmed: "admin.ebReqConfirmedNote",
  withdrawn: "admin.ebReqWithdrawnNote",
};

export type EventProvenanceNoteProps = {
  /** The event whose provenance chain is being walked backwards. */
  eventId: string;
  /**
   * The request the LAST save of this editor created or found, so the band
   * renders the moment the save lands. The provenance query wins whenever it
   * has data; this only fills the gap (a cached `null` from before the save,
   * or the refetch still in flight).
   */
  bookingRequest?: JustSavedBookingRequest | null;
  testId?: string;
};

function EventProvenanceNoteImpl({
  eventId,
  bookingRequest: justSaved = null,
  testId = "event-provenance-note",
}: EventProvenanceNoteProps) {
  const t = useTranslations();
  const fmt = useFormatters();
  // The admin slug this editor is mounted under. `useParams` rather than a
  // prop: `EventBuilder.slug` is optional and this is the one consumer that
  // must not silently build a link to `/admin/undefined/…`.
  const params = useParams<{ slug?: string }>();
  const slug = typeof params?.slug === "string" ? params.slug : null;

  const provenanceQuery = trpc.events.getEventProvenance.useQuery(
    { eventId },
    {
      enabled: Boolean(eventId),
      // The chain only changes when someone finalizes or unlinks an
      // agreement, or the venue answers — minutes-scale, not seconds-scale.
      // The builder invalidates it after a save.
      staleTime: 60_000,
      // One retry, then give up quietly. This must never keep a failing
      // request in flight behind an editor the user is trying to use.
      retry: 1,
      // Rule 2: no toast. A breadcrumb that cannot load is not an incident
      // the editor's user can do anything about.
      meta: { silent: true },
    },
  );

  // Rule 1 + rule 2 in one expression: no provenance, still loading, or the
  // query failed → this surface renders nothing whatsoever — unless the save
  // just told us about a request the query has not caught up with.
  const provenance = provenanceQuery.data;
  if (!provenance && !justSaved) return null;

  const venueFallback = String(t("admin.ebProvVenueFallback"));

  // ── Event-first: the tie band ──────────────────────────────────────────
  if (!provenance?.agreement) {
    const band = provenance?.bookingRequest
      ? {
          state: venueTieBandState({
            state: provenance.venueConfirmation?.state,
            parked: provenance.bookingRequest.parked,
            status: provenance.bookingRequest.status,
          }),
          placeName:
            provenance.bookingRequest.placeName ??
            provenance.venueConfirmation?.placeName ??
            null,
          requestId: provenance.bookingRequest.id,
        }
      : justSaved
        ? {
            // A request this save CREATED cannot be confirmed yet; one it
            // FOUND may be, but then the provenance refetch (invalidated by
            // the same save) takes over within the round trip.
            state: venueTieBandState({
              state: undefined,
              parked: justSaved.parked,
            }),
            placeName: justSaved.placeName,
            requestId: justSaved.id,
          }
        : null;
    const bandState = band?.state ?? null;
    if (!band || !bandState) return null;

    const place = band.placeName ?? venueFallback;
    const requestHref = slug ? adminBookingHref(slug, band.requestId) : null;

    return (
      // The `FormSection` gutter lives INSIDE the early-return, not around
      // this component at the call site — see the agreement branch below.
      <FormSection>
        <ProvenanceAside
          state={bandState}
          data-testid={testId}
          data-state={bandState}
        >
          <ProvenanceRow>
            <Text variant="overline" tone="muted">
              {String(t("admin.ebReqKicker"))}
            </Text>
          </ProvenanceRow>

          {/* The live region is the STATEMENT only — headline + note. The
              link below stays outside it: a control inside a live region
              gets re-announced with every state change. */}
          <YStack
            gap={8}
            role="status"
            data-testid={`${testId}-band-status`}
          >
            {/* The venue reads first: every state's sentence starts with it. */}
            <Text
              variant="bodySmall"
              weight="bold"
              data-testid={`${testId}-band-headline`}
            >
              {String(t(BAND_HEADLINE_KEY[bandState], { place }))}
            </Text>
            <Text variant="bodySmall" data-testid={`${testId}-band-note`}>
              {String(t(BAND_NOTE_KEY[bandState]))}
            </Text>
          </YStack>

          {requestHref ? (
            <ProvenanceRow>
              <NextLinkAnchor
                href={requestHref}
                data-testid={`${testId}-thread-link`}
              >
                <LinkTarget>
                  <Text
                    variant="caption"
                    weight="bold"
                    color="$accentText"
                    textTransform="uppercase"
                    letterSpacing={1.2}
                    flexShrink={1}
                  >
                    {String(t("admin.ebReqOpen"))}
                  </Text>
                  <ArrowRight
                    size={13}
                    strokeWidth={2.5}
                    color={ARROW_COLOR}
                    aria-hidden
                  />
                </LinkTarget>
              </NextLinkAnchor>
            </ProvenanceRow>
          ) : null}
        </ProvenanceAside>
      </FormSection>
    );
  }

  // ── Request-first: the agreement breadcrumb ────────────────────────────
  const { agreement, bookingRequest, venueConfirmation } = provenance;

  // `senderDisplayName` is the ACT in both directions; the direction decides
  // whether the act asked or was asked. A null name keeps the sentence (and
  // therefore the relationship) and takes a generic act noun.
  const actName =
    bookingRequest?.senderDisplayName ??
    String(t("admin.ebProvActFallback"));

  const sentence = bookingRequest
    ? String(
        t(
          bookingRequest.direction === "TO_VENUE"
            ? "admin.ebProvFromAct"
            : "admin.ebProvToAct",
          { name: actName },
        ),
      )
    : // The request row is gone (`BookingRequest.agreementId` is
      // `onDelete: SetNull`, so deleting an agreement severs the thread while
      // the event's agreement link survives) or the agreement was authored
      // outside the booking flow. Degrade to the fact that still holds.
      String(t("admin.ebProvAgreementOnly"));

  const agreementHref = slug
    ? adminAgreementHref(slug, agreement.id)
    : standaloneAgreementHref(agreement.id);
  const threadHref =
    slug && bookingRequest ? adminBookingHref(slug, bookingRequest.id) : null;

  // "—" for an unset value, never a blank cell: the label is still rendered
  // so the reader learns the deal HAS no guarantee, not that we forgot.
  // Compared as RENDERED days, so a same-day end never reads "Sep 4 – Sep 4".
  const startText = agreement.proposedDate
    ? fmtDateShort(fmt, agreement.proposedDate)
    : null;
  const endText = agreement.proposedEndDate
    ? fmtDateShort(fmt, agreement.proposedEndDate)
    : null;
  const dateText =
    startText === null
      ? "—"
      : endText !== null && endText !== startText
        ? `${startText} – ${endText}`
        : startText;
  const guaranteeText =
    agreement.guaranteeCents === null
      ? "—"
      : fmtCurrency(fmt, agreement.guaranteeCents, "USD");

  return (
    // The `FormSection` gutter lives INSIDE the early-return, not around this
    // component at the call site: wrapping it out there would leave a 32px
    // padded band on every event that has no provenance — which is most of
    // them — and "renders nothing" has to mean nothing, gap included.
    <FormSection>
      <ProvenanceAside data-testid={testId}>
        <ProvenanceRow>
          {/* Same kicker idiom as the event-first band above: one mono
              overline for both branches, so the note never wears two fonts
              depending on how the event was booked. */}
          <Text variant="overline" tone="muted">
            {String(t("admin.ebProvLabel"))}
          </Text>
          <Badge
            tone={agreementStatusTone(agreement.status)}
            size="xs"
            data-testid={`${testId}-status`}
          >
            {String(t(AGREEMENT_STATUS_LABEL_KEYS[agreement.status]))}
          </Badge>
        </ProvenanceRow>

        <Text variant="bodySmall">{sentence}</Text>

        {/* The requester's banner (venue-confirmation spec, "Requester's
            admin"): a RENT/USE confirmation lands a DRAFT in THEIR admin, and
            this is the line that tells them the venue already said yes. Only
            on a REQUESTER-owned, confirmed event — a venue reading its own
            show is not being told anything, and an unconfirmed or withdrawn
            one has nothing to celebrate (the public page is address-only
            either way). Optional-chained: an older payload carries no
            stance, and the note must keep rendering the chain without it. */}
        {venueConfirmation?.state === "confirmed" &&
        venueConfirmation.ownerSide === "requester" ? (
          <Text
            variant="bodySmall"
            weight="bold"
            data-testid={`${testId}-venue-confirmed`}
          >
            {String(
              t("admin.ebProvVenueConfirmed", {
                place: venueConfirmation.placeName ?? venueFallback,
              }),
            )}
          </Text>
        ) : null}

        {/* `DRAFT_EVENT` means the event was minted from the booking but the
            agreement was never finalized ONTO it (payout lines unconfirmed, or
            a payee who can't receive payouts yet). Saying so beats letting the
            reader assume "linked" means "done". */}
        {agreement.linkedVia === "DRAFT_EVENT" ? (
          <Text variant="caption" tone="muted" data-testid={`${testId}-draft`}>
            {String(t("admin.ebProvDraftNote"))}
          </Text>
        ) : null}

        {/* What the agreement says, so the reader can check the event
            against the deal without leaving the editor. */}
        <TermsRow data-testid={`${testId}-terms`}>
          <TermItem>
            <Text variant="overline" tone="muted">
              {String(t("admin.ebProvAgreementLabel"))}
            </Text>
            <Text
              variant="bodySmall"
              style={{ overflowWrap: "anywhere" }}
              data-testid={`${testId}-title`}
            >
              {agreement.title}
            </Text>
          </TermItem>
          <TermItem>
            <Text variant="overline" tone="muted">
              {String(t("admin.ebProvDateLabel"))}
            </Text>
            <Text variant="bodySmall" data-testid={`${testId}-date`}>
              {dateText}
            </Text>
          </TermItem>
          <TermItem>
            <Text variant="overline" tone="muted">
              {String(t("admin.ebProvGuaranteeLabel"))}
            </Text>
            <Text variant="bodySmall" data-testid={`${testId}-guarantee`}>
              {guaranteeText}
            </Text>
          </TermItem>
          <TermItem>
            <Text variant="overline" tone="muted">
              {String(t("admin.ebProvTermsLabel"))}
            </Text>
            <Text variant="bodySmall" data-testid={`${testId}-lines`}>
              {String(
                t("admin.ebProvPayoutLines", {
                  count: agreement.payoutLineCount,
                }),
              )}
            </Text>
          </TermItem>
        </TermsRow>

        <ProvenanceRow>
          <NextLinkAnchor
            href={agreementHref}
            data-testid={`${testId}-agreement-link`}
          >
            {/* No Button inside this anchor on purpose: a `styled(Button)`
                still emits role="button" + tabindex="0", which would nest an
                interactive element inside a link and add a second tab stop on
                one rectangle. A breadcrumb wants a text link anyway. */}
            <LinkTarget>
              <Text
                variant="caption"
                weight="bold"
                color="$accentText"
                textTransform="uppercase"
                letterSpacing={1.2}
                flexShrink={1}
              >
                {String(t("admin.ebProvViewAgreement"))}
              </Text>
              <ArrowRight
                size={13}
                strokeWidth={2.5}
                color={ARROW_COLOR}
                aria-hidden
              />
            </LinkTarget>
          </NextLinkAnchor>

          {threadHref ? (
            <NextLinkAnchor
              href={threadHref}
              data-testid={`${testId}-thread-link`}
            >
              <LinkTarget>
                <Text
                  variant="caption"
                  weight="bold"
                  color="$accentText"
                  textTransform="uppercase"
                  letterSpacing={1.2}
                  flexShrink={1}
                >
                  {String(t("admin.ebProvOpenThread"))}
                </Text>
                <ArrowRight
                  size={13}
                  strokeWidth={2.5}
                  color={ARROW_COLOR}
                  aria-hidden
                />
              </LinkTarget>
            </NextLinkAnchor>
          ) : null}

          {/* The thread is still live — the recency stamp says so even when
              the thread link is withheld (severed request, no slug).

              ACTIVITY, NOT "LAST MESSAGE". `lastMessageAt` is bumped by every
              ledger entry as well as by human messages: opening the request
              writes `booking_request.viewed`, and saving a tracked field on
              THIS event writes `booking_event.modified` — both of which would
              otherwise date-stamp a message nobody sent, on the page the
              reader is looking at. */}
          {bookingRequest?.lastMessageAt ? (
            <Text
              variant="caption"
              tone="muted"
              data-testid={`${testId}-last-activity`}
            >
              {String(
                t("admin.ebProvLastActivity", {
                  date: fmt.dateTime(new Date(bookingRequest.lastMessageAt), {
                    dateStyle: "medium",
                  }),
                }),
              )}
            </Text>
          ) : null}
        </ProvenanceRow>
      </ProvenanceAside>
    </FormSection>
  );
}

/**
 * Memoized like its `BuilderEssentialsSection` sibling: it hangs off
 * EventBuilder, which re-renders on every keystroke in the title field. Its
 * props are a primitive and one state object whose identity only changes on
 * a save — so `memo` genuinely bails out.
 */
export const EventProvenanceNote = memo(EventProvenanceNoteImpl);

EventProvenanceNote.displayName = "EventProvenanceNote";

export default EventProvenanceNote;
