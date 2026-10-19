"use client";

import { Fragment } from "react";
import { useRouter } from "@bprogress/next/app";
import { styled, XStack, YStack } from "tamagui";
import { Badge, Button, Spinner, Text, useTranslations } from "@th/ui";
import {
  Archive,
  Calendar,
  CalendarDays,
  ExternalLink,
  FileText,
  Globe,
  Grid3x3,
  MapPin,
  Pencil,
  Phone,
  RotateCcw,
  Send,
  ShieldCheck,
  Ticket,
  Users,
} from "lucide-react";
import type { PlaceVerificationEligibility } from "@th/core/use-cases/places";

import { trpc } from "@/trpc";
import {
  VERIFICATION_ICON_MAP,
  type EffectiveVerificationStatus,
  effectiveVerificationStatus,
} from "@/lib/verification-config";
import { getSafeExternalHref } from "@/app/p/[slug]/_components/blocks/safe-block-url";
import { badgeToneForVerification } from "./PlaceMobileCard";

const PanelContainer = styled(YStack, {
  padding: "$5",
  paddingTop: "$4",
  gap: "$4",
  backgroundColor: "$surfaceMuted",
  borderTopWidth: 2,
  borderTopColor: "$borderColor",
});

const SectionRow = styled(XStack, {
  gap: "$5",
  flexWrap: "wrap",
});

const SectionBlock = styled(YStack, {
  gap: "$3",
  flex: 1,
  minWidth: 220,
});

const SectionLabel = styled(Text, {
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: 1.5,
  fontWeight: "700",
  tag: "span",
});

const MetricBox = styled(XStack, {
  gap: "$3",
  alignItems: "center",
  padding: "$3",
  borderWidth: 2,
  borderColor: "$borderColor",
  borderRadius: 0,
  backgroundColor: "$surface",
  // Wrap instead of crushing at phone widths (SectionRow has flexWrap).
  minWidth: 140,
});

const MetricIconBox = styled(XStack, {
  width: 32,
  height: 32,
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 0,
  backgroundColor: "$surfaceMuted",
});

function formatRelative(date: Date | string | null | undefined): string {
  if (!date) return "—";
  const target = typeof date === "string" ? new Date(date) : date;
  const ms = Date.now() - target.getTime();
  const sec = Math.round(ms / 1000);
  const min = Math.round(sec / 60);
  const hr = Math.round(min / 60);
  const day = Math.round(hr / 24);
  const mo = Math.round(day / 30);
  if (Math.abs(sec) < 60) return "just now";
  if (Math.abs(min) < 60) return `${min}m ago`;
  if (Math.abs(hr) < 24) return `${hr}h ago`;
  if (Math.abs(day) < 30) return `${day}d ago`;
  if (Math.abs(mo) < 12) return `${mo}mo ago`;
  return target.toLocaleDateString();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function PlaceDetailPanel({
  placeId,
  slug,
  canEdit,
  canManage = true,
  seatingLayoutsEnabled = true,
  status,
  onToggleArchived,
  toggleArchivedPending,
  verificationEligibility,
  onRequestVerification,
}: {
  placeId: string;
  slug: string;
  /**
   * Whether the actor may edit this place (owns it AND has ORG_EDIT_ROLES).
   * Gates Edit / Layout / Page editor / Archive-Restore. Read navigations
   * (Calendar, View events, Public page) stay open regardless.
   */
  canEdit: boolean;
  /**
   * Whether the actor may change verification status (owns it AND has
   * ORG_ADMIN_ROLES — updatePlaceVerificationStatus). Narrower than canEdit so
   * an EDITOR does not see the request-verification action the server would
   * 403. Defaults to true (backward-safe). UX-only; server is the boundary.
   */
  canManage?: boolean;
  /**
   * Whether the seating-layouts feature gate is on. Mirrors the
   * `gates?.seatingLayouts` check that gates the Layout item in the table's
   * rowActions menu so the panel exposes the same set of actions. Defaults
   * to true for callers that do not gate layouts.
   */
  seatingLayoutsEnabled?: boolean;
  /**
   * Current place status from the list row. When provided together with
   * `onToggleArchived`, the panel renders an Archive/Restore action — the
   * only home for it on phones, where the table's rowActions menu is not
   * rendered in card mode.
   */
  status?: "ACTIVE" | "SUSPENDED" | "ARCHIVED";
  onToggleArchived?: () => void;
  toggleArchivedPending?: boolean;
  /**
   * Verification-request action for owned UNVERIFIED places. Callers pass
   * the result of `getPlaceVerificationEligibility` — used for the LABEL only,
   * not to disable (see the render site) — plus the same request callback the
   * rowActions menu uses, so the action stays reachable on phones, where the
   * rowActions menu is not rendered in card mode. Omit for places that are
   * not UNVERIFIED.
   */
  verificationEligibility?: PlaceVerificationEligibility;
  onRequestVerification?: () => void;
}) {
  const t = useTranslations();
  const router = useRouter();
  const detailQuery = trpc.places.getPlaceDetail.useQuery(
    { placeId },
    { staleTime: 60_000 },
  );

  if (detailQuery.isLoading) {
    return (
      <PanelContainer
        alignItems="center"
        justifyContent="center"
        minHeight={120}
      >
        <Spinner size="small" indicatorColor="$accent" />
      </PanelContainer>
    );
  }

  // A REFUSAL IS NOT A FAILED LOAD, and this panel used to call every error
  // "Could not load place details — please refresh." Refreshing is advice a
  // refused reader cannot act on; it will never work, and it hides the real
  // answer behind a suggestion of flakiness.
  //
  // Reachable, and not by a crafted request: `getPlaceDetail` now sits at
  // `canManagePlace` (OWNER/ADMIN/EDITOR, or a verified direct human owner)
  // because it returns the venue's street address, exact coordinates, phone
  // and ownership — while the places table this panel expands from is reached
  // by roles below that bar. They click the row and land here.
  if (detailQuery.error || !detailQuery.data) {
    const isForbidden = detailQuery.error?.data?.code === "FORBIDDEN";
    return (
      <PanelContainer>
        <Text variant="body" tone={isForbidden ? "muted" : "error"}>
          {isForbidden
            ? String(t("admin.placeEditAccessDeniedDescription"))
            : "Could not load place details — please refresh."}
        </Text>
      </PanelContainer>
    );
  }

  const detail = detailQuery.data;
  const { place, eventStats, verification, ownership } = detail;
  const effective = effectiveVerificationStatus(
    place.verificationStatus,
    verification.activeRequest?.status === "PENDING" ||
      verification.activeRequest?.status === "IN_REVIEW"
      ? verification.activeRequest.status
      : null,
  );
  const vIcon = VERIFICATION_ICON_MAP[effective];

  const fullAddress = [
    place.addressLine1,
    place.addressLine2,
    [place.city, place.region].filter(Boolean).join(", "),
    place.postalCode,
    place.countryCode,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <PanelContainer>
      {/* ── Metric tiles row ─────────────────────────────────────── */}
      <SectionRow>
        <MetricBox flex={1}>
          <MetricIconBox>
            <Ticket size={16} color="var(--accent)" />
          </MetricIconBox>
          <YStack gap={2}>
            <SectionLabel>Events</SectionLabel>
            <Text variant="body" style={{ fontSize: 18, fontWeight: 900 }}>
              {eventStats.total.toLocaleString()}
            </Text>
            <Text variant="caption" tone="muted">
              {eventStats.upcoming > 0
                ? `↑ ${eventStats.upcoming} upcoming`
                : "no upcoming"}
            </Text>
          </YStack>
        </MetricBox>

        <MetricBox flex={1}>
          <MetricIconBox>
            <Users size={16} color="var(--accent)" />
          </MetricIconBox>
          <YStack gap={2}>
            <SectionLabel>Capacity</SectionLabel>
            <Text variant="body" style={{ fontSize: 18, fontWeight: 900 }}>
              {place.capacity ? place.capacity.toLocaleString() : "—"}
            </Text>
          </YStack>
        </MetricBox>

        <MetricBox flex={1}>
          <MetricIconBox>
            <vIcon.Icon size={16} color={vIcon.color} />
          </MetricIconBox>
          <YStack gap={2}>
            <SectionLabel>Verification</SectionLabel>
            <Badge tone={badgeToneForVerification(effective)} size="sm">
              {effective}
            </Badge>
          </YStack>
        </MetricBox>

        <MetricBox flex={1}>
          <MetricIconBox>
            <ShieldCheck size={16} color="var(--accent)" />
          </MetricIconBox>
          <YStack gap={2}>
            <SectionLabel>Directory</SectionLabel>
            <Badge
              tone={place.listedInDirectory ? "success" : "neutral"}
              size="sm"
            >
              {place.listedInDirectory ? "LISTED" : "NOT LISTED"}
            </Badge>
          </YStack>
        </MetricBox>
      </SectionRow>

      {/* ── Contact / Location / Settings ─────────────────────────────────── */}
      <SectionRow>
        <SectionBlock>
          <SectionLabel>Contact</SectionLabel>
          {place.phone ? (
            <XStack gap="$2" alignItems="center">
              <Phone size={13} style={{ opacity: 0.6 }} />
              <Text variant="body">
                <a href={`tel:${place.phone}`}>{place.phone}</a>
              </Text>
            </XStack>
          ) : null}
          {place.website && getSafeExternalHref(place.website) ? (
            <XStack gap="$2" alignItems="center">
              <Globe size={13} style={{ opacity: 0.6 }} />
              <a
                href={getSafeExternalHref(place.website)}
                target="_blank"
                rel="noopener noreferrer"
                style={{ display: "flex", alignItems: "center", gap: 4 }}
              >
                <Text variant="body">{place.website}</Text>
                <ExternalLink size={12} />
              </a>
            </XStack>
          ) : null}
          {!place.phone && !place.website ? (
            <Text variant="caption" tone="muted">
              No contact details — add them in Settings
            </Text>
          ) : null}
        </SectionBlock>

        <SectionBlock>
          <SectionLabel>Location</SectionLabel>
          <XStack gap="$2" alignItems="flex-start">
            <MapPin size={13} style={{ opacity: 0.6, marginTop: 3 }} />
            <Text variant="body" style={{ flex: 1 }}>
              {fullAddress || "—"}
            </Text>
          </XStack>
          {place.lat !== null && place.lng !== null ? (
            <Text variant="caption" tone="muted">
              {place.lat.toFixed(4)}, {place.lng.toFixed(4)}
            </Text>
          ) : null}
        </SectionBlock>

        <SectionBlock>
          <SectionLabel>Settings</SectionLabel>
          {/* The venue's REAL public address. Showing `place.slug` here told
              the organizer their page lived at a URL that 404s — that slug is
              a directory key, not a route. Falls back to the id page, which is
              what an entity-page-less venue actually resolves on. */}
          <Text variant="caption" tone="muted">
            {place.pageSlug
              ? `/places/${place.pageSlug}`
              : `/places/id/${place.id}`}
          </Text>
          <Text variant="bodySmall">
            <strong>Primary payout:</strong>{" "}
            {place.defaultPrimaryPayoutTermsLabel ?? "Use group default"}
          </Text>
          <Text variant="bodySmall">
            <strong>Resale payout:</strong>{" "}
            {place.defaultResalePayoutTermsLabel ?? "Use group default"}
          </Text>
        </SectionBlock>
      </SectionRow>

      {/* ── Verification timeline ─────────────────────────────────────── */}
      {verification.history.length > 0 ? (
        <YStack gap="$3">
          <SectionLabel>Verification history</SectionLabel>
          <YStack gap="$3">
            {verification.history.map((req) => (
              <Fragment key={req.id}>
                <YStack
                  gap="$2"
                  padding="$3"
                  borderWidth={1}
                  borderColor="$borderColor"
                  backgroundColor="$surface"
                >
                  <XStack
                    gap="$2"
                    alignItems="center"
                    justifyContent="space-between"
                  >
                    <XStack gap="$2" alignItems="center">
                      <Badge
                        tone={badgeToneForVerification(
                          req.status as EffectiveVerificationStatus,
                        )}
                        size="sm"
                      >
                        {req.status}
                      </Badge>
                      <Text variant="caption" tone="muted">
                        {formatRelative(req.submittedAt)} ·{" "}
                        {req.submittedByName ?? "unknown submitter"}
                      </Text>
                    </XStack>
                    {req.reviewedAt ? (
                      <Text variant="caption" tone="muted">
                        reviewed {formatRelative(req.reviewedAt)}
                        {req.reviewerName ? ` by ${req.reviewerName}` : ""}
                      </Text>
                    ) : null}
                  </XStack>
                  {req.reviewerNotes ? (
                    <Text variant="bodySmall" style={{ opacity: 0.85 }}>
                      {req.reviewerNotes}
                    </Text>
                  ) : null}
                  {req.documents.length > 0 ? (
                    <XStack gap="$2" flexWrap="wrap">
                      {req.documents.map((doc) => (
                        <XStack
                          key={doc.id}
                          gap="$1"
                          alignItems="center"
                          paddingHorizontal="$2"
                          paddingVertical="$1"
                          borderWidth={1}
                          borderColor="$borderColor"
                          opacity={doc.deletedAt ? 0.4 : 1}
                        >
                          <FileText size={11} />
                          <Text variant="caption">
                            {doc.fileName} ({formatBytes(doc.sizeBytes)})
                          </Text>
                        </XStack>
                      ))}
                    </XStack>
                  ) : null}
                </YStack>
              </Fragment>
            ))}
          </YStack>
        </YStack>
      ) : null}

      {/* ── Action bar ─────────────────────────────────────────────────────
          The panel is the canonical action surface on phones (card mode
          renders no rowActions menu), so every button keeps a 44px minimum
          tap height while size="$2" preserves desktop visual weight. */}
      <XStack gap="$2" flexWrap="wrap">
        {canEdit ? (
          <Button
            size="$2"
            minHeight={44}
            variant="primary"
            onPress={() =>
              router.push(`/admin/${slug}/places/${place.id}/settings`)
            }
          >
            <Pencil size={14} />
            Edit
          </Button>
        ) : null}
        {seatingLayoutsEnabled ? (
          <Button
            size="$2"
            minHeight={44}
            variant="secondary"
            onPress={() =>
              router.push(`/admin/${slug}/places/${place.id}/layout`)
            }
          >
            <Grid3x3 size={14} />
            Layout
          </Button>
        ) : null}
        <Button
          size="$2"
          minHeight={44}
          variant="secondary"
          onPress={() =>
            router.push(`/admin/${slug}/places/${place.id}/calendar`)
          }
        >
          <CalendarDays size={14} />
          Calendar
        </Button>
        {canEdit ? (
          <Button
            size="$2"
            minHeight={44}
            variant="secondary"
            onPress={() =>
              router.push(`/admin/${slug}/places/${place.id}/page`)
            }
          >
            <FileText size={14} />
            {String(t("admin.placesPageEditorTooltip"))}
          </Button>
        ) : null}
        {/* `/p/[slug]` resolves on the venue's ENTITY PAGE slug and has no uuid
            fallback. Gating on `place.slug` (the multi-segment directory key)
            opened a guaranteed 404. Venues with no entity page still have a
            working `/places/id/{id}` page, so the action stays reachable. */}
        <Button
          size="$2"
          minHeight={44}
          variant="secondary"
          onPress={() =>
            window.open(
              // `/places/`, matching the caption above and every other link in
              // the product. The `/p/` twin renders the same page but
              // self-canonicalises separately, so naming one route everywhere
              // keeps the organizer, the sitemap and the link graph agreeing.
              place.pageSlug
                ? `/places/${place.pageSlug}`
                : `/places/id/${place.id}`,
              "_blank",
            )
          }
        >
          <ExternalLink size={14} />
          Public page
        </Button>
        <Button
          size="$2"
          minHeight={44}
          variant="secondary"
          onPress={() =>
            router.push(`/admin/${slug}/events?placeId=${place.id}`)
          }
        >
          <Calendar size={14} />
          View events
        </Button>
        {/* Deliberately NOT disabled when ineligible, matching the rowActions
            menu item (FR-013): both open the same modal, which lists every
            blocker in full. This panel is the ONLY place these actions surface
            below 600px (card mode renders no rowActions), so a dead control
            here is precisely the "disabled with no stated reason" dead end —
            on the narrowest surface, where it is hardest to recover from. The
            label still names the first blocker at a glance. */}
        {canManage && verificationEligibility && onRequestVerification ? (
          <Button
            size="$2"
            minHeight={44}
            variant="secondary"
            onPress={onRequestVerification}
          >
            <Send size={14} />
            {verificationEligibility.eligible
              ? String(t("admin.placesRequestVerification"))
              : String(
                  t("admin.placesNotReady", {
                    reason: verificationEligibility.reasons[0],
                  }),
                )}
          </Button>
        ) : null}
        {canEdit && status && onToggleArchived ? (
          status === "ARCHIVED" ? (
            <Button
              size="$2"
              minHeight={44}
              variant="secondary"
              disabled={toggleArchivedPending}
              onPress={onToggleArchived}
            >
              <RotateCcw size={14} />
              {String(t("admin.placesRestoreTooltip"))}
            </Button>
          ) : (
            <Button
              size="$2"
              minHeight={44}
              variant="destructive"
              disabled={toggleArchivedPending}
              onPress={onToggleArchived}
            >
              <Archive size={14} />
              {String(t("admin.placesArchiveTooltip"))}
            </Button>
          )
        ) : null}
      </XStack>

      {/* Ownership footer for staff */}
      {ownership.orgIds.length + ownership.humanIds.length > 0 ? (
        <Text variant="caption" tone="muted">
          Owned by {ownership.orgIds.length} org
          {ownership.orgIds.length === 1 ? "" : "s"} ·{" "}
          {ownership.humanIds.length} human
          {ownership.humanIds.length === 1 ? "" : "s"}
        </Text>
      ) : null}
    </PanelContainer>
  );
}
