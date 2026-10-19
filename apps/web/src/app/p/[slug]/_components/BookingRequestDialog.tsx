"use client";

import { useEffect, useState } from "react";
import { Modal, useTranslations } from "@th/ui";

import { useMinViewportWidth } from "@/hooks/useMinViewportWidth";

import { RequestToPlayPanel } from "./blocks/RequestToPlayForm";
import type { BookingIntent } from "./blocks/request-to-play-form.helpers";
import placeStyles from "./place-entity.module.css";
import formStyles from "./blocks/RequestToPlayBlock.module.css";

type Props = {
  open: boolean;
  onClose: () => void;
  placeId: string;
  placeName: string;
  /**
   * Visible dialog title. Drives the header copy so it always matches the
   * trigger that opened it (hero button OR the bottom nav's "Request to book").
   */
  title: string;
  /**
   * The intent the trigger asked for ("Play here" → PERFORM, "Rent or use a
   * space" → RENT). The panel falls back when the place does not offer it.
   */
  intent?: BookingIntent | null;
};

type Sent = { intent: BookingIntent };

/**
 * The dialog widens for the "What {place} expects" rail (venue-booking-
 * standards FR-005, board S1) — on desktop only. Below this the panel keeps
 * today's 520px and the rail folds above the fields. 960 = the 880px panel
 * plus room for the 95vw cap, so nothing scrolls sideways between 600 and
 * 960px. The form picks its own layout from its container width, so the
 * two can never disagree.
 */
const WIDE_DIALOG_MIN_VIEWPORT = 960;
const WIDE_DIALOG_WIDTH = 880;
const NARROW_DIALOG_WIDTH = 520;

/**
 * Shared venue booking-request dialog.
 *
 * The single implementation of the "Request to book" surface — a portaled
 * Modal hosting the shared `RequestToPlayPanel` (intent switch →
 * performer-mode gate → booking form → success). Both place-page CTAs and
 * the mobile bottom bar open this one dialog with the intent preselected.
 *
 * Success state is owned here and reset each time the dialog transitions
 * open, so a reopen always starts on a fresh form. The success body reads
 * per intent.
 *
 * The dialog portals to `document.body`, outside the entity-page theme scope,
 * so the shared form's `--th-color-*` custom properties are re-seeded from the
 * live app theme via `.bookingModalContent` (keeps the submit CTA legible in
 * both light and dark).
 */
export function BookingRequestDialog({
  open,
  onClose,
  placeId,
  placeName,
  title,
  intent = null,
}: Props) {
  const t = useTranslations();
  const [sent, setSent] = useState<Sent | null>(null);
  const wideViewport = useMinViewportWidth(WIDE_DIALOG_MIN_VIEWPORT);
  // The success message is a sentence; it does not need the rail's width.
  const panelWidth =
    wideViewport && !sent ? WIDE_DIALOG_WIDTH : NARROW_DIALOG_WIDTH;

  // Reopen starts on a fresh form: clear any prior success state whenever the
  // dialog transitions open (centralised so every trigger gets the same
  // behaviour).
  useEffect(() => {
    if (open) setSent(null);
  }, [open]);

  const successBodyKey =
    sent?.intent === "RENT" ? "admin.bkSuccessBodyRent" : "admin.bkSuccessBody";

  return (
    <Modal open={open} onClose={onClose}>
      <Modal.Panel width={panelWidth}>
        <Modal.Header title={title} subtitle={placeName} onClose={onClose} />
        <Modal.Body style={{ maxHeight: "70vh", overflowY: "auto" }}>
          <div className={placeStyles.bookingModalContent}>
            {sent ? (
              <div
                className={formStyles.successPanel}
                role="status"
                aria-live="polite"
              >
                <p className={formStyles.successTitle}>
                  {String(t("admin.bkSuccessTitle", { place: placeName }))}
                </p>
                <p className={formStyles.statusText}>
                  {String(t(successBodyKey))}
                </p>
              </div>
            ) : (
              <RequestToPlayPanel
                placeId={placeId}
                placeName={placeName}
                intent={intent}
                onSuccess={setSent}
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

BookingRequestDialog.displayName = "BookingRequestDialog";
