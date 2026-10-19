"use client";

import { Spinner, useTranslations } from "@th/ui";

import styles from "./block-primitives.module.css";
import formStyles from "./RequestToPlayBlock.module.css";

type Props = {
  pending: boolean;
};

/**
 * Submit CTA shared by the two booking-request forms (venue-page
 * RequestToPlayForm and OrganizerBookingDialog).
 *
 * Width is stable across the idle → pending swap: both labels are stacked in
 * one grid cell (the inactive one is `visibility: hidden`, so it still holds
 * width), and the spinner slot is reserved at all times. The spinner draws in
 * `currentColor` so it follows the entity page's themed CTA foreground — the
 * `@th/ui` default (`$accent` on the fill) would be near-invisible here.
 */
export function BookingSubmitButton({ pending }: Props) {
  const t = useTranslations();
  return (
    <button
      type="submit"
      className={styles.ctaButton}
      style={{ marginTop: 0 }}
      disabled={pending}
      aria-busy={pending}
    >
      {/* Decorative: the visible "Sending…" label plus aria-busy already
          carry the state, so the spinner's own role="status" is hidden to
          avoid a double announcement. */}
      <span className={formStyles.submitSpinnerSlot} aria-hidden="true">
        {pending && (
          <Spinner
            size="sm"
            tag="span"
            indicatorColor="currentColor"
            trackColor="transparent"
          />
        )}
      </span>
      <span className={formStyles.submitLabelStack}>
        <span
          className={pending ? formStyles.submitLabelHidden : undefined}
          aria-hidden={pending || undefined}
        >
          {String(t("admin.bkFormSubmit"))}
        </span>
        <span
          className={pending ? undefined : formStyles.submitLabelHidden}
          aria-hidden={!pending || undefined}
        >
          {String(t("admin.bkFormSubmitting"))}
        </span>
      </span>
    </button>
  );
}
