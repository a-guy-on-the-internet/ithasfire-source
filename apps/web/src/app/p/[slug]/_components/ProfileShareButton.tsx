"use client";

import { useCallback, useState } from "react";
import { Share2, Check } from "lucide-react";
import { useTranslations } from "@th/ui";

import styles from "./place-entity.module.css";

type Props = {
  /** Title passed to the native share sheet. */
  title: string;
};

/**
 * Self-contained Swiss share control for the standard profile templates.
 *
 * Deliberately NOT the event-page `ShareDropdown` — that component's popover
 * styling lives in `event-content.css`, which is not loaded on `/p/[slug]`, so
 * its menu would render unstyled and inline here. This button uses the native
 * share sheet when available and falls back to copying the link, with a
 * transient "copied" affirmation. Styled to match the secondary hero CTA.
 */
export function ProfileShareButton({ title }: Props) {
  const t = useTranslations();
  const [copied, setCopied] = useState(false);

  const onShare = useCallback(async () => {
    const url = typeof window !== "undefined" ? window.location.href : "";
    if (!url) return;
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({ title, url });
        return;
      } catch (err) {
        // A user-cancelled share (AbortError) is a no-op. ANY OTHER failure
        // (permission policy, embedded webview, non-secure context) must fall
        // through to the clipboard — swallowing it made this button do
        // nothing at all on those browsers.
        if (err instanceof DOMException && err.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked — nothing else to do.
    }
  }, [title]);

  return (
    <button
      type="button"
      className={styles.directionsButton}
      onClick={() => void onShare()}
      aria-label={String(t("profileStd.share"))}
    >
      {copied ? (
        <Check size={16} aria-hidden />
      ) : (
        <Share2 size={16} aria-hidden />
      )}
      <span aria-live="polite">
        {copied ? t("places.shareCopiedToast") : t("profileStd.share")}
      </span>
    </button>
  );
}
