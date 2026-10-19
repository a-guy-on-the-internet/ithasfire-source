"use client";

import type { ReactNode } from "react";
import { XStack, YStack } from "tamagui";
import { Badge, Text, useFormatters, useTranslations } from "@th/ui";

import { fmtDate, truncateId } from "@/lib/format";

// ─────────────────────────────────────────────────────────────────────────────
// Shared badges — used by both the humans table columns and the mobile card so
// tones and labels stay identical in table and card modes.
// ─────────────────────────────────────────────────────────────────────────────

export const HUMAN_STATUS_TONE: Record<
  string,
  "success" | "warning" | "error" | "neutral" | "info"
> = {
  ACTIVE: "success",
  INVITED: "info",
  SUSPENDED: "warning",
  BANNED: "error",
};

export const HUMAN_STATUS_LABEL_KEY: Record<string, string> = {
  ACTIVE: "admin.phStatusActive",
  INVITED: "admin.phStatusInvited",
  SUSPENDED: "admin.phStatusSuspended",
  BANNED: "admin.phStatusBanned",
};

export function HumanStatusBadge({ status }: { status: string }) {
  const t = useTranslations();
  return (
    <Badge tone={HUMAN_STATUS_TONE[status] ?? "neutral"} size="sm">
      {String(t(HUMAN_STATUS_LABEL_KEY[status] ?? status))}
    </Badge>
  );
}

/** A banned or suspended human this sign-up shares a network with. */
export interface FlaggedSignupMatch {
  bannedHumanId: string;
  bannedHumanName: string | null;
  /** The source account's status: BANNED or SUSPENDED. */
  bannedHumanStatus?: string;
}

type Translate = ReturnType<typeof useTranslations>;

/**
 * "Same network as a banned account: X" / "…a suspended account: Y" — one
 * line per status present. Falls back to the plain "Same network as X" for a
 * match with no known status.
 */
export function flaggedMatchLines(
  t: Translate,
  matches: readonly FlaggedSignupMatch[],
): string[] {
  const banned = matches.filter((m) => m.bannedHumanStatus === "BANNED");
  const suspended = matches.filter((m) => m.bannedHumanStatus === "SUSPENDED");
  const other = matches.filter(
    (m) =>
      m.bannedHumanStatus !== "BANNED" && m.bannedHumanStatus !== "SUSPENDED",
  );
  const lines: string[] = [];
  if (banned.length > 0) {
    lines.push(
      String(
        t("admin.phFlaggedMatchBanned", { names: flaggedMatchNames(banned) }),
      ),
    );
  }
  if (suspended.length > 0) {
    lines.push(
      String(
        t("admin.phFlaggedMatchSuspended", {
          names: flaggedMatchNames(suspended),
        }),
      ),
    );
  }
  if (other.length > 0) {
    lines.push(
      String(t("admin.phFlaggedMatch", { names: flaggedMatchNames(other) })),
    );
  }
  return lines;
}

/** Column cell form: "Name (banned)" / "Name (suspended)". */
export function flaggedMatchAccounts(
  t: Translate,
  matches: readonly FlaggedSignupMatch[],
): string {
  return matches
    .map((m) => {
      const name = m.bannedHumanName || truncateId(m.bannedHumanId);
      if (m.bannedHumanStatus === "BANNED") {
        return String(t("admin.phFlaggedAccountBanned", { name }));
      }
      if (m.bannedHumanStatus === "SUSPENDED") {
        return String(t("admin.phFlaggedAccountSuspended", { name }));
      }
      return name;
    })
    .join(", ");
}

/** The banned accounts a flagged sign-up matches, as display names. */
export function flaggedMatchNames(
  matches: readonly FlaggedSignupMatch[],
): string {
  return matches
    .map((m) => m.bannedHumanName || truncateId(m.bannedHumanId))
    .join(", ");
}

/**
 * "Flagged" badge for a sign-up that shares a network with a banned account.
 * Staff decide; nothing is blocked. The flag is derived by
 * `platform.listFlaggedSignups`, never stored on the human.
 */
export function FlaggedSignupBadge() {
  const t = useTranslations();
  return (
    <Badge tone="warning" size="sm">
      {String(t("admin.phFlagged"))}
    </Badge>
  );
}

export function HumanVerifiedBadge({ verified }: { verified: boolean }) {
  const t = useTranslations();
  return (
    <Badge tone={verified ? "success" : "warning"} size="sm">
      {verified
        ? String(t("admin.phVerified"))
        : String(t("admin.phUnverified"))}
    </Badge>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Mobile card (DataTable card mode, <600px)
// ─────────────────────────────────────────────────────────────────────────────

export interface HumanMobileCardRow {
  id: string;
  name: string | null;
  status: string;
  createdAt: Date | string;
  identity: {
    email: string;
    emailVerified: boolean;
  } | null;
}

const ELLIPSIS_STYLE = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;

/**
 * Card rendering for platform humans rows on phones. Composition: name +
 * status badge + the actions menu, then email, then verified badge + joined
 * date, then the human id in mono (matching the table's mono id column).
 *
 * `actions` carries the page's `<HumanActions>` menu — the table renders it
 * in a regular column, which card mode does not show, so the card surfaces
 * the same trigger to keep suspend/ban/verify/delete reachable on phones.
 */
export function HumanMobileCard({
  row,
  actions,
  flaggedMatches,
}: {
  row: HumanMobileCardRow;
  actions?: ReactNode;
  /** Set when this row is a flagged sign-up (see FlaggedSignupBadge). */
  flaggedMatches?: readonly FlaggedSignupMatch[];
}) {
  const t = useTranslations();
  const fmt = useFormatters();

  return (
    <YStack gap="$2" minWidth={0}>
      <XStack gap="$2" alignItems="center" minWidth={0}>
        <Text
          variant="bodySmall"
          weight="bold"
          tone={row.name ? "default" : "muted"}
          flex={1}
          minWidth={0}
          style={ELLIPSIS_STYLE}
        >
          {row.name || "—"}
        </Text>
        <XStack flexShrink={0} gap="$1" alignItems="center">
          <HumanStatusBadge status={row.status} />
          {/* The page passes <HumanActions triggerSize="lg" /> here so the
              interactive trigger itself is a 44x44 touch target — no sizing
              wrapper needed. */}
          {actions ?? null}
        </XStack>
      </XStack>

      {row.identity?.email ? (
        <Text
          variant="caption"
          tone="muted"
          minWidth={0}
          style={ELLIPSIS_STYLE}
        >
          {row.identity.email}
        </Text>
      ) : null}

      {flaggedMatches && flaggedMatches.length > 0 ? (
        <YStack gap="$1" minWidth={0}>
          <XStack>
            <FlaggedSignupBadge />
          </XStack>
          {/* Wraps rather than truncating: the names ARE the information. */}
          {flaggedMatchLines(t, flaggedMatches).map((line) => (
            <Text key={line} variant="caption" tone="muted" minWidth={0}>
              {line}
            </Text>
          ))}
        </YStack>
      ) : null}

      <XStack gap="$2" alignItems="center" flexWrap="wrap">
        <HumanVerifiedBadge verified={Boolean(row.identity?.emailVerified)} />
        <Text variant="caption" tone="muted">
          {String(t("admin.phColJoined"))} {fmtDate(fmt, row.createdAt)}
        </Text>
      </XStack>

      <Text variant="code" fontSize={11} tone="muted">
        {truncateId(row.id)}
      </Text>
    </YStack>
  );
}
