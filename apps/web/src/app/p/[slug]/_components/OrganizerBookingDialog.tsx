"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { Modal, useFormatters, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { useEventOwnerEntities } from "@/hooks/useEventOwnerEntities";

import {
  BOOKING_FEE_CURRENCY,
  BOOKING_FEE_TYPES,
  BOOKING_MAX_DATES,
  BOOKING_SET_LENGTH_PRESETS,
  formatSetLength,
} from "./blocks/request-to-play-form.helpers";
import {
  buildOrganizerBookingPayload,
  mapCreateOrganizerBookingError,
} from "./organizer-booking-form.helpers";
import placeStyles from "./place-entity.module.css";
import formStyles from "./blocks/RequestToPlayBlock.module.css";
import { BookingSubmitButton } from "./blocks/BookingSubmitButton";

/** The act being requested (always the page's owning entity). */
type PerformerTarget = {
  performerOwnerType: "human" | "org";
  performerOwnerId: string;
  performerName: string;
};

type Props = PerformerTarget & {
  open: boolean;
  onClose: () => void;
  /** Visible dialog title — matches the hero trigger's label. */
  title: string;
};

/** Org roles that may send booking requests (mirrors core ORG_EDIT_ROLES). */
const SENDER_ORG_ROLES = ["OWNER", "ADMIN", "EDITOR"] as const;

type SenderOrg = {
  orgId: string;
  orgName: string;
  /** Admin-route slug for the post-send "view your requests" link. */
  adminSlug: string;
};

/**
 * Organizer → performer "Request to book" dialog (organizer-booking-requests
 * FR-009) — the inverse of `BookingRequestDialog`. A portaled Modal hosting
 * the sender-org gate → request form → success flow, opened by the performer
 * heroes' `HeroPerformerBookingButton`.
 *
 * Success state is owned here and reset each time the dialog transitions
 * open, so a reopen always starts on a fresh form. The success screen links
 * to the sender org's bookings hub (`/admin/{slug}/bookings` — the same deep
 * link the response notifications use).
 *
 * The dialog portals to `document.body`, outside the entity-page theme scope,
 * so the shared form styles' `--th-color-*` custom properties are re-seeded
 * from the live app theme via `.bookingModalContent` (legible in both light
 * and dark).
 */
export function OrganizerBookingDialog({
  open,
  onClose,
  performerOwnerType,
  performerOwnerId,
  performerName,
  title,
}: Props) {
  const t = useTranslations();
  /** Admin slug of the org the request was sent from (null = not sent yet). */
  const [sentFromSlug, setSentFromSlug] = useState<string | null>(null);

  // Reopen starts on a fresh form: clear any prior success state whenever the
  // dialog transitions open (same centralised posture as BookingRequestDialog).
  useEffect(() => {
    if (open) setSentFromSlug(null);
  }, [open]);

  return (
    <Modal open={open} onClose={onClose}>
      <Modal.Panel width={520}>
        <Modal.Header title={title} subtitle={performerName} onClose={onClose} />
        <Modal.Body style={{ maxHeight: "70vh", overflowY: "auto" }}>
          <div className={placeStyles.bookingModalContent}>
            {sentFromSlug ? (
              <div
                className={formStyles.successPanel}
                role="status"
                aria-live="polite"
              >
                <p className={formStyles.successTitle}>
                  {String(t("admin.bkOrgSuccessTitle", { act: performerName }))}
                </p>
                <p className={formStyles.statusText}>
                  {String(t("admin.bkOrgSuccessBody"))}
                </p>
                <p className={formStyles.statusText}>
                  {/* Plain anchor — local convention for the CSS-module entity
                      tree (see UpcomingEventsBlock); a full-page nav out of
                      the portaled dialog is exactly what we want here. */}
                  <a
                    className={formStyles.panelLink}
                    href={`/admin/${encodeURIComponent(sentFromSlug)}/bookings`}
                  >
                    {String(t("admin.bkOrgSuccessLink"))}
                  </a>
                </p>
              </div>
            ) : (
              <OrganizerBookingPanel
                performerOwnerType={performerOwnerType}
                performerOwnerId={performerOwnerId}
                onSuccess={(orgAdminSlug) => setSentFromSlug(orgAdminSlug)}
              />
            )}
          </div>
        </Modal.Body>
        <Modal.Footer>
          <button
            type="button"
            className={placeStyles.bookingModalClose}
            onClick={onClose}
          >
            {String(t("common.close"))}
          </button>
        </Modal.Footer>
      </Modal.Panel>
    </Modal>
  );
}

OrganizerBookingDialog.displayName = "OrganizerBookingDialog";

/* ── Sender-org gate + form switch ───────────────────────────────────────── */

/**
 * Resolves the viewer's eligible sender orgs (edit-role memberships from the
 * shared `useEventOwnerEntities` owners query) and gates the form on having
 * at least one. Requests are sent BY an org (v1 — no human senders), so a
 * viewer with none sees a calm explanatory empty state instead of a form
 * that can only fail. The target org itself is excluded — the server rejects
 * self-booking (`CANNOT_BOOK_OWN_ACT`), so it is never offered.
 */
export function OrganizerBookingPanel({
  performerOwnerType,
  performerOwnerId,
  onSuccess,
}: {
  performerOwnerType: "human" | "org";
  performerOwnerId: string;
  onSuccess: (orgAdminSlug: string) => void;
}) {
  const t = useTranslations();
  const ownersQuery = useEventOwnerEntities();

  const senderOrgs = useMemo<SenderOrg[]>(() => {
    const owners = ownersQuery.ownersWithSlugs ?? [];
    const result: SenderOrg[] = [];
    for (const owner of owners) {
      if (owner.kind !== "org") continue;
      if (
        !(SENDER_ORG_ROLES as readonly string[]).includes(owner.role)
      ) {
        continue;
      }
      // Self-booking guard (mirrors the server's CANNOT_BOOK_OWN_ACT).
      if (performerOwnerType === "org" && owner.orgId === performerOwnerId) {
        continue;
      }
      result.push({
        orgId: owner.orgId,
        orgName: owner.orgName,
        adminSlug: owner.adminSlug,
      });
    }
    return result;
  }, [ownersQuery.ownersWithSlugs, performerOwnerType, performerOwnerId]);

  if (ownersQuery.isPending) {
    return (
      <div className={formStyles.panel}>
        <p className={formStyles.statusText}>{String(t("common.loading"))}</p>
      </div>
    );
  }

  if (ownersQuery.isError) {
    return (
      <div className={formStyles.panel}>
        <p className={formStyles.errorText} role="alert">
          {String(t("admin.bkErrGeneric"))}
        </p>
      </div>
    );
  }

  // No org to send as — calm explanatory gate, pointing at the admin area
  // (groups are created from its account switcher).
  if (senderOrgs.length === 0) {
    return (
      <div className={formStyles.panel}>
        <p className={formStyles.gateTitle}>
          {String(t("admin.bkOrgNoOrgTitle"))}
        </p>
        <p className={formStyles.gateBody}>
          {String(t("admin.bkOrgNoOrgBody"))}
        </p>
        <p className={formStyles.gateBody}>
          <a className={formStyles.panelLink} href="/admin">
            {String(t("admin.bkOrgNoOrgCta"))}
          </a>
        </p>
      </div>
    );
  }

  return (
    <OrganizerBookingForm
      performerOwnerType={performerOwnerType}
      performerOwnerId={performerOwnerId}
      senderOrgs={senderOrgs}
      onSuccess={onSuccess}
    />
  );
}

/* ── Request form ────────────────────────────────────────────────────────── */

function OrganizerBookingForm({
  performerOwnerType,
  performerOwnerId,
  senderOrgs,
  onSuccess,
}: {
  performerOwnerType: "human" | "org";
  performerOwnerId: string;
  senderOrgs: SenderOrg[];
  onSuccess: (orgAdminSlug: string) => void;
}) {
  const t = useTranslations();
  const fmt = useFormatters();
  const idBase = useId();

  const [senderKey, setSenderKey] = useState(0);
  const [message, setMessage] = useState("");
  const [dates, setDates] = useState<string[]>([""]);
  const [setLength, setSetLength] = useState("");
  const [feeType, setFeeType] = useState<"" | (typeof BOOKING_FEE_TYPES)[number]>(
    "",
  );
  const [feeAmountDollars, setFeeAmountDollars] = useState("");
  const [attachedEventId, setAttachedEventId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const sender = senderOrgs[Math.min(senderKey, senderOrgs.length - 1)];
  const today = new Date().toISOString().slice(0, 10);

  // A concrete fee amount only makes sense for GUARANTEE / DOOR_SPLIT (same
  // cross-field rule as the performer→venue form); otherwise the field is
  // hidden AND cleared so a stale value can never be submitted.
  const showFeeAmount = feeType === "GUARANTEE" || feeType === "DOOR_SPLIT";

  // Optional own-event attach: the sender org's draft + published events,
  // upcoming first. Reuses the admin listing (`events.listMine`) — a plain
  // id + title + startsAt subset feeds the select.
  const eventsQuery = trpc.events.listMine.useQuery(
    {
      ownerType: "ORGANIZATION" as const,
      ownerId: sender?.orgId ?? "",
      status: ["DRAFT" as const, "PUBLISHED" as const],
      limit: 100,
    },
    {
      enabled: Boolean(sender?.orgId),
      staleTime: 60_000,
      retry: false,
      meta: { silent: true },
    },
  );

  const eventOptions = useMemo(() => {
    const items = eventsQuery.data?.items ?? [];
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    return items
      .filter(
        (e) => e.startsAt === null || new Date(e.startsAt) >= startOfToday,
      )
      .sort((a, b) => {
        // Dated events ascending; undated last.
        if (a.startsAt === null) return b.startsAt === null ? 0 : 1;
        if (b.startsAt === null) return -1;
        return new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime();
      });
  }, [eventsQuery.data?.items]);

  const createMutation = trpc.bookingRequests.createToPerformer.useMutation({
    retry: false,
    meta: { silent: true },
  });

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (createMutation.isPending || !sender) return;

    const result = buildOrganizerBookingPayload({
      message,
      preferredDates: dates,
      setLengthMinutes: setLength,
      feeType,
      feeAmountDollars,
      attachedEventId,
    });
    if (!result.ok) {
      setError(String(t(result.errorKey)));
      return;
    }

    setError(null);
    createMutation.mutate(
      {
        organizerOrgId: sender.orgId,
        performerOwnerType,
        performerOwnerId,
        ...result.payload,
      },
      {
        onSuccess: () => onSuccess(sender.adminSlug),
        onError: (err) => {
          setError(String(t(mapCreateOrganizerBookingError(err))));
        },
      },
    );
  };

  const updateDateAt = (index: number, value: string) => {
    const next = [...dates];
    next[index] = value;
    setDates(next);
  };

  return (
    <form
      className={formStyles.panel}
      onSubmit={handleSubmit}
      aria-label={String(t("profileStd.requestToBookCta"))}
    >
      {/* Sender org — select when the viewer can act for several, quiet
          identity line when there is exactly one (they should always see
          which group the request goes out under). */}
      {senderOrgs.length > 1 ? (
        <div className={formStyles.fieldGroup}>
          <label className={formStyles.fieldLabel} htmlFor={`${idBase}-sender`}>
            {String(t("admin.bkFormSenderLabel"))}
          </label>
          <select
            id={`${idBase}-sender`}
            className={formStyles.select}
            value={senderKey}
            onChange={(e) => {
              setSenderKey(Number(e.target.value));
              // The attach belongs to the previous org — never carry it over.
              setAttachedEventId("");
            }}
          >
            {senderOrgs.map((s, i) => (
              <option key={s.orgId} value={i}>
                {s.orgName}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <p className={formStyles.fieldHint}>
          {String(t("admin.bkOrgSendingAs", { org: sender?.orgName ?? "" }))}
        </p>
      )}

      {/* ── Message ───────────────────────────────────────────────────── */}
      <div className={formStyles.fieldGroup}>
        <label className={formStyles.fieldLabel} htmlFor={`${idBase}-message`}>
          {String(t("admin.bkFormMessageLabel"))}
        </label>
        <textarea
          id={`${idBase}-message`}
          className={formStyles.textarea}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={String(t("admin.bkOrgMsgPlaceholder"))}
          maxLength={2000}
          required
        />
        <p className={formStyles.fieldHint}>
          {String(t("admin.bkFormMessageHint"))}
        </p>
      </div>

      {/* ── Preferred dates (1–3) ─────────────────────────────────────── */}
      <div className={formStyles.fieldGroup}>
        <span className={formStyles.fieldLabel} id={`${idBase}-dates-label`}>
          {String(t("admin.bkFormDatesLabel"))}
        </span>
        {dates.map((value, index) => (
          <div className={formStyles.repeatRow} key={index}>
            <input
              type="date"
              className={formStyles.input}
              value={value}
              min={today}
              onChange={(e) => updateDateAt(index, e.target.value)}
              aria-label={`${String(t("admin.bkFormDatesLabel"))} ${index + 1}`}
              required={index === 0}
            />
            {dates.length > 1 && (
              <button
                type="button"
                className={formStyles.inlineButton}
                onClick={() => setDates(dates.filter((_, i) => i !== index))}
                aria-label={`${String(t("admin.bkFormRemoveDate"))} ${index + 1}`}
              >
                ×
              </button>
            )}
          </div>
        ))}
        {dates.length < BOOKING_MAX_DATES && (
          <button
            type="button"
            className={formStyles.inlineButton}
            onClick={() => setDates([...dates, ""])}
          >
            {String(t("admin.bkFormAddDate"))}
          </button>
        )}
      </div>

      {/* ── Set length (optional) ─────────────────────────────────────── */}
      <div className={formStyles.fieldGroup}>
        <label
          className={formStyles.fieldLabel}
          htmlFor={`${idBase}-setLength`}
        >
          {String(t("admin.bkFormSetLengthLabel"))} ·{" "}
          {String(t("admin.bkFormOptional"))}
        </label>
        <select
          id={`${idBase}-setLength`}
          className={formStyles.select}
          value={setLength}
          onChange={(e) => setSetLength(e.target.value)}
        >
          <option value="">{String(t("admin.bkFormUnspecified"))}</option>
          {BOOKING_SET_LENGTH_PRESETS.map((minutes) => (
            <option key={minutes} value={String(minutes)}>
              {formatSetLength(minutes)}
            </option>
          ))}
        </select>
      </div>

      {/* ── Offer (optional) ──────────────────────────────────────────── */}
      <div className={formStyles.fieldRow}>
        <div className={`${formStyles.fieldGroup} ${formStyles.feeTypeGroup}`}>
          <label
            className={formStyles.fieldLabel}
            htmlFor={`${idBase}-feeType`}
          >
            {String(t("admin.bkFormFeeTypeLabel"))} ·{" "}
            {String(t("admin.bkFormOptional"))}
          </label>
          <select
            id={`${idBase}-feeType`}
            className={formStyles.select}
            value={feeType}
            onChange={(e) => {
              const next = e.target.value as typeof feeType;
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
                onChange={(e) => setFeeAmountDollars(e.target.value)}
                placeholder="0.00"
              />
            </div>
          </div>
        )}
      </div>

      {/* ── Attach one of your events (optional) ──────────────────────────
          Only rendered when the sender org actually has attachable events —
          never a dead select. A late-arriving list nudges the form once
          (same posture as the venue form's stats line). */}
      {eventOptions.length > 0 && (
      <div className={formStyles.fieldGroup}>
        <label className={formStyles.fieldLabel} htmlFor={`${idBase}-event`}>
          {String(t("admin.bkOrgEventAttachLabel"))} ·{" "}
          {String(t("admin.bkFormOptional"))}
        </label>
        <select
          id={`${idBase}-event`}
          className={formStyles.select}
          value={attachedEventId}
          onChange={(e) => setAttachedEventId(e.target.value)}
        >
          <option value="">{String(t("admin.bkFormUnspecified"))}</option>
          {eventOptions.map((event) => (
            <option key={event.id} value={event.id}>
              {(event.title?.trim() ||
                String(t("admin.bkOrgEventUntitled"))) +
                (event.startsAt
                  ? ` — ${fmt.dateTime(new Date(event.startsAt), {
                      dateStyle: "medium",
                    })}`
                  : "")}
            </option>
          ))}
        </select>
        <p className={formStyles.fieldHint}>
          {String(t("admin.bkOrgEventAttachHint"))}
        </p>
      </div>
      )}

      {error && (
        <p className={formStyles.errorText} role="alert" aria-live="assertive">
          {error}
        </p>
      )}

      <div className={formStyles.submitRow}>
        <BookingSubmitButton pending={createMutation.isPending} />
      </div>
    </form>
  );
}
