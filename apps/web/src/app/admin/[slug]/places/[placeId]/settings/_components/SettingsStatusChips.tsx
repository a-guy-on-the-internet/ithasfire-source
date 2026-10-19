"use client";

import type { CSSProperties } from "react";
import { useTranslations } from "@th/ui";

import {
  VERIFICATION_LABEL_KEY,
  type PlaceVerificationStatus,
} from "@/lib/verification-config";

/**
 * The venue settings header's status strip: the four yes/no answers an owner
 * checks first, readable before scrolling to the section that changes them.
 *
 * READ-ONLY. A chip is a label, not a control — each state is changed in its
 * own section below (verification in Verification, listing by the platform,
 * page visibility in Public page, ratings in Reviews & feedback).
 *
 * The dot is the ONLY colour and it is never the only carrier of meaning: the
 * chip's text states the state in words, so the strip reads the same with
 * colour removed. The dot is `aria-hidden`.
 *
 * A chip whose data is not loaded yet is OMITTED rather than guessed — the
 * page-visibility chip in particular waits on `entityPages.getMyPage`, and a
 * wrong "Page private" for a public page is worse than a chip arriving late.
 */
export type SettingsChipTone = "success" | "warning" | "danger" | "neutral";

export type SettingsStatusChipsProps = {
  verificationStatus: PlaceVerificationStatus;
  listedInDirectory: boolean;
  /** `null` while the public page read is loading, or for an unverified venue. */
  pageVisibility: "PUBLIC" | "UNLISTED" | "PRIVATE" | null;
  attendeeReviewsPublic: boolean;
};

/** Semantic token per tone, with the Stub value as the first-paint fallback. */
const DOT_COLOR: Record<SettingsChipTone, string> = {
  success: "var(--success, #166534)",
  warning: "var(--warning, #92400E)",
  danger: "var(--danger, #B91C1C)",
  neutral: "var(--colorMuted, #5C544A)",
};

const VERIFICATION_TONE: Record<PlaceVerificationStatus, SettingsChipTone> = {
  VERIFIED: "success",
  PENDING: "warning",
  REJECTED: "danger",
  UNVERIFIED: "neutral",
};

const PAGE_VISIBILITY: Record<
  "PUBLIC" | "UNLISTED" | "PRIVATE",
  { key: string; tone: SettingsChipTone }
> = {
  PUBLIC: { key: "admin.placeSettingsChipPagePublic", tone: "success" },
  UNLISTED: { key: "admin.placeSettingsChipPageUnlisted", tone: "warning" },
  PRIVATE: { key: "admin.placeSettingsChipPagePrivate", tone: "neutral" },
};

const LIST_STYLE: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: 8,
  margin: 0,
  padding: 0,
  listStyle: "none",
  minWidth: 0,
};

/**
 * The label idiom (DS v2: IBM Plex Mono at the `sm` step — the label size,
 * one up from the 9.5px badge step so a status reads at a glance — size and
 * tracking together). Borders and fills are the semantic tokens with their
 * Stub fallbacks; nothing here is a raw colour.
 */
const CHIP_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 7,
  padding: "6px 10px",
  border: "1px solid var(--borderColor, #211C16)",
  background: "var(--surface, #FDFAF3)",
  color: "var(--color, #211C16)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-mono-sm, 11px)",
  letterSpacing: "var(--tr-mono-sm, 2px)",
  fontWeight: 600,
  textTransform: "uppercase",
  lineHeight: 1.2,
  maxWidth: "100%",
};

function Chip({
  tone,
  label,
  testId,
}: {
  tone: SettingsChipTone;
  label: string;
  testId: string;
}) {
  return (
    <li style={CHIP_STYLE} data-testid={testId} data-tone={tone}>
      <span
        aria-hidden="true"
        style={{
          width: 8,
          height: 8,
          flexShrink: 0,
          background: DOT_COLOR[tone],
        }}
      />
      <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{label}</span>
    </li>
  );
}

export function SettingsStatusChips({
  verificationStatus,
  listedInDirectory,
  pageVisibility,
  attendeeReviewsPublic,
}: SettingsStatusChipsProps) {
  const t = useTranslations();
  const page = pageVisibility ? PAGE_VISIBILITY[pageVisibility] : null;

  return (
    <ul
      role="list"
      aria-label={String(t("admin.placeSettingsChipsLabel"))}
      style={LIST_STYLE}
      data-testid="place-settings-status-chips"
    >
      <Chip
        tone={VERIFICATION_TONE[verificationStatus] ?? "neutral"}
        label={String(
          t(
            VERIFICATION_LABEL_KEY[verificationStatus] ??
              VERIFICATION_LABEL_KEY.UNVERIFIED,
          ),
        )}
        testId="place-settings-chip-verification"
      />
      <Chip
        tone={listedInDirectory ? "success" : "neutral"}
        label={String(
          t(
            listedInDirectory
              ? "admin.placeEditListedBadge"
              : "admin.placeEditNotListedBadge",
          ),
        )}
        testId="place-settings-chip-listing"
      />
      {page ? (
        <Chip
          tone={page.tone}
          label={String(t(page.key))}
          testId="place-settings-chip-page"
        />
      ) : null}
      <Chip
        tone={attendeeReviewsPublic ? "success" : "warning"}
        label={String(
          t(
            attendeeReviewsPublic
              ? "admin.placeSettingsChipRatingsPublic"
              : "admin.placeSettingsChipRatingsPrivate",
          ),
        )}
        testId="place-settings-chip-ratings"
      />
    </ul>
  );
}
