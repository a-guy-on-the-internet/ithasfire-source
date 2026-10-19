"use client";

import { useId, useMemo, useState } from "react";
import { useRouter } from "@bprogress/next/app";
import { XStack, YStack } from "tamagui";
import { CalendarPlus } from "lucide-react";
import {
  Button,
  Modal,
  Spinner,
  StyledSelect,
  Text,
  useFormatters,
  useNotify,
  useTranslations,
} from "@th/ui";

import { trpc } from "@/trpc";
import { joinNames, namesToTell } from "@/components/deals/deal-names";
import { useViewerHuman } from "@/components/deals/use-viewer-human";
import { adminBookingHref } from "@/lib/agreement-routes";
import { getAppErrorCode } from "@/lib/app-error";
import { formatErrorMessage } from "@/lib/format-error-message";
import { finalizeErrorKey } from "@/lib/booking-agreements";
import { useEventOwnerEntities } from "@/hooks/useEventOwnerEntities";
import type { AgreementGetOutput } from "./AgreementEditor";
import { CreateEventOutcomeNotice } from "./CreateEventOutcomeNotice";
import {
  createEventExplainerCopy,
  createEventFromBookingErrorMessage,
  explainerShowDate,
  mayCreateEventFromBooking,
  venueAdminSlug,
  venueEventEditorUrl,
  type CreateEventFromBookingOutcome,
} from "./create-event-from-booking";

type AgreementLine = AgreementGetOutput["lines"][number];
type Agreement = AgreementGetOutput["agreement"];
type BookingRequest = AgreementGetOutput["bookingRequest"];

/**
 * Org roles whose events appear in the picker — mirrors the server's
 * `ORG_EDIT_OR_FINANCE_ROLES` gate on the event side of finalize. (The
 * agreement-party action gate stays OWNER/ADMIN/EDITOR; see `mayAct`.)
 */
const EVENT_EDIT_ROLES = new Set(["OWNER", "ADMIN", "EDITOR", "FINANCE"]);

/**
 * Finalize flow (ACCEPTED only): pick one of the actor's editable events and
 * stamp the agreement's payout terms onto it. The picker merges
 * `events.listMine` across every owner entity from
 * `events.listEventOwnerEntities` (self + edit-role orgs) — that procedure
 * pair is authed but NOT admin-shell-bound, so it works for performers too.
 *
 * Booking-minted agreements additionally offer "Create event from this
 * booking" (booking-conversation-and-event-step FR-007): mints a DRAFT event
 * prefilled from the request and finalize-links it when the agreement is
 * finalizable. Copy for the new path is literal English pending catalog keys
 * (see create-event-from-booking.ts).
 */
export function FinalizeDialog({
  open,
  onClose,
  agreementId,
  agreement,
  bookingRequest,
  placeName,
  lines,
  onRefresh,
}: {
  open: boolean;
  onClose: () => void;
  agreementId: string;
  agreement: Agreement;
  bookingRequest: BookingRequest;
  placeName: string | null;
  lines: AgreementLine[];
  onRefresh: () => void;
}) {
  const t = useTranslations();
  const fmt = useFormatters();
  const { toast } = useNotify();
  const router = useRouter();
  const utils = trpc.useUtils();
  const eventSelectId = useId();

  const [selectedEventId, setSelectedEventId] = useState("");
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createOutcome, setCreateOutcome] =
    useState<CreateEventFromBookingOutcome | null>(null);
  // The picked event's deal is frozen (freeze-the-deal O1): finalizing onto
  // it is a frozen change. Set when the server refuses with DEAL_FROZEN; the
  // dialog then says who is told, and the confirm re-sends with
  // `frozenChange: true`.
  const [frozenEventId, setFrozenEventId] = useState<string | null>(null);
  const frozenConfirm = !!selectedEventId && frozenEventId === selectedEventId;
  // Less whoever finalizes: the notice skips them.
  const viewer = useViewerHuman();
  const tellNames = useMemo(
    () =>
      namesToTell(
        lines.map((line) => ({
          kind:
            line.subjectType === null
              ? null
              : line.subjectType === "human"
                ? "human"
                : "org",
          id: line.subjectId,
          name: line.displayName,
        })),
        viewer,
      ),
    [lines, viewer],
  );

  const ownersQuery = useEventOwnerEntities({ enabled: open });

  const owners = useMemo(
    () =>
      (ownersQuery.ownersWithSlugs ?? []).flatMap(
        (owner): Array<{ ownerType: "HUMAN" | "ORGANIZATION"; ownerId: string }> => {
          if (owner.kind === "human") {
            return [{ ownerType: "HUMAN", ownerId: owner.humanId }];
          }
          return EVENT_EDIT_ROLES.has(owner.role)
            ? [{ ownerType: "ORGANIZATION", ownerId: owner.orgId }]
            : [];
        },
      ),
    [ownersQuery.ownersWithSlugs],
  );

  const eventQueries = trpc.useQueries((q) =>
    owners.map((owner) =>
      q.events.listMine(
        {
          ownerType: owner.ownerType,
          ownerId: owner.ownerId,
          status: ["DRAFT", "PUBLISHED"],
          limit: 50,
        },
        { enabled: open, staleTime: 30_000, retry: false, meta: { silent: true } },
      ),
    ),
  );

  const eventsLoading =
    open &&
    (ownersQuery.isLoading || eventQueries.some((query) => query.isLoading));

  // A failed per-owner listMine must not masquerade as "no events" — surface
  // it as a retryable inline error (partial results still render below).
  const eventsError =
    ownersQuery.isError || eventQueries.some((query) => query.isError);

  const handleRetryEvents = () => {
    if (ownersQuery.isError) void ownersQuery.refetch();
    for (const query of eventQueries) {
      if (query.isError) void query.refetch();
    }
  };

  const eventOptions = useMemo(() => {
    const seen = new Set<string>();
    const options: { value: string; label: string }[] = [];
    for (const query of eventQueries) {
      for (const item of query.data?.items ?? []) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        const title =
          item.title ?? String(t("admin.baFinalizeUntitledEvent"));
        const when = item.startsAt
          ? ` — ${fmt.dateTime(new Date(item.startsAt), { dateStyle: "medium" })}`
          : "";
        options.push({ value: item.id, label: `${title}${when}` });
      }
    }
    return options;
  }, [eventQueries, fmt, t]);

  const finalizeMutation = trpc.bookingAgreements.finalize.useMutation({
    retry: false,
    meta: { silent: true },
  });
  const createEventMutation =
    trpc.bookingAgreements.createEventFromAgreement.useMutation({
      retry: false,
      meta: { silent: true },
    });

  /** Both paths share one pending lock — no double-fire across them. */
  const actionPending =
    finalizeMutation.isPending || createEventMutation.isPending;

  // ── Create-event-from-booking (venue side of booking-minted agreements) ────
  const offerCreateEvent = mayCreateEventFromBooking({
    bookingMinted: bookingRequest !== null,
    counterpartyType: agreement.counterpartyType,
    counterpartyId: agreement.counterpartyId,
    owners: ownersQuery.ownersWithSlugs,
  });

  const createExplainer = useMemo(() => {
    // Mirrors the server's startsAt preference: the negotiated proposedDate
    // when set, else the request's first preferred date.
    const showDate = explainerShowDate({
      proposedDate: agreement.proposedDate,
      preferredDates: bookingRequest?.preferredDates,
    });
    return createEventExplainerCopy({
      venueName: placeName ?? agreement.counterpartyDisplayName,
      dateLabel: showDate
        ? fmt.dateTime(showDate, { dateStyle: "medium" })
        : null,
      actName: agreement.proposerDisplayName,
    });
  }, [
    agreement.counterpartyDisplayName,
    agreement.proposedDate,
    agreement.proposerDisplayName,
    bookingRequest,
    fmt,
    placeName,
  ]);

  const editorHrefFor = (eventId: string) =>
    venueEventEditorUrl({
      eventId,
      counterpartyType: agreement.counterpartyType,
      counterpartyId: agreement.counterpartyId,
      owners: ownersQuery.ownersWithSlugs,
    });

  /**
   * The draft went to the REQUESTER's admin (RENT / USE). The venue has no
   * event to open and nothing to finalize: `finalizeBookingAgreement` would
   * link the agreement onto a DIFFERENT, venue-owned event and clear the
   * requester's draft anchor — orphaning the draft the notice just described.
   * So the picker and the Finalize button leave with the create button, and
   * the notice points at the conversation instead.
   */
  const requesterOwnedOutcome =
    createOutcome?.finalizeBlocked === "requester_owned";
  const threadHref = bookingRequest
    ? adminBookingHref(
        venueAdminSlug({
          counterpartyType: agreement.counterpartyType,
          counterpartyId: agreement.counterpartyId,
          owners: ownersQuery.ownersWithSlugs,
        }),
        bookingRequest.id,
      )
    : null;

  const handleCreateEvent = () => {
    if (actionPending) return;
    setCreateError(null);
    setInlineError(null);
    createEventMutation.mutate(
      { agreementId },
      {
        onSuccess: (result) => {
          onRefresh();
          // The fresh draft should appear in the picker if the venue stays here.
          void utils.events.listMine.invalidate();
          if (result.finalized && !result.alreadyLinked) {
            // Fresh mint, fully finalized — straight into the editor.
            toast.success({
              id: "ba-event-created",
              title: "Event created and agreement finalized",
            });
            setCreateOutcome(null);
            setSelectedEventId("");
            onClose();
            router.push(editorHrefFor(result.eventId));
            return;
          }
          if (result.finalized) {
            // Already linked — possibly by a concurrent admin, possibly to
            // an event outside the counterparty's admin shell. No blind
            // redirect; the notice offers an explicit Open-event link.
            toast.success({
              id: "ba-event-created",
              title: "Agreement linked to its event",
            });
          }
          // Already-linked or created-but-blocked (lines_unconfirmed /
          // payee_not_ready / requester_owned): stay here — the notice
          // explains, and for the venue-owned gates the finalize flow below
          // remains available.
          setCreateOutcome(result);
        },
        onError: (err) => {
          setCreateError(
            createEventFromBookingErrorMessage(err) ??
              formatErrorMessage(err, t),
          );
        },
      },
    );
  };

  const pendingPayeeNames = useMemo(
    () =>
      lines
        .filter(
          (line) =>
            line.requiresConfirmation &&
            line.confirmationStatus !== "CONFIRMED",
        )
        .map((line) => line.displayName ?? line.payeeId.slice(0, 8))
        .join(", "),
    [lines],
  );

  const handleClose = () => {
    if (actionPending) return;
    setInlineError(null);
    setCreateError(null);
    setCreateOutcome(null);
    setSelectedEventId("");
    setFrozenEventId(null);
    onClose();
  };

  const handleFinalize = () => {
    if (!selectedEventId || actionPending) return;
    setInlineError(null);
    finalizeMutation.mutate(
      {
        agreementId,
        eventId: selectedEventId,
        ...(frozenConfirm ? { frozenChange: true } : {}),
      },
      {
        onSuccess: () => {
          if (frozenConfirm) {
            void utils.deals.listDealChanges.invalidate({
              eventId: selectedEventId,
            });
          }
          setFrozenEventId(null);
          toast.success({
            id: "ba-finalized",
            title: String(t("admin.baFinalizeSuccessToast")),
          });
          setSelectedEventId("");
          setCreateError(null);
          setCreateOutcome(null);
          onClose();
          onRefresh();
        },
        onError: (err) => {
          const e = err as {
            data?: { code?: string } | null;
            message?: string;
          };
          if (getAppErrorCode(err) === "DEAL_FROZEN") {
            setFrozenEventId(selectedEventId);
            return;
          }
          const key = finalizeErrorKey(e.message);
          if (key === "admin.baErrLinesUnconfirmed") {
            setInlineError(
              String(t(key, { names: pendingPayeeNames || "—" })),
            );
            return;
          }
          if (key) {
            setInlineError(String(t(key)));
            return;
          }
          if (e?.data?.code === "CONFLICT") {
            // e.g. agreement_status_changed — refresh to the server's truth.
            toast.warning({
              id: "ba-conflict",
              title: String(t("admin.baConflict")),
            });
            onClose();
            onRefresh();
            return;
          }
          setInlineError(formatErrorMessage(err, t));
        },
      },
    );
  };

  return (
    <Modal open={open} onClose={handleClose}>
      <Modal.Panel width={480}>
        <Modal.Header
          title={String(t("admin.baFinalizeTitle"))}
          onClose={handleClose}
        />
        <Modal.Body>
          <YStack gap="$3">
            <Text variant="bodySmall" tone="muted">
              {String(t("admin.baFinalizeBody"))}
            </Text>

            {offerCreateEvent ? (
              createOutcome ? (
                <CreateEventOutcomeNotice
                  outcome={createOutcome}
                  eventHref={editorHrefFor(createOutcome.eventId)}
                  threadHref={threadHref}
                />
              ) : (
                <YStack
                  gap="$2"
                  padding="$3"
                  borderWidth={2}
                  borderColor="$borderColor"
                >
                  <Text
                    variant="caption"
                    weight="bold"
                    tone="muted"
                    textTransform="uppercase"
                    letterSpacing={0.6}
                  >
                    Create a new event
                  </Text>
                  <Text variant="bodySmall" tone="muted">
                    {createExplainer}
                  </Text>
                  {createError ? (
                    <Text variant="bodySmall" tone="error" role="alert">
                      {createError}
                    </Text>
                  ) : null}
                  <XStack>
                    {/* Primary at rest (the promoted demo path); demoted to
                        outlined once an existing event is picked so the
                        footer's Finalize is the only live primary. */}
                    <Button
                      variant={selectedEventId ? "outlined" : "primary"}
                      size="$2"
                      disabled={actionPending}
                      onPress={handleCreateEvent}
                      testID="ba-create-event"
                    >
                      {createEventMutation.isPending ? (
                        <Spinner size="sm" />
                      ) : (
                        <>
                          <CalendarPlus size={14} />
                          Create event from this booking
                        </>
                      )}
                    </Button>
                  </XStack>
                </YStack>
              )
            ) : null}

            {offerCreateEvent && !requesterOwnedOutcome ? (
              <Text
                variant="caption"
                weight="bold"
                tone="muted"
                textTransform="uppercase"
                letterSpacing={0.6}
              >
                Or link an existing event
              </Text>
            ) : null}

            {requesterOwnedOutcome ? null : (
            <YStack gap="$1">
              <Text
                tag="label"
                htmlFor={eventSelectId}
                variant="caption"
                weight="bold"
                tone="muted"
                textTransform="uppercase"
                letterSpacing={0.6}
              >
                {String(t("admin.baFinalizeEventLabel"))}
              </Text>
              {eventsLoading ? (
                <XStack paddingVertical="$2">
                  <Spinner size="sm" />
                </XStack>
              ) : (
                <>
                  {eventsError ? (
                    <XStack
                      gap="$2"
                      alignItems="center"
                      flexWrap="wrap"
                      paddingVertical="$1"
                    >
                      <Text variant="bodySmall" tone="error" role="alert">
                        {String(t("admin.baFinalizeEventsLoadFailed"))}
                      </Text>
                      <Button
                        variant="outlined"
                        size="$2"
                        onPress={handleRetryEvents}
                        testID="ba-finalize-retry-events"
                      >
                        {String(t("admin.baRetry"))}
                      </Button>
                    </XStack>
                  ) : null}
                  {eventOptions.length === 0 ? (
                    // The empty-state copy would mislead while a query is
                    // failed — the error notice above already covers it.
                    eventsError ? null : (
                      <Text variant="bodySmall" tone="muted">
                        {String(t("admin.baFinalizeNoEvents"))}
                      </Text>
                    )
                  ) : (
                    <StyledSelect
                      id={eventSelectId}
                      options={eventOptions}
                      value={selectedEventId}
                      onChange={(value: string) => {
                        setSelectedEventId(value);
                        setInlineError(null);
                      }}
                      placeholder={String(
                        t("admin.baFinalizeEventPlaceholder"),
                      )}
                      fullWidth
                    />
                  )}
                </>
              )}
            </YStack>
            )}

            {frozenConfirm ? (
              <YStack
                gap="$1"
                padding="$3"
                borderWidth={2}
                borderColor="$borderColor"
                backgroundColor="$surfaceMuted"
                role="status"
                data-testid="ba-finalize-frozen"
              >
                <Text variant="overline">
                  {String(t("deals.freeze.finalizeTitle"))}
                </Text>
                <Text variant="bodySmall">
                  {String(t("deals.freeze.finalizeBody"))}
                </Text>
                {tellNames.length > 0 ? (
                  <Text variant="bodySmall">
                    {String(
                      t("deals.freeze.finalizeNames", {
                        names: joinNames(tellNames, fmt.locale),
                      }),
                    )}
                  </Text>
                ) : null}
              </YStack>
            ) : null}
            {inlineError ? (
              <Text variant="bodySmall" tone="error" role="alert">
                {inlineError}
              </Text>
            ) : null}

            <XStack gap="$2" justifyContent="flex-end">
              <Button
                variant="ghost"
                size="$2"
                disabled={actionPending}
                onPress={handleClose}
              >
                {String(t("common.cancel"))}
              </Button>
              {requesterOwnedOutcome ? null : (
                <Button
                  variant="primary"
                  size="$2"
                  disabled={!selectedEventId || actionPending}
                  onPress={handleFinalize}
                  testID="ba-finalize-confirm"
                >
                  {finalizeMutation.isPending ? (
                    <Spinner size="sm" />
                  ) : frozenConfirm ? (
                    String(t("deals.freeze.finalizeConfirm"))
                  ) : (
                    String(t("admin.baFinalizeConfirm"))
                  )}
                </Button>
              )}
            </XStack>
          </YStack>
        </Modal.Body>
      </Modal.Panel>
    </Modal>
  );
}
