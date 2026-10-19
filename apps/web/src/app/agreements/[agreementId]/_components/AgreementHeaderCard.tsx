"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { XStack, YStack } from "tamagui";
import { ExternalLink, MapPin, Save, Users } from "lucide-react";
import {
  Button,
  CharCountTextarea,
  Spinner,
  Text,
  TextInput,
  useFormatters,
  useNotify,
  useTranslations,
} from "@th/ui";

import { trpc } from "@/trpc";
import { isGuaranteeSetByDealError } from "@/components/deals/deal-errors";
import { fmtCurrency } from "@/lib/format";
import {
  DateTimeLocalInput,
  isDateTimeFieldIncomplete,
  useIncompleteField,
} from "@/components/forms/DateTimeLocalInput";
import { isoToLocalInput, localInputToIso } from "@/lib/datetime-local";
import { isoDateToLocal } from "@/lib/booking-requests";
import { centsToDollarsInput, dollarsToCents } from "@/lib/booking-agreements";
import type { AgreementGetOutput } from "./AgreementEditor";
import { PitchProvenanceMarker } from "./PitchProvenanceMarker";

type Agreement = AgreementGetOutput["agreement"];
type BookingRequest = AgreementGetOutput["bookingRequest"];
type PitchProvenance = AgreementGetOutput["pitchProvenance"];

const DESCRIPTION_MAX = 5000;

function safeExternalHref(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function FieldLabel({
  children,
  htmlFor,
  fromPitch = false,
  pitchDescriptionId,
  pitchTestId,
}: {
  children: string;
  htmlFor?: string;
  /** Render the "from booking request" provenance marker beside the label. */
  fromPitch?: boolean;
  /** Id the field's `aria-describedby` points at (editable fields only). */
  pitchDescriptionId?: string;
  pitchTestId?: string;
}) {
  const label = (
    <Text
      tag={htmlFor ? "label" : undefined}
      htmlFor={htmlFor}
      variant="caption"
      weight="bold"
      tone="muted"
      textTransform="uppercase"
      letterSpacing={0.6}
    >
      {children}
    </Text>
  );
  if (!fromPitch) return label;
  return (
    // flexWrap so the marker drops under the label rather than squeezing it at
    // 320px (Tamagui defaults flexShrink:0, so neither child gives way).
    <XStack gap="$2" alignItems="center" flexWrap="wrap">
      {label}
      <PitchProvenanceMarker id={pitchDescriptionId} testID={pitchTestId} />
    </XStack>
  );
}

/**
 * Agreement header: parties, venue, originating request, and the DRAFT-only
 * editable deal fields (title, dates, guarantee, notes). All money is
 * integer cents on the wire; the inputs work in dollars text.
 */
export function AgreementHeaderCard({
  agreementId,
  agreement,
  bookingRequest,
  pitchProvenance,
  guaranteeFromDeal,
  dealAnchorId,
  mayEdit,
  placeName,
  onRefresh,
  onActionError,
}: {
  agreementId: string;
  agreement: Agreement;
  bookingRequest: BookingRequest;
  /**
   * Server-DERIVED "this header field still holds exactly what the act
   * pitched", recomputed on every read (see `_shared/pitch-seed.ts`). Null when
   * there is no originating request to attribute anything to.
   */
  pitchProvenance: PitchProvenance;
  /**
   * `agreement.guaranteeCents` is The deal's (the fixed part of the act's
   * clauses): shown read-only and never sent with a header save.
   */
  guaranteeFromDeal: boolean;
  /** The deal section's element id, for "Go to The deal". */
  dealAnchorId: string;
  mayEdit: boolean;
  placeName: string | null;
  onRefresh: () => void;
  onActionError: (err: unknown) => void;
}) {
  const t = useTranslations();
  const fmt = useFormatters();
  const { toast } = useNotify();

  const titleId = useId();
  const dateId = useId();
  const endDateId = useId();
  const guaranteeId = useId();
  const descriptionId = useId();

  // ── Local edit buffer (seeded from the server snapshot) ──────────────────
  const [title, setTitle] = useState(agreement.title);
  const [description, setDescription] = useState(agreement.description ?? "");
  const [dateLocal, setDateLocal] = useState(
    agreement.proposedDate
      ? isoToLocalInput(agreement.proposedDate.toISOString())
      : "",
  );
  const [endDateLocal, setEndDateLocal] = useState(
    agreement.proposedEndDate
      ? isoToLocalInput(agreement.proposedEndDate.toISOString())
      : "",
  );
  // A half-typed date reads as "" (Chrome fires no input event until every
  // segment is filled), which would save as "no date".
  const dateField = useIncompleteField();
  const endDateField = useIncompleteField();
  const dateIncomplete = dateField.incomplete;
  const endDateIncomplete = endDateField.incomplete;
  const dateRef = useRef<HTMLInputElement>(null);
  const endDateRef = useRef<HTMLInputElement>(null);
  const [guaranteeText, setGuaranteeText] = useState(
    centsToDollarsInput(agreement.guaranteeCents),
  );

  const updateMutation = trpc.bookingAgreements.updateHeader.useMutation({
    retry: false,
    meta: { silent: true },
  });

  // ── Validation + dirty diff ───────────────────────────────────────────────
  const trimmedTitle = title.trim();
  const guaranteeTrimmed = guaranteeText.trim();
  const guaranteeCents =
    guaranteeTrimmed === "" ? null : dollarsToCents(guaranteeTrimmed);
  const guaranteeInvalid =
    !guaranteeFromDeal && guaranteeTrimmed !== "" && guaranteeCents === null;
  const titleInvalid = trimmedTitle.length < 3;

  const dateIso = localInputToIso(dateLocal) ?? null;
  const endDateIso = localInputToIso(endDateLocal) ?? null;
  const datesInvalid =
    dateIso !== null &&
    endDateIso !== null &&
    new Date(endDateIso).getTime() < new Date(dateIso).getTime();

  const changes = useMemo(() => {
    const next: {
      title?: string;
      description?: string | null;
      proposedDate?: Date | null;
      proposedEndDate?: Date | null;
      guaranteeCents?: number | null;
    } = {};
    if (trimmedTitle !== agreement.title) next.title = trimmedTitle;
    const descValue = description.trim() === "" ? null : description.trim();
    if (descValue !== (agreement.description ?? null)) {
      next.description = descValue;
    }
    const currentDateIso = agreement.proposedDate?.toISOString() ?? null;
    if (dateIso !== currentDateIso) {
      next.proposedDate = dateIso ? new Date(dateIso) : null;
    }
    const currentEndIso = agreement.proposedEndDate?.toISOString() ?? null;
    if (endDateIso !== currentEndIso) {
      next.proposedEndDate = endDateIso ? new Date(endDateIso) : null;
    }
    if (
      !guaranteeFromDeal &&
      !guaranteeInvalid &&
      guaranteeCents !== agreement.guaranteeCents
    ) {
      next.guaranteeCents = guaranteeCents;
    }
    return next;
  }, [
    agreement,
    dateIso,
    description,
    endDateIso,
    guaranteeCents,
    guaranteeFromDeal,
    guaranteeInvalid,
    trimmedTitle,
  ]);

  const isDirty = Object.keys(changes).length > 0;

  // ── Pitch provenance, reconciled against the local buffer ────────────────
  // `pitchProvenance` is a fact about the STORED value. Between a keystroke and
  // a save the buffer no longer matches it, so a marker left on that field
  // would attribute the venue's own number to the act — the exact confusion
  // this feature exists to remove. `changes` already knows which fields differ
  // from the snapshot; a half-typed (unparseable) guarantee never reaches
  // `changes`, so it is excluded explicitly.
  const fromPitch = {
    proposedDate:
      pitchProvenance?.proposedDate === true &&
      changes.proposedDate === undefined,
    proposedEndDate:
      pitchProvenance?.proposedEndDate === true &&
      changes.proposedEndDate === undefined,
    guaranteeCents:
      pitchProvenance?.guaranteeCents === true &&
      changes.guaranteeCents === undefined &&
      !guaranteeInvalid,
    description:
      pitchProvenance?.description === true &&
      changes.description === undefined,
  };

  // Provenance rides in FRONT of the validation/hint description so a screen
  // reader hears whose number it is before it hears what the field wants.
  const datePitchId = `${dateId}-pitch`;
  const endDatePitchId = `${endDateId}-pitch`;
  const guaranteePitchId = `${guaranteeId}-pitch`;
  const descriptionPitchId = `${descriptionId}-pitch`;

  const describedBy = (...ids: (string | false | null | undefined)[]) => {
    const list = ids.filter((id): id is string => Boolean(id));
    return list.length > 0 ? list.join(" ") : undefined;
  };

  // Reseed the edit buffer from the server snapshot — but never while the
  // form holds in-progress edits (sibling invalidations, e.g. a line save,
  // refetch the same agreement and would otherwise wipe them). A successful
  // header save still reseeds: the refetched snapshot makes `changes` empty,
  // flipping `isDirty` false. `guaranteeInvalid` is excluded from `changes`,
  // so it guards separately to keep half-typed guarantee text intact.
  useEffect(() => {
    if (isDirty || guaranteeInvalid) return;
    setTitle(agreement.title);
    setDescription(agreement.description ?? "");
    setDateLocal(
      agreement.proposedDate
        ? isoToLocalInput(agreement.proposedDate.toISOString())
        : "",
    );
    setEndDateLocal(
      agreement.proposedEndDate
        ? isoToLocalInput(agreement.proposedEndDate.toISOString())
        : "",
    );
    setGuaranteeText(centsToDollarsInput(agreement.guaranteeCents));
  }, [agreement, guaranteeInvalid, isDirty]);

  const canSave =
    mayEdit &&
    isDirty &&
    !titleInvalid &&
    !guaranteeInvalid &&
    !datesInvalid &&
    !dateIncomplete &&
    !endDateIncomplete &&
    !updateMutation.isPending;

  const handleSave = () => {
    if (!canSave) return;
    // Re-read the fields: a half-typed date must never save as "no date".
    const dateNow = dateRef.current
      ? isDateTimeFieldIncomplete(dateRef.current)
      : false;
    const endDateNow = endDateRef.current
      ? isDateTimeFieldIncomplete(endDateRef.current)
      : false;
    if (dateNow || endDateNow) {
      dateField.refuse(dateNow);
      endDateField.refuse(endDateNow);
      return;
    }
    updateMutation.mutate(
      { agreementId, ...changes },
      {
        onSuccess: () => {
          toast.success({
            id: "ba-header-saved",
            title: String(t("admin.baHeaderSavedToast")),
          });
          onRefresh();
        },
        onError: (err) => {
          // Read before the deal existed: The deal sets the guarantee now.
          if (isGuaranteeSetByDealError(err)) {
            toast.warning({
              id: "ba-guarantee-set-by-deal",
              title: String(t("admin.baGuaranteeSetByDeal")),
            });
            onRefresh();
            return;
          }
          onActionError(err);
        },
      },
    );
  };

  // The deal's guarantee: the number, whose it is, and the way to change it.
  const dealGuarantee = (
    <>
      <Text variant="bodySmall" weight="bold" testId="ba-header-guarantee-deal">
        {agreement.guaranteeCents !== null
          ? fmtCurrency(fmt, agreement.guaranteeCents, "USD")
          : "—"}
      </Text>
      <Text variant="caption" tone="muted">
        {/* "Change it there" is only true for someone who can; anyone else
            still gets the link, to read the deal. */}
        {String(
          t(
            mayEdit
              ? "admin.baGuaranteeFromDealHint"
              : "admin.baGuaranteeFromDealHintReadOnly",
          ),
        )}{" "}
        <a
          href={`#${dealAnchorId}`}
          style={{ color: "inherit", textDecoration: "underline" }}
          data-testid="ba-header-guarantee-deal-link"
        >
          {String(t("admin.baGuaranteeFromDealLink"))}
        </a>
      </Text>
    </>
  );
  const dealGuaranteeLabel = (
    <XStack gap="$2" alignItems="center" flexWrap="wrap">
      <FieldLabel>{String(t("admin.baGuaranteeLabel"))}</FieldLabel>
      <Text variant="caption" tone="muted">
        {String(t("admin.baGuaranteeFromDeal"))}
      </Text>
    </XStack>
  );

  // ── Shared display rows ───────────────────────────────────────────────────
  const partiesRow = (
    <YStack gap="$1" flex={1} minWidth={220}>
      <FieldLabel>{String(t("admin.baPartiesLabel"))}</FieldLabel>
      <XStack gap="$2" alignItems="center" flexWrap="wrap">
        <Users size={13} style={{ opacity: 0.5 }} />
        <Text variant="bodySmall" weight="bold">
          {agreement.proposerDisplayName ?? "—"}
        </Text>
        <Text variant="bodySmall" tone="muted">
          ↔
        </Text>
        <Text variant="bodySmall" weight="bold">
          {agreement.counterpartyDisplayName ?? "—"}
        </Text>
      </XStack>
    </YStack>
  );

  const placeRow = placeName ? (
    <YStack gap="$1" flex={1} minWidth={180}>
      <FieldLabel>{String(t("admin.baPlaceLabel"))}</FieldLabel>
      <XStack gap="$2" alignItems="center">
        <MapPin size={13} style={{ opacity: 0.5 }} />
        <Text variant="bodySmall">{placeName}</Text>
      </XStack>
    </YStack>
  ) : null;

  return (
    <YStack borderWidth={2} borderColor="$borderColor">
      <YStack gap="$4" padding="$4">
        <XStack gap="$4" flexWrap="wrap">
          {partiesRow}
          {placeRow}
        </XStack>

        {mayEdit ? (
          <>
            <YStack gap="$1">
              <FieldLabel htmlFor={titleId}>
                {String(t("admin.baHeaderTitleLabel"))}
              </FieldLabel>
              <TextInput
                id={titleId}
                value={title}
                onChangeText={setTitle}
                maxLength={200}
                fullWidth
                aria-invalid={titleInvalid ? true : undefined}
                aria-describedby={titleInvalid ? `${titleId}-error` : undefined}
                testId="ba-header-title"
              />
              {titleInvalid ? (
                <Text id={`${titleId}-error`} variant="caption" tone="error">
                  {String(t("admin.baErrTitleTooShort"))}
                </Text>
              ) : null}
            </YStack>

            {/* 210 is where the dates sit side by side; under it each takes
                its own row, never wider than the card (a 210 floor ran 24px
                past it at 320). */}
            <XStack gap="$3" flexWrap="wrap">
              <YStack
                gap="$1"
                flexGrow={1}
                flexShrink={1}
                flexBasis={210}
                minWidth={0}
              >
                <FieldLabel
                  htmlFor={dateId}
                  fromPitch={fromPitch.proposedDate}
                  pitchDescriptionId={datePitchId}
                  pitchTestId="ba-pitch-date"
                >
                  {String(t("admin.baProposedDateLabel"))}
                </FieldLabel>
                <DateTimeLocalInput
                  ref={dateRef}
                  id={dateId}
                  type="datetime-local"
                  variant="boxed"
                  value={dateLocal}
                  onChange={(e) => setDateLocal(e.target.value)}
                  onIncompleteChange={dateField.onIncompleteChange}
                  aria-invalid={dateField.shown ? true : undefined}
                  aria-describedby={describedBy(
                    fromPitch.proposedDate && datePitchId,
                    dateField.shown && `${dateId}-incomplete`,
                  )}
                  data-testid="ba-header-date"
                />
                {dateField.shown ? (
                  <Text
                    id={`${dateId}-incomplete`}
                    variant="caption"
                    tone="error"
                    role="alert"
                  >
                    {String(t("common.dateTimeStartIncomplete"))}
                  </Text>
                ) : null}
              </YStack>
              <YStack
                gap="$1"
                flexGrow={1}
                flexShrink={1}
                flexBasis={210}
                minWidth={0}
              >
                <FieldLabel
                  htmlFor={endDateId}
                  fromPitch={fromPitch.proposedEndDate}
                  pitchDescriptionId={endDatePitchId}
                  pitchTestId="ba-pitch-end-date"
                >
                  {String(t("admin.baProposedEndDateLabel"))}
                </FieldLabel>
                <DateTimeLocalInput
                  ref={endDateRef}
                  id={endDateId}
                  type="datetime-local"
                  variant="boxed"
                  value={endDateLocal}
                  onChange={(e) => setEndDateLocal(e.target.value)}
                  onIncompleteChange={endDateField.onIncompleteChange}
                  {...(dateLocal ? { min: dateLocal } : {})}
                  aria-invalid={
                    datesInvalid || endDateField.shown ? true : undefined
                  }
                  aria-describedby={describedBy(
                    fromPitch.proposedEndDate && endDatePitchId,
                    datesInvalid && `${endDateId}-error`,
                    endDateField.shown && `${endDateId}-incomplete`,
                  )}
                  data-testid="ba-header-end-date"
                />
                {endDateField.shown ? (
                  <Text
                    id={`${endDateId}-incomplete`}
                    variant="caption"
                    tone="error"
                    role="alert"
                  >
                    {String(t("common.dateTimeEndIncomplete"))}
                  </Text>
                ) : null}
                {datesInvalid ? (
                  <Text
                    id={`${endDateId}-error`}
                    variant="caption"
                    tone="error"
                  >
                    {String(t("admin.baErrEndBeforeStart"))}
                  </Text>
                ) : null}
              </YStack>
              {/* Capped: money is a short field. Without a max it takes the
                  whole row whenever the three columns wrap, and a $650 sitting
                  in an 800px box reads like a paragraph input. */}
              <YStack
                gap="$1"
                flexGrow={1}
                flexShrink={1}
                flexBasis={180}
                minWidth={0}
                maxWidth={280}
              >
                {guaranteeFromDeal ? (
                  <>
                    {dealGuaranteeLabel}
                    {dealGuarantee}
                  </>
                ) : (
                  <>
                    <FieldLabel
                      htmlFor={guaranteeId}
                      fromPitch={fromPitch.guaranteeCents}
                      pitchDescriptionId={guaranteePitchId}
                      pitchTestId="ba-pitch-guarantee"
                    >
                      {String(t("admin.baGuaranteeLabel"))}
                    </FieldLabel>
                    {/* The input shares the row with "$": it takes what is left,
                    never the column's full width (that ran 20px past the card). */}
                    <XStack gap="$2" alignItems="center">
                      <Text
                        variant="body"
                        tone="muted"
                        style={{ minWidth: 12 }}
                      >
                        $
                      </Text>
                      <YStack flex={1} minWidth={0}>
                        <TextInput
                          id={guaranteeId}
                          value={guaranteeText}
                          onChangeText={setGuaranteeText}
                          placeholder="0.00"
                          inputMode="decimal"
                          fullWidth
                          aria-invalid={guaranteeInvalid ? true : undefined}
                          aria-describedby={describedBy(
                            fromPitch.guaranteeCents && guaranteePitchId,
                            guaranteeInvalid
                              ? `${guaranteeId}-error`
                              : `${guaranteeId}-hint`,
                          )}
                          testId="ba-header-guarantee"
                        />
                      </YStack>
                    </XStack>
                    {guaranteeInvalid ? (
                      <Text
                        id={`${guaranteeId}-error`}
                        variant="caption"
                        tone="error"
                      >
                        {String(t("admin.baErrGuaranteeInvalid"))}
                      </Text>
                    ) : fromPitch.guaranteeCents ? (
                      // The one field where the marker alone is not enough: this
                      // is the money term of the deal. It is a RECORDED term only
                      // — the platform never settles it (2026-08: deals are
                      // recorded, not executed; there is no guarantee→payout
                      // mapping, and per-order floors are no longer honoured).
                      // It gets the hint slot it already owns, in full ink rather
                      // than muted, so the venue reads WHOSE number it is before
                      // sending the agreement for review. Deliberately not accent-coloured —
                      // on Stub `$accentText` (#B93312) is a near-twin of `$danger`
                      // (#B91C1C) and would read as a validation failure.
                      <Text
                        id={`${guaranteeId}-hint`}
                        variant="caption"
                        testId="ba-pitch-guarantee-hint"
                      >
                        {String(t("admin.baPitchGuaranteeHint"))}
                      </Text>
                    ) : (
                      <Text
                        id={`${guaranteeId}-hint`}
                        variant="caption"
                        tone="muted"
                      >
                        {String(t("admin.baGuaranteeHint"))}
                      </Text>
                    )}
                  </>
                )}
              </YStack>
            </XStack>

            <YStack gap="$1">
              {/* `htmlFor`/`id` were previously absent here — the textarea has
                  to be labelled for the provenance description to attach to
                  anything a screen reader reads out. */}
              <FieldLabel
                htmlFor={descriptionId}
                fromPitch={fromPitch.description}
                pitchDescriptionId={descriptionPitchId}
                pitchTestId="ba-pitch-description"
              >
                {String(t("admin.baDescriptionLabel"))}
              </FieldLabel>
              <CharCountTextarea
                id={descriptionId}
                value={description}
                onChange={setDescription}
                maxLength={DESCRIPTION_MAX}
                minHeight={88}
                placeholder={String(t("admin.baDescriptionPlaceholder"))}
                ariaDescribedBy={describedBy(
                  fromPitch.description && descriptionPitchId,
                )}
                testIdBase="ba-header-description"
              />
            </YStack>

            <XStack justifyContent="flex-end">
              <Button
                variant="primary"
                size="$2"
                disabled={!canSave}
                onPress={handleSave}
                testID="ba-header-save"
              >
                {updateMutation.isPending ? (
                  <Spinner size="sm" />
                ) : (
                  <>
                    <Save size={14} />
                    {String(t("admin.baSaveHeader"))}
                  </>
                )}
              </Button>
            </XStack>
          </>
        ) : (
          // Read-only renderings carry the SAME markers — the other party
          // reading a proposed agreement gets to see which values are still
          // the act's own ask. No `aria-describedby` here: there is no form
          // control to describe, and the marker is already next in DOM order
          // after the label, so a screen reader reads it either way.
          <XStack gap="$4" flexWrap="wrap">
            <YStack gap="$1" minWidth={180}>
              <FieldLabel
                fromPitch={fromPitch.proposedDate}
                pitchTestId="ba-pitch-date"
              >
                {String(t("admin.baProposedDateLabel"))}
              </FieldLabel>
              <Text variant="bodySmall">
                {agreement.proposedDate
                  ? fmt.dateTime(new Date(agreement.proposedDate), {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })
                  : "—"}
              </Text>
            </YStack>
            <YStack gap="$1" minWidth={180}>
              <FieldLabel
                fromPitch={fromPitch.proposedEndDate}
                pitchTestId="ba-pitch-end-date"
              >
                {String(t("admin.baProposedEndDateLabel"))}
              </FieldLabel>
              <Text variant="bodySmall">
                {agreement.proposedEndDate
                  ? fmt.dateTime(new Date(agreement.proposedEndDate), {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })
                  : "—"}
              </Text>
            </YStack>
            <YStack gap="$1" minWidth={140}>
              {guaranteeFromDeal ? (
                <>
                  {dealGuaranteeLabel}
                  {dealGuarantee}
                </>
              ) : (
                <>
                  <FieldLabel
                    fromPitch={fromPitch.guaranteeCents}
                    pitchTestId="ba-pitch-guarantee"
                  >
                    {String(t("admin.baGuaranteeLabel"))}
                  </FieldLabel>
                  <Text variant="bodySmall" weight="bold">
                    {agreement.guaranteeCents !== null
                      ? fmtCurrency(fmt, agreement.guaranteeCents, "USD")
                      : "—"}
                  </Text>
                </>
              )}
            </YStack>
            {agreement.description ? (
              <YStack gap="$1" width="100%">
                <FieldLabel
                  fromPitch={fromPitch.description}
                  pitchTestId="ba-pitch-description"
                >
                  {String(t("admin.baDescriptionLabel"))}
                </FieldLabel>
                <Text variant="bodySmall" style={{ whiteSpace: "pre-wrap" }}>
                  {agreement.description}
                </Text>
              </YStack>
            ) : null}
          </XStack>
        )}
      </YStack>

      {/* ── Originating booking request ──────────────────────────────────── */}
      {bookingRequest ? (
        <YStack
          gap="$2"
          padding="$4"
          borderTopWidth={1}
          borderTopColor="$borderColor"
          backgroundColor="$surfaceMuted"
        >
          <FieldLabel>{String(t("admin.baFromRequestLabel"))}</FieldLabel>
          <Text variant="bodySmall" style={{ whiteSpace: "pre-wrap" }}>
            {bookingRequest.message}
          </Text>
          <XStack gap="$4" flexWrap="wrap">
            {bookingRequest.preferredDates.length > 0 ? (
              <Text variant="caption" tone="muted">
                {String(t("admin.bkInboxColDates"))}:{" "}
                {bookingRequest.preferredDates
                  .map((d) =>
                    fmt.dateTime(isoDateToLocal(d), { dateStyle: "medium" }),
                  )
                  .join(" · ")}
              </Text>
            ) : null}
            {bookingRequest.genre ? (
              <Text variant="caption" tone="muted">
                {String(t("admin.bkInboxColGenre"))}: {bookingRequest.genre}
              </Text>
            ) : null}
            {bookingRequest.expectedDraw ? (
              <Text variant="caption" tone="muted">
                {String(t("admin.bkInboxColDraw"))}:{" "}
                {bookingRequest.expectedDraw.toLocaleString()}
              </Text>
            ) : null}
          </XStack>
          {bookingRequest.links.length > 0 ? (
            <XStack gap="$3" flexWrap="wrap">
              {bookingRequest.links.map((link, i) => {
                const href = safeExternalHref(link);
                if (!href) return null;
                return (
                  <a
                    key={i}
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ textDecoration: "none" }}
                  >
                    <XStack gap="$2" alignItems="center">
                      <ExternalLink size={12} style={{ opacity: 0.6 }} />
                      <Text variant="caption" color="$accent">
                        {href}
                      </Text>
                    </XStack>
                  </a>
                );
              })}
            </XStack>
          ) : null}
        </YStack>
      ) : null}
    </YStack>
  );
}
