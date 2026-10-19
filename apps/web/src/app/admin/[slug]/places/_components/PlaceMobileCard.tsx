"use client";

import { XStack, YStack } from "tamagui";
import { Badge, Text, useTranslations } from "@th/ui";
import { MapPin, Users } from "lucide-react";

import {
  badgeToneForVerification,
  effectiveVerificationStatus,
  getStatusBadgeTone,
  type PlaceStatus,
  type PlaceVerificationStatus,
} from "@/lib/verification-config";

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers — used by both the PlacesTable columns and the mobile card so
// badge tones and address formatting stay identical in table and card modes.
//
// The badge vocabulary itself (the two tone functions and the two status
// unions) now lives in `@/lib/verification-config`, beside VERIFICATION_ICON_MAP
// — the place editor's settings aside needs the same tones, and a copy per
// surface is how the icon map came to be centralised in the first place. They
// are RE-EXPORTED here so every existing `from "./PlaceMobileCard"` import
// keeps resolving; new call sites should import from the config module.
// ─────────────────────────────────────────────────────────────────────────────

export {
  badgeToneForVerification,
  getStatusBadgeTone,
  type PlaceStatus,
  type PlaceVerificationStatus,
} from "@/lib/verification-config";

export interface PlaceAddressParts {
  formattedAddress: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  countryCode: string | null;
  /**
   * Whether THIS viewer may see this venue's address
   * (place-address-withholding). `listHumanPlaces` sends it on every row —
   * true for a venue the actor owns, or one that publishes its address; false
   * for a withheld venue somebody else owns, whose street parts arrive nulled.
   *
   * OPTIONAL, and therefore fail-closed below: a caller that does not carry it
   * gets no reconstructed street line rather than one built from whatever
   * parts happened to be in the row.
   */
  locationIsExact?: boolean;
}

/**
 * Build a full human-readable address from parts, falling back to
 * formattedAddress. Returns null when the address is WITHHELD from this viewer.
 *
 * The withheld check comes first on purpose. The parts this reads are redacted
 * server-side, so today they are already null — but a function whose whole job
 * is "reassemble a street address from fragments" is exactly the one that must
 * not be one upstream regression away from doing it anyway. Callers render
 * `admin.placesAddressWithheld` for the null, which also answers the question
 * an empty cell raises ("is this venue missing an address, or hiding one?").
 */
export function buildFullAddress(row: PlaceAddressParts): string | null {
  if (row.locationIsExact !== true) return null;
  const parts: string[] = [];
  if (row.addressLine1 && row.addressLine1 !== "TBD")
    parts.push(row.addressLine1);
  if (row.addressLine2) parts.push(row.addressLine2);

  const cityRegionParts: string[] = [];
  if (row.city) cityRegionParts.push(row.city);
  if (row.region) cityRegionParts.push(row.region);
  if (cityRegionParts.length > 0) {
    const cityRegion = cityRegionParts.join(", ");
    if (row.postalCode) {
      parts.push(`${cityRegion} ${row.postalCode}`);
    } else {
      parts.push(cityRegion);
    }
  } else if (row.postalCode) {
    parts.push(row.postalCode);
  }

  if (row.countryCode) parts.push(row.countryCode);

  if (parts.length > 0) return parts.join(", ");

  // Fall back to formattedAddress
  if (row.formattedAddress && row.formattedAddress !== "TBD")
    return row.formattedAddress;

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mobile card (DataTable card mode, <600px)
// ─────────────────────────────────────────────────────────────────────────────

export interface PlaceMobileCardRow extends PlaceAddressParts {
  name: string;
  status: PlaceStatus;
  verificationStatus: PlaceVerificationStatus;
  activeVerificationRequestStatus: "PENDING" | "IN_REVIEW" | null;
  capacity: number | null;
}

const ELLIPSIS_STYLE = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;

/**
 * Card rendering for PlacesTable rows on phones. Composition: place name +
 * status badge, then address, then verification badge + capacity. Tones and
 * labels mirror the table columns exactly (same helpers, same raw labels).
 */
export function PlaceMobileCard({ row }: { row: PlaceMobileCardRow }) {
  const t = useTranslations();
  const effective = effectiveVerificationStatus(
    row.verificationStatus,
    row.activeVerificationRequestStatus,
  );
  const address = buildFullAddress(row);

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
          <Badge tone={getStatusBadgeTone(row.status)} size="sm">
            {row.status}
          </Badge>
        </XStack>
      </XStack>

      {address === null && row.locationIsExact !== true ? (
        <XStack gap="$1" alignItems="center" minWidth={0}>
          <MapPin size={11} style={{ opacity: 0.5, flexShrink: 0 }} />
          <Text variant="caption" tone="muted" style={ELLIPSIS_STYLE}>
            {String(t("admin.placesAddressWithheld"))}
          </Text>
        </XStack>
      ) : address ? (
        <XStack gap="$1" alignItems="center" minWidth={0}>
          <MapPin size={11} style={{ opacity: 0.5, flexShrink: 0 }} />
          <Text
            variant="caption"
            tone="muted"
            minWidth={0}
            style={ELLIPSIS_STYLE}
          >
            {address}
          </Text>
        </XStack>
      ) : null}

      <XStack gap="$3" alignItems="center" flexWrap="wrap">
        <Badge tone={badgeToneForVerification(effective)} size="sm">
          {effective.replace("_", " ")}
        </Badge>
        {row.capacity ? (
          <XStack gap="$1" alignItems="center" flexShrink={0}>
            <Users size={12} style={{ opacity: 0.5 }} />
            <Text variant="caption" tone="muted">
              {row.capacity.toLocaleString()}
            </Text>
          </XStack>
        ) : null}
      </XStack>
    </YStack>
  );
}
