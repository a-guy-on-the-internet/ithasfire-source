"use client";

import { XStack, YStack } from "tamagui";
import { Badge, Text, useTranslations } from "@th/ui";
import { MapPin, Users } from "lucide-react";

import type { PlaceVerificationStatus, PlatformPlaceRow } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Shared badges/helpers — used by both the platform places table columns and
// the mobile card so badge tones, labels, and the location string stay
// identical in table and card modes.
// ─────────────────────────────────────────────────────────────────────────────

export const VERIFICATION_LABEL_MAP: Record<PlaceVerificationStatus, string> = {
  VERIFIED: "admin.ppVerified",
  PENDING: "admin.ppPending",
  UNVERIFIED: "admin.ppUnverified",
  REJECTED: "admin.ppRejected",
};

export function verificationBadgeTone(
  status: PlaceVerificationStatus,
): "success" | "info" | "danger" | "warning" {
  switch (status) {
    case "VERIFIED":
      return "success";
    case "PENDING":
      return "info";
    case "REJECTED":
      return "danger";
    case "UNVERIFIED":
      return "warning";
  }
}

export function PlaceVerificationBadge({
  status,
}: {
  status: PlaceVerificationStatus;
}) {
  const t = useTranslations();
  return (
    <Badge tone={verificationBadgeTone(status)} size="sm">
      {String(t(VERIFICATION_LABEL_MAP[status]))}
    </Badge>
  );
}

export function PlaceDirectoryBadge({ listed }: { listed: boolean }) {
  const t = useTranslations();
  return (
    <Badge tone={listed ? "success" : "neutral"} size="sm">
      {listed ? String(t("admin.ppListed")) : String(t("admin.ppUnlisted"))}
    </Badge>
  );
}

/**
 * Archived reads as danger, not warning: warning is already "Unverified",
 * and the two sit side by side on a row.
 */
export function PlaceArchivedBadge() {
  const t = useTranslations();
  return (
    <Badge tone="danger" size="sm">
      {String(t("admin.ppDetailStatusArchived"))}
    </Badge>
  );
}

export function buildLocationString(
  row: Pick<
    PlatformPlaceRow,
    "city" | "region" | "countryCode" | "formattedAddress"
  >,
): string | null {
  const parts: string[] = [];
  if (row.city) parts.push(row.city);
  if (row.region) parts.push(row.region);
  if (row.countryCode) parts.push(row.countryCode);
  if (parts.length > 0) return parts.join(", ");
  if (row.formattedAddress) return row.formattedAddress;
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mobile card (DataTable card mode, <600px)
// ─────────────────────────────────────────────────────────────────────────────

const ELLIPSIS_STYLE = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;

/**
 * Card rendering for platform places rows on phones. Composition: place name
 * + verification badge, then location, then owner count + capacity +
 * directory badge. Tones and labels mirror the table columns exactly (same
 * shared badge components, same location helper).
 */
export function PlatformPlaceMobileCard({ row }: { row: PlatformPlaceRow }) {
  const location = buildLocationString(row);

  return (
    <YStack gap="$2" minWidth={0}>
      <XStack gap="$2" alignItems="center" minWidth={0}>
        <Text
          variant="bodySmall"
          weight="bold"
          flex={1}
          minWidth={0}
          style={ELLIPSIS_STYLE}
        >
          {row.name}
        </Text>
        <XStack flexShrink={0}>
          <PlaceVerificationBadge status={row.verificationStatus} />
        </XStack>
      </XStack>

      {location ? (
        <XStack gap="$1" alignItems="center" minWidth={0}>
          <MapPin size={11} style={{ opacity: 0.5, flexShrink: 0 }} />
          <Text
            variant="caption"
            tone="muted"
            minWidth={0}
            style={ELLIPSIS_STYLE}
          >
            {location}
          </Text>
        </XStack>
      ) : null}

      <XStack gap="$3" alignItems="center" flexWrap="wrap">
        <XStack gap="$1" alignItems="center" flexShrink={0}>
          <Users size={12} style={{ opacity: 0.5 }} />
          <Text variant="caption" tone="muted">
            {row.ownerCount}
          </Text>
        </XStack>
        {row.capacity ? (
          <Text variant="caption" tone="muted">
            {row.capacity.toLocaleString()}
          </Text>
        ) : null}
        <PlaceDirectoryBadge listed={row.listedInDirectory} />
        {row.status === "ARCHIVED" ? <PlaceArchivedBadge /> : null}
      </XStack>
    </YStack>
  );
}
