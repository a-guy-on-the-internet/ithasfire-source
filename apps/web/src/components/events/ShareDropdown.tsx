"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useTranslations } from "@th/ui";
import { Check, Copy, ExternalLink, Share2 } from "lucide-react";

export type ShareDropdownProps = {
  title: string;
  /**
   * When true, the trigger chrome renders for a dark surface (the immersive
   * event hero scrim): light hairline border + on-dark icon, instead of the
   * themed ink that would vanish on dark. The dropdown menu itself is an
   * independent dark popover and is unaffected.
   */
  onDark?: boolean;
  /**
   * `poster` renders the trigger as one of the poster-first page's rail
   * actions (`.event-poster-action`): a 40px square over the poster on a
   * phone, one of three equal 44px buttons under it wide — CSS decides, this
   * component renders one node. The menu is unchanged.
   */
  variant?: "default" | "poster";
};

export function ShareDropdown({
  title,
  onDark = false,
  variant = "default",
}: ShareDropdownProps) {
  // Off the scrim: the themed tokens as CSS vars rather than
  // `theme.<token>.val`, so the trigger follows the embed's host-colour
  // bridge (a JS-resolved value stayed ink on a dark host page).
  const triggerBorder = onDark
    ? "color-mix(in srgb, var(--onStructure, #FDFAF3) 40%, transparent)"
    : "var(--borderColor, #211C16)";
  const triggerColor = onDark
    ? "var(--onStructure, #FDFAF3)"
    : "var(--color, #211C16)";
  const t = useTranslations();

  const [shareOpen, setShareOpen] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const shareRef = useRef<HTMLDivElement>(null);

  const [canNativeShare, setCanNativeShare] = useState(false);
  const [pageUrl, setPageUrl] = useState("");
  useEffect(() => {
    if (typeof navigator !== "undefined" && "share" in navigator) {
      setCanNativeShare(true);
    }
    setPageUrl(window.location.href);
  }, []);

  // Close share dropdown when clicking outside
  useEffect(() => {
    if (!shareOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (shareRef.current && !shareRef.current.contains(e.target as Node)) {
        setShareOpen(false);
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setShareOpen(false);
        // Return focus to the trigger button
        const trigger = shareRef.current?.querySelector<HTMLElement>("button");
        trigger?.focus();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [shareOpen]);

  const handleCopyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const input = document.createElement("input");
      input.value = window.location.href;
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      document.body.removeChild(input);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    }
    setShareOpen(false);
  }, []);

  const handleNativeShare = useCallback(async () => {
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({ title, url: window.location.href });
      } catch {
        // User cancelled — ignore
      }
      setShareOpen(false);
    }
  }, [title]);

  const poster = variant === "poster";

  return (
    <div
      className={
        poster
          ? "share-dropdown-anchor event-poster-action-anchor"
          : "share-dropdown-anchor"
      }
      data-open={shareOpen}
      ref={shareRef}
    >
      <button
        onClick={() => setShareOpen((prev) => !prev)}
        aria-label={String(t("eventDetail.share"))}
        aria-expanded={shareOpen}
        aria-haspopup="menu"
        className={poster ? "event-poster-action" : undefined}
        style={poster ? undefined : {
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          // 44 = the icon-only button floor (design-system §6: icon-only
          // controls are square and ≥44×44 touch targets).
          width: 44,
          height: 44,
          borderRadius: 0,
          border: `1px solid ${triggerBorder}`,
          backgroundColor: "transparent",
          color: triggerColor,
          cursor: "pointer",
          flexShrink: 0,
          marginTop: 2,
        }}
      >
        <Share2 size={poster ? 16 : 18} aria-hidden="true" />
        {poster && (
          /* The visible label is the one word; the aria-label above keeps the
             fuller "Share event", which contains it (WCAG 2.5.3). */
          <span className="event-poster-action__label">
            {String(t("pageActions.share"))}
          </span>
        )}
      </button>
      <div className="share-dropdown-menu" role="menu">
        {canNativeShare && (
          <button
            className="share-dropdown-item"
            role="menuitem"
            onClick={handleNativeShare}
          >
            <ExternalLink size={16} aria-hidden="true" />
            {String(t("eventDetail.shareNative"))}
          </button>
        )}
        <button
          className="share-dropdown-item"
          role="menuitem"
          onClick={handleCopyLink}
        >
          {linkCopied ? (
            <Check size={16} aria-hidden="true" />
          ) : (
            <Copy size={16} aria-hidden="true" />
          )}
          <span aria-live="polite">
            {linkCopied
              ? String(t("eventDetail.shareLinkCopied"))
              : String(t("eventDetail.shareCopyLink"))}
          </span>
        </button>
        <a
          className="share-dropdown-item"
          role="menuitem"
          href={`https://twitter.com/intent/tweet?url=${encodeURIComponent(pageUrl)}&text=${encodeURIComponent(title)}`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => setShareOpen(false)}
        >
          <ExternalLink size={16} aria-hidden="true" />
          {String(t("eventDetail.shareTwitter"))}
          <span className="sr-only"> (opens in new tab)</span>
        </a>
        <a
          className="share-dropdown-item"
          role="menuitem"
          href={`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(pageUrl)}`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => setShareOpen(false)}
        >
          <ExternalLink size={16} aria-hidden="true" />
          {String(t("eventDetail.shareFacebook"))}
          <span className="sr-only"> (opens in new tab)</span>
        </a>
      </div>
    </div>
  );
}
