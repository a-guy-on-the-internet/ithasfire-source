"use client";

import { useMemo, useState } from "react";
import { XStack, YStack } from "tamagui";
import {
  Button,
  NextLinkAnchor,
  Spinner,
  Text,
  useFormatters,
  useTranslations,
} from "@th/ui";
import { CalendarPlus, ExternalLink } from "lucide-react";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { useEventOwnerEntities } from "@/hooks/useEventOwnerEntities";
import { CreateEventOutcomeNotice } from "@/app/agreements/[agreementId]/_components/CreateEventOutcomeNotice";
import {
  createEventExplainerCopy,
  createEventFromBookingErrorMessage,
  explainerShowDate,
  mayCreateEventFromBooking,
  venueEventEditorUrl,
  type CreateEventFromBookingOutcome,
} from "./create-event-from-booking";

// ─────────────────────────────────────────────────────────────────────────────
// FINALIZING, IN THE CONVERSATION.
//
// Getting from an accepted booking to an event used to mean leaving the thread
// for `/agreements/{id}`, opening the Finalize dialog, and finding "Create
// event from this booking" inside it. The owner's ask: "Finalizing an event
// should be on the booking chat." This is that action, rendered by
// `BookingThread`'s `nextStep` slot — directly under the terms strip, so the
// date and fee the event will be built from are one line above the button.
//
// TWO STATES, ONE SLOT:
//   - an event already exists (`eventId` from the list row) → "Open event", a
//     plain link into the venue's admin editor. No agreement read at all;
//   - no event yet → read the agreement (the SAME `bookingAgreements.get` key
//     the terms strip holds, so React Query serves both from one request) and
//     offer the action only when the agreement is ACCEPTED and
//     `mayCreateEventFromBooking` says this viewer is on the venue side.
//     Anything else renders nothing — a DRAFT agreement's next step is on the
//     agreement page, and the strip's link already goes there.
//
// NO NAVIGATION ON SUCCESS. FinalizeDialog routes straight into the editor on
// a fresh finalized mint; here the venue is mid-conversation and asked for
// this to happen in the chat, so every outcome renders inline
// (`CreateEventOutcomeNotice`, which moves focus to its Open-event link) and
// the row is left to move itself to the Event tab via the list invalidation.
//
// The owners read (`useEventOwnerEntities`) is enabled only once the agreement
// is known to be ACCEPTED, so expanding a row whose agreement is still a draft
// costs the terms read it was already paying for and nothing more.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The outcome AND the editor href it resolved to, captured together at
 * success time. The list invalidation that follows a create gives the row an
 * `eventId` a moment later, which flips this slot to its "Open event" form —
 * the outcome copy (finalized / already linked / blocked, and why) must
 * survive that flip, so it is checked FIRST in the render and its href is not
 * recomputed from a query that is by then disabled.
 */
export type CreateEventFromBookingResult = {
  result: CreateEventFromBookingOutcome;
  eventHref: string;
};

export function CreateEventFromBookingAction({
  agreementId,
  /** The request whose thread this sits in — its ledger is refreshed on success. */
  bookingRequestId,
  eventId,
  /** Where an EXISTING event opens — the caller knows the admin slug. */
  eventHref,
  /**
   * The existing event belongs to the REQUESTER (RENT / USE — a venue
   * confirmation minted it into their admin, or a create landed it there).
   * The venue has no edit access to it, so the slot says where the draft
   * lives instead of offering a link the caller cannot build honestly.
   */
  requesterOwned = false,
  /** The venue, for the explainer sentence. */
  venueName,
  testIdBase,
  outcome: controlledOutcome,
  onEventCreated,
}: {
  agreementId: string;
  bookingRequestId: string;
  eventId: string | null;
  eventHref: string | null;
  requesterOwned?: boolean;
  venueName: string | null;
  testIdBase: string;
  /**
   * OWNED BY THE CALLER when the row can move. The inbox follows a freshly
   * created event to its Event tab, and the real DataTable remounts the row's
   * subtree on that move — local state here would be lost with it and the
   * notice would never be seen (measured: it flipped straight to "Open
   * event"). The inbox therefore keeps the outcome per row id and hands it
   * back; a caller whose rows never move can leave this undefined.
   */
  outcome?: CreateEventFromBookingResult | null;
  /** Fired after a successful create so the caller can store and follow. */
  onEventCreated?: (outcome: CreateEventFromBookingResult) => void;
}) {
  const t = useTranslations();
  const fmt = useFormatters();
  const utils = trpc.useUtils();

  const [error, setError] = useState<string | null>(null);
  const [localOutcome, setLocalOutcome] =
    useState<CreateEventFromBookingResult | null>(null);
  const outcome = controlledOutcome === undefined ? localOutcome : controlledOutcome;

  const hasEvent = Boolean(eventId);

  // Same key and options as BookingTermsStrip — deduped to one request.
  const agreementQuery = trpc.bookingAgreements.get.useQuery(
    { agreementId },
    {
      staleTime: 30_000,
      retry: false,
      meta: { silent: true },
      enabled: !hasEvent,
    },
  );
  const data = agreementQuery.data;
  const agreement = data?.agreement ?? null;
  const isAccepted = agreement?.status === "ACCEPTED";

  const ownersQuery = useEventOwnerEntities({ enabled: !hasEvent && isAccepted });

  const createMutation =
    trpc.bookingAgreements.createEventFromAgreement.useMutation({
      retry: false,
      meta: { silent: true },
    });

  const explainer = useMemo(() => {
    if (!agreement) return "";
    const showDate = explainerShowDate({
      proposedDate: agreement.proposedDate,
      preferredDates: data?.bookingRequest?.preferredDates,
    });
    return createEventExplainerCopy({
      venueName: venueName ?? agreement.counterpartyDisplayName,
      dateLabel: showDate
        ? fmt.dateTime(showDate, { dateStyle: "medium" })
        : null,
      actName: agreement.proposerDisplayName,
    });
  }, [agreement, data?.bookingRequest?.preferredDates, fmt, venueName]);

  const testId = `${testIdBase}-create-event`;

  // ── Just created here: say what happened, before anything else ──────────
  if (outcome) {
    return (
      <CreateEventOutcomeNotice
        outcome={outcome.result}
        eventHref={outcome.eventHref}
      />
    );
  }

  // ── The event exists in the requester's admin: say so, link nothing ──────
  if (hasEvent && requesterOwned) {
    return (
      <XStack
        gap="$3"
        alignItems="center"
        flexWrap="wrap"
        minWidth={0}
        data-testid={`${testIdBase}-requester-owned-event`}
      >
        <Text
          variant="caption"
          weight="bold"
          tone="muted"
          textTransform="uppercase"
          letterSpacing={0.6}
        >
          {String(t("admin.bkInboxEventLinkedKicker"))}
        </Text>
        <Text variant="bodySmall" tone="muted">
          {String(t("admin.bkInboxEventRequesterOwnedNote"))}
        </Text>
      </XStack>
    );
  }

  // ── An event already exists: the slot is the way to it ──────────────────
  if (hasEvent && eventHref) {
    return (
      <XStack
        gap="$3"
        alignItems="center"
        flexWrap="wrap"
        minWidth={0}
        data-testid={`${testIdBase}-open-event`}
      >
        <Text
          variant="caption"
          weight="bold"
          tone="muted"
          textTransform="uppercase"
          letterSpacing={0.6}
        >
          {String(t("admin.bkInboxEventLinkedKicker"))}
        </Text>
        <NextLinkAnchor
          href={eventHref}
          aria-label={String(t("admin.bkInboxOpenEventCta"))}
        >
          <Button
            tag="span"
            variant="secondary"
            size="$2"
            aria-hidden
            tabIndex={-1}
            testID={`${testIdBase}-open-event-cta`}
          >
            {String(t("admin.bkInboxOpenEventCta"))}
            <ExternalLink size={13} strokeWidth={2} aria-hidden />
          </Button>
        </NextLinkAnchor>
      </XStack>
    );
  }
  if (hasEvent) return null;

  // ── No event yet: offer the action only when the venue can take it ───────
  if (!agreement || !isAccepted) return null;
  const offer = mayCreateEventFromBooking({
    bookingMinted: data?.bookingRequest != null,
    counterpartyType: agreement.counterpartyType,
    counterpartyId: agreement.counterpartyId,
    owners: ownersQuery.ownersWithSlugs,
  });
  if (!offer) return null;

  const editorHrefFor = (id: string) =>
    venueEventEditorUrl({
      eventId: id,
      counterpartyType: agreement.counterpartyType,
      counterpartyId: agreement.counterpartyId,
      owners: ownersQuery.ownersWithSlugs,
    });

  const handleCreate = () => {
    if (createMutation.isPending) return;
    setError(null);
    createMutation.mutate(
      { agreementId },
      {
        onSuccess: (result) => {
          const created = { result, eventHref: editorHrefFor(result.eventId) };
          setLocalOutcome(created);
          onEventCreated?.(created);
          // Three reads change here: the row's stage projection (`eventId`)
          // on the list, the agreement's finalize link on the get, and the
          // THREAD — the server writes `booking_event.created` (and
          // `booking_agreement.finalized`) ledger entries in the same
          // transaction, and without this the conversation directly above
          // the notice still ended at "Agreement accepted" until a reload.
          void utils.bookingRequests.list.invalidate();
          void utils.bookingAgreements.get.invalidate({ agreementId });
          void utils.bookingRequests.messages.list.invalidate({
            bookingRequestId,
          });
        },
        onError: (err) => {
          setError(
            createEventFromBookingErrorMessage(err) ??
              formatErrorMessage(err, t),
          );
        },
      },
    );
  };

  return (
    <YStack
      gap="$2"
      padding="$3"
      borderWidth={2}
      borderColor="$borderColor"
      backgroundColor="$surface"
      minWidth={0}
      data-testid={testId}
    >
      <Text
        variant="caption"
        weight="bold"
        tone="muted"
        textTransform="uppercase"
        letterSpacing={0.6}
      >
        {String(t("admin.bkInboxCreateEventKicker"))}
      </Text>
      <Text variant="bodySmall" tone="muted">
        {explainer}
      </Text>
      {error ? (
        <Text variant="bodySmall" tone="error" role="alert">
          {error}
        </Text>
      ) : null}
      <XStack>
        {/* Secondary, not primary: the thread's Send button is the one primary
            in this panel, and two competing fills would break the one-primary
            rule. The kicker + bordered box carry the emphasis. */}
        <Button
          variant="secondary"
          size="$2"
          disabled={createMutation.isPending}
          onPress={handleCreate}
          testID={`${testId}-cta`}
        >
          {createMutation.isPending ? (
            <Spinner size="sm" />
          ) : (
            <>
              <CalendarPlus size={14} strokeWidth={2} aria-hidden />
              {String(t("admin.bkInboxCreateEventCta"))}
            </>
          )}
        </Button>
      </XStack>
    </YStack>
  );
}
