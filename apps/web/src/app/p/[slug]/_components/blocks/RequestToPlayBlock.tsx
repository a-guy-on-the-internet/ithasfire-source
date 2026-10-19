"use client";

import { useId, useState } from "react";
import { usePathname } from "next/navigation";
import { useTranslations } from "@th/ui";
import type { PageBlockRecord } from "@th/types/repos/entity-pages";

import { useSessionGate } from "@/hooks/useSessionGate";

import { BlockSection, BlockHeading } from "./block-primitives";
import { useBlockRenderMode } from "./block-render-context";
import { useBlockPageOwner } from "./block-page-owner-context";
import { RequestToPlayPanel } from "./RequestToPlayForm";
import styles from "./block-primitives.module.css";
import formStyles from "./RequestToPlayBlock.module.css";

type RequestToPlayData = {
  heading?: string;
  intro?: string;
};

type Props = {
  block: PageBlockRecord;
};

/**
 * Entry-point block for performers to request to play at a venue.
 *
 * Public render (only mounted when the venue is verified + accepting requests —
 * gating happens in `EntityPageShell`): a Swiss CTA card that expands into the
 * booking-request form. Viewer states:
 *
 * - signed out → CTA links to /sign-in with a redirect back to this page;
 * - signed in → the booking-request form (`bookingRequests.create`), for
 *   any sender. Performer mode gates only the sender's own row on the bill
 *   ("I'm on the bill"), with a one-click enable (`performers.setMode`)
 *   beside it (lineup v2 D3 / v3 board F1).
 *
 * The sender list, bill and form live in the shared `RequestToPlayPanel`
 * (`./RequestToPlayForm`), which the venue hero's booking dialog also mounts —
 * one form implementation, two hosts.
 *
 * Editor render: an owner-facing labelled placeholder so the block can be
 * positioned even while it is hidden from the public page.
 */
export function RequestToPlayBlock({ block }: Props) {
  const t = useTranslations();
  const mode = useBlockRenderMode();
  const data = (block.data ?? {}) as RequestToPlayData;

  if (mode === "editor") {
    return (
      <div className={styles.editorPlaceholder}>
        <span className={styles.editorPlaceholderLabel}>
          {String(t("admin.peBlockKindRequestToPlay"))}
        </span>
        <p className={styles.editorPlaceholderHint}>
          {String(t("admin.peBlockRequestToPlayEditorHint"))}
        </p>
      </div>
    );
  }

  const heading =
    data.heading?.trim() || String(t("admin.peBlockKindRequestToPlay"));
  const intro =
    data.intro?.trim() || String(t("admin.peBlockRequestToPlayDefaultIntro"));

  return (
    <BlockSection>
      <BlockHeading>{heading}</BlockHeading>
      <div className={styles.vStack} style={{ gap: "0.75rem" }}>
        {intro && (
          <p style={{ opacity: 0.8, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
            {intro}
          </p>
        )}
        <RequestToPlayCta />
      </div>
    </BlockSection>
  );
}

/* ── Public CTA + expansion ──────────────────────────────────────────────── */

function RequestToPlayCta() {
  const t = useTranslations();
  const pathname = usePathname();
  const owner = useBlockPageOwner();
  const place = owner?.place ?? null;

  const { isSignedIn, isPending } = useSessionGate();

  const [open, setOpen] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const panelId = useId();

  // The block can only act when it knows which place owns the page.
  if (!place) {
    return (
      <button
        type="button"
        className={`${styles.ctaButton} ${styles.ctaButtonDisabled}`}
        disabled
        aria-disabled="true"
      >
        {String(t("admin.peBlockKindRequestToPlay"))}
      </button>
    );
  }

  if (sentTo) {
    return (
      <div className={formStyles.successPanel} role="status" aria-live="polite">
        <p className={formStyles.successTitle}>
          {String(t("admin.bkSuccessTitle", { place: sentTo }))}
        </p>
        <p className={formStyles.statusText}>
          {String(t("admin.bkSuccessBody"))}
        </p>
      </div>
    );
  }

  // Signed out: send through sign-in and back to this page.
  if (!isSignedIn && !isPending) {
    return (
      <a
        href={`/sign-in?redirect=${encodeURIComponent(pathname ?? "/")}`}
        className={styles.ctaButton}
      >
        {String(t("admin.peBlockKindRequestToPlay"))}
        <span className={styles.ctaButtonNote}>
          {String(t("admin.bkCtaSignInNote"))}
        </span>
      </a>
    );
  }

  return (
    <>
      <button
        type="button"
        className={`${styles.ctaButton}${isPending ? ` ${styles.ctaButtonDisabled}` : ""}`}
        disabled={isPending}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
      >
        {String(t("admin.peBlockKindRequestToPlay"))}
      </button>
      {open && (
        <div id={panelId}>
          <RequestToPlayPanel
            placeId={place.id}
            placeName={place.name}
            onSuccess={() => setSentTo(place.name)}
          />
        </div>
      )}
    </>
  );
}
