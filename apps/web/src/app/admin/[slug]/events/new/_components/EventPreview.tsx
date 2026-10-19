"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { styled, useTheme, XStack, YStack } from "tamagui";
import {
  Monitor,
  Smartphone,
  Mail,
  Compass,
  Calendar,
  Ticket,
  User,
} from "lucide-react";

import { Text, Spinner, useTranslations } from "@th/ui";
import type { ProseMirrorDoc } from "@th/schema";
import { proseMirrorDocToHtml, type AudioUrlMapEntry } from "./prose-editor";

import { trpc } from "@/trpc";
import {
  EventContent,
  type EventContentLocationCoords,
} from "@/components/events/EventContent";
import { composeEventAddress } from "@/lib/location/compose-address";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type PreviewViewport = "desktop" | "mobile" | "email";

export type EventPreviewProps = {
  title: string;
  startsAt?: string;
  endsAt?: string;
  location?: string;
  heroImageUrl?: string;
  bodyContent: ProseMirrorDoc;
  imageUrlMap?: Record<string, string>;
  /** Audio URL resolution map keyed by audioUploadId. */
  audioUrlMap?: Record<string, AudioUrlMapEntry>;
  /** When provided, ticket types and lineup are fetched via tRPC. */
  eventId?: string;
  /** Location coordinates for the map preview. */
  locationCoords?: EventContentLocationCoords;
  /** ISO 4217 currency code for formatting prices (defaults to "USD"). */
  currency?: string;
  /** Full street address (shown in email preview). */
  addressText?: string;
  /**
   * The structured half of the location, mirroring what the public page reads
   * off `Event` (`locality` / `region` / `postalCode` / `countryCode`) and the
   * linked Place's display name.
   *
   * ── WHY THE PREVIEW NEEDS THEM ──────────────────────────────────────────
   * The COMMUNITY head prints WHERE as a short recognition line and the fact
   * rail prints the full street address. This preview fed BOTH from the single
   * `location` string, and quick-create geocodes one string into `addressText`
   * AND the location label — so on a quick-created listing the two printed
   * byte-identical text ("Springwater, 115 27th Avenue North, Nashville, TN
   * 37203, United States of America", twice), which is the exact duplication
   * the community head was built to remove. MEASURED in `?view=preview`.
   *
   * With the parts, the preview derives the same two values the public page
   * does: a short `locality, region` label for the head and
   * `composeEventAddress(...)` for the rail.
   */
  venueName?: string;
  locality?: string;
  region?: string;
  postalCode?: string;
  countryCode?: string;
  /** IANA timezone (e.g. "America/Los_Angeles") for email date formatting. */
  timezone?: string;
  /** Organizer / presenter name shown in the email header. */
  organizerName?: string;
  /**
   * Render the COMMUNITY listing layout (stub head, WHERE / ENDS / LISTED BY
   * fact rail, sticky two-track) instead of the ticketed one — the same flag
   * the real public page sets for an ownerless RSVP listing.
   *
   * It also switches OFF the TICKET-TYPE read, which is owner-gated and
   * answers `NOT_RESOURCE_OWNER` for an ownerless row — and has nothing to say
   * about a listing anyway, which sells nothing.
   *
   * The lineup and tag reads are NOT switched off any more (2026-09-15):
   * `eventHumans.list` and `tags.getEventTags` were opened to community
   * moderators, the community layout renders both, and a preview that hides
   * what the page will show is the thing this component exists to prevent.
   */
  communityLayout?: boolean;
  /**
   * Stewardship is not known yet — the builder's `getEventForEdit` is still in
   * flight. EVERY read in here parks until it resolves.
   *
   * Without this, `communityLayout` is `false` for one render (a boolean
   * standing in for a tri-state), the preview mounts in its ticketed shape and
   * fires the owner-gated ticket-type read at a row that is about to turn out
   * ownerless. MEASURED: one `listTicketTypesForEdit` FORBIDDEN per community
   * preview load, from a gate written to prevent exactly that.
   */
  stewardshipPending?: boolean;
};

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const EMAIL_WIDTH = 600;

// ─────────────────────────────────────────────────────────────────────────────
// Styled Components
// ─────────────────────────────────────────────────────────────────────────────

const PreviewWrapper = styled(YStack, {
  width: "100%",
  backgroundColor: "$background",
  minHeight: "calc(100vh - 120px)",
});

const ViewportSelector = styled(XStack, {
  justifyContent: "center",
  padding: 16,
  gap: 8,
  backgroundColor: "$surface",
  borderBottomWidth: 1,
  borderBottomColor: "$borderColor",
});

const ViewportButton = styled(XStack, {
  paddingVertical: 8,
  paddingHorizontal: 16,
  gap: 8,
  alignItems: "center",
  borderRadius: 0,
  cursor: "pointer",
  borderWidth: 1,
  borderColor: "transparent",
  hoverStyle: {
    backgroundColor: "$surfaceMuted",
  },
  variants: {
    active: {
      true: {
        backgroundColor: "$backgroundInverted",
        hoverStyle: {
          backgroundColor: "$backgroundInverted",
        },
      },
    },
  },
});

const MobileDeviceFrame = styled(YStack, {
  marginHorizontal: "auto",
  marginVertical: 32,
  backgroundColor: "$backgroundInverted",
  borderRadius: 0,
  padding: 12,
  paddingTop: 24,
  paddingBottom: 24,
});

const MobileNotch = styled(XStack, {
  width: 100,
  height: 24,
  backgroundColor: "$backgroundInverted",
  borderRadius: 0,
  marginHorizontal: "auto",
  marginBottom: 8,
});

const MobileScreen = styled(YStack, {
  backgroundColor: "$surface",
  borderRadius: 0,
  overflow: "hidden",
});

/** Inner scroll area for mobile preview — keeps the nav bar pinned at the bottom. */
const MobileScrollArea = styled(YStack, {
  flex: 1,
  minHeight: 0,
});

const EmailFrame = styled(YStack, {
  marginHorizontal: "auto",
  marginVertical: 32,
  backgroundColor: "$surface",
  borderWidth: 1,
  borderColor: "$borderColor",
  overflow: "hidden",
});

// ─────────────────────────────────────────────────────────────────────────────
// Static blurred hero backdrop for preview frames
// ─────────────────────────────────────────────────────────────────────────────

function PreviewBackdrop({ imageUrl }: { imageUrl?: string | null }) {
  if (!imageUrl) return null;
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 0,
        overflow: "hidden",
        pointerEvents: "none",
      }}
    >
      {/* Blurred hero image */}
      <div
        style={{
          position: "absolute",
          top: -60,
          left: -60,
          right: -60,
          bottom: "40%",
          backgroundImage: `url(${imageUrl})`,
          backgroundSize: "cover",
          backgroundPosition: "center",
          filter: "blur(44px) saturate(1.4)",
          opacity: 0.55,
        }}
      />
      {/* Gradient overlay: darken top + fade into surface at bottom */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "linear-gradient(to bottom, rgba(0,0,0,0.35) 0%, transparent 30%, var(--background, #F6F0E4) 60%)",
        }}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function EventPreview({
  title,
  startsAt,
  endsAt,
  location,
  heroImageUrl,
  bodyContent,
  imageUrlMap = {},
  audioUrlMap = {},
  eventId,
  locationCoords,
  currency,
  addressText,
  venueName,
  locality,
  region,
  postalCode,
  countryCode,
  timezone,
  organizerName,
  communityLayout = false,
  stewardshipPending = false,
}: EventPreviewProps) {
  const [viewport, setViewport] = useState<PreviewViewport>("desktop");
  const theme = useTheme();
  const t = useTranslations();

  // Nothing is asked until stewardship is known (see `stewardshipPending`).
  const readsReady = !!eventId && !stewardshipPending;
  // Owner-gated — see `communityLayout` for why it is off for an ownerless row.
  const ownerReadsEnabled = readsReady && !communityLayout;

  // Fetch ticket types when eventId is available (edit mode)
  const ticketTypesQuery = trpc.events.listTicketTypesForEdit.useQuery(
    { eventId: eventId! },
    { enabled: ownerReadsEnabled },
  );

  // Fetch event humans (lineup) when eventId is available. Admits a community
  // moderator, and the community layout renders a lineup, so it is NOT gated
  // on stewardship — only on knowing it.
  const eventHumansQuery = trpc.eventHumans.list.useQuery(
    { eventId: eventId! },
    { enabled: readsReady },
  );

  // Fetch event tags when eventId is available (same reasoning as the lineup).
  const eventTagsQuery = trpc.tags.getEventTags.useQuery(
    { eventId: eventId! },
    { enabled: readsReady },
  );

  // Platform footer defaults (mailing address / contact / brand) so the email
  // preview renders the exact CAN-SPAM footer recipients will receive.
  const footerDefaultsQuery = trpc.platform.getFooterDefaults.useQuery(
    undefined,
    { staleTime: 5 * 60_000 },
  );
  const footerDefaults = footerDefaultsQuery.data;

  const ticketTypes = ticketTypesQuery.data?.ticketTypes ?? [];
  const eventHumans = eventHumansQuery.data ?? [];

  const bodyHtml =
    proseMirrorDocToHtml(bodyContent, imageUrlMap, audioUrlMap) || "";
  const isMobile = viewport === "mobile";

  // ── Real email preview via @th/ui-email server render ──────────────────
  const [emailHtml, setEmailHtml] = useState<string | null>(null);
  const [emailLoading, setEmailLoading] = useState(false);
  const emailIframeRef = useRef<HTMLIFrameElement>(null);

  const fetchEmailPreview = useCallback(async () => {
    setEmailLoading(true);
    try {
      const res = await fetch("/api/admin/email-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventTitle: title || "Untitled Event",
          startsAtISO: startsAt ?? new Date().toISOString(),
          endsAtISO: endsAt ?? undefined,
          descriptionDoc: bodyContent,
          venueName: location ?? undefined,
          addressText: addressText ?? undefined,
          timezone:
            timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
          organizerName: organizerName ?? undefined,
          heroImageUrl: heroImageUrl ?? undefined,
          eventUrl:
            typeof window !== "undefined"
              ? window.location.href
              : "https://ithasfire.com",
          footer: footerDefaults
            ? {
                physicalAddress: footerDefaults.physicalAddress ?? undefined,
                contactEmail: footerDefaults.contactEmail ?? undefined,
                brandName: footerDefaults.brandName ?? undefined,
              }
            : undefined,
        }),
      });
      const data = await res.json();
      if (data.html) {
        setEmailHtml(data.html);
      }
    } catch (error) {
      // Non-fatal — the user will see the loading state clear; log so a
      // class-wide email render failure shows up in telemetry.
      console.error("[event-preview] render email preview failed", error);
      setEmailHtml(null);
    } finally {
      setEmailLoading(false);
    }
  }, [
    title,
    startsAt,
    endsAt,
    bodyContent,
    location,
    heroImageUrl,
    addressText,
    timezone,
    organizerName,
    footerDefaults,
  ]);

  // Fetch email preview when the email tab is selected or inputs change
  useEffect(() => {
    if (viewport === "email") {
      fetchEmailPreview();
    }
  }, [viewport, fetchEmailPreview]);

  // Write email HTML into the iframe to keep email styles sandboxed
  useEffect(() => {
    const iframe = emailIframeRef.current;
    if (!iframe || !emailHtml) return;
    const doc = iframe.contentDocument;
    if (!doc) return;
    doc.open();
    doc.write(emailHtml);
    doc.close();
  }, [emailHtml]);

  // Normalise event humans from the admin tRPC shape into EventContent's shape
  const normalisedHumans = eventHumans.map((eh) => ({
    id: eh.id,
    name: eh.externalName ?? "Unknown",
    role: eh.role,
    customRoleLabel: eh.customRoleLabel ?? null,
  }));

  // ── The COMMUNITY head / fact-rail split ────────────────────────────────
  //
  // Derived exactly the way `EventDetail` derives them for the live page, so
  // the preview predicts the page instead of inventing a third shape:
  //   head  → venue name + a short `locality, region` recognition label
  //   rail  → the full street address, deduped by `composeEventAddress`
  //
  // Scoped to the community layout on purpose. The ticketed preview's meta row
  // and Location section read the same two props, and widening this to them is
  // a separate (larger) change — see the follow-up note. Ticketed output is
  // byte-identical to before.
  const communityPlaceLabel = communityLayout
    ? [locality, region].filter(Boolean).join(", ") || undefined
    : undefined;
  const communityAddress = communityLayout
    ? composeEventAddress({
        addressText,
        locality,
        region,
        postalCode,
        countryCode,
      })
    : undefined;

  const renderContent = () => (
    <EventContent
      title={title}
      startsAt={startsAt}
      endsAt={endsAt}
      timezone={timezone}
      location={communityLayout ? communityPlaceLabel : location}
      address={communityAddress}
      venueName={communityLayout ? venueName : undefined}
      heroImageUrl={heroImageUrl}
      bodyHtml={bodyHtml}
      ticketTypes={ticketTypes}
      eventHumans={normalisedHumans}
      mobile={isMobile}
      currency={currency}
      locationCoords={locationCoords}
      tags={eventTagsQuery.data?.tags}
      communityLayout={communityLayout}
      isAdminPreview
    />
  );

  const renderEmailPreview = () => {
    if (emailLoading) {
      return (
        <YStack
          alignItems="center"
          justifyContent="center"
          padding={48}
          gap={12}
        >
          <Spinner size="md" indicatorColor={theme.colorMuted?.val} />
          <Text style={{ fontSize: 13 }} tone="muted">
            Rendering email template...
          </Text>
        </YStack>
      );
    }

    if (!emailHtml) {
      return (
        <YStack alignItems="center" justifyContent="center" padding={48}>
          <Text style={{ fontSize: 13 }} tone="muted">
            Email preview unavailable
          </Text>
        </YStack>
      );
    }

    return (
      <iframe
        ref={emailIframeRef}
        title="Email preview"
        style={{
          width: "100%",
          minHeight: 600,
          border: "none",
          display: "block",
        }}
      />
    );
  };

  return (
    <PreviewWrapper data-testid="event-preview">
      {/* Viewport Selector */}
      <ViewportSelector data-testid="preview-viewport-selector">
        <ViewportButton
          active={viewport === "desktop"}
          onPress={() => setViewport("desktop")}
          data-testid="preview-viewport-desktop"
        >
          <Monitor
            size={18}
            color={
              viewport === "desktop"
                ? theme.colorInverted?.val
                : theme.color?.val
            }
          />
          <Text
            style={{ fontSize: 14 }}
            color={viewport === "desktop" ? "$colorInverted" : "$color"}
          >
            {String(t("admin.epDesktop"))}
          </Text>
        </ViewportButton>
        <ViewportButton
          active={viewport === "mobile"}
          onPress={() => setViewport("mobile")}
          data-testid="preview-viewport-mobile"
        >
          <Smartphone
            size={18}
            color={
              viewport === "mobile"
                ? theme.colorInverted?.val
                : theme.color?.val
            }
          />
          <Text
            style={{ fontSize: 14 }}
            color={viewport === "mobile" ? "$colorInverted" : "$color"}
          >
            {String(t("admin.epMobile"))}
          </Text>
        </ViewportButton>
        <ViewportButton
          active={viewport === "email"}
          onPress={() => setViewport("email")}
          data-testid="preview-viewport-email"
        >
          <Mail
            size={18}
            color={
              viewport === "email" ? theme.colorInverted?.val : theme.color?.val
            }
          />
          <Text
            style={{ fontSize: 14 }}
            color={viewport === "email" ? "$colorInverted" : "$color"}
          >
            {String(t("admin.epEmail"))}
          </Text>
        </ViewportButton>
      </ViewportSelector>

      {/* Device Frames */}
      {viewport === "desktop" && (
        <YStack
          data-testid="preview-frame-desktop"
          maxWidth={768}
          width="100%"
          marginHorizontal="auto"
          paddingVertical={32}
          style={{ position: "relative" }}
        >
          <PreviewBackdrop imageUrl={heroImageUrl} />
          <YStack style={{ position: "relative", zIndex: 1 }}>
            {renderContent()}
          </YStack>
        </YStack>
      )}

      {viewport === "mobile" && (
        <MobileDeviceFrame
          data-testid="preview-frame-mobile"
          style={{ width: 395 }}
        >
          <MobileNotch />
          <MobileScreen
            style={{ width: 371, height: 700, position: "relative" }}
          >
            {/* Scrollable content area — the sticky CTA anchors to the bottom of this container */}
            <MobileScrollArea style={{ overflowY: "auto" }}>
              <PreviewBackdrop imageUrl={heroImageUrl} />
              <YStack
                flex={1}
                minHeight={0}
                style={{ position: "relative", zIndex: 1 }}
              >
                {renderContent()}
              </YStack>
            </MobileScrollArea>
            {/* Static mobile nav bar (preview only) — sits below the scroll area */}
            <XStack
              justifyContent="space-around"
              alignItems="center"
              paddingVertical={6}
              paddingBottom={8}
              borderTopWidth={1}
              borderTopColor="$borderColor"
              backgroundColor="$surface"
              style={{ flexShrink: 0 }}
            >
              {(
                [
                  { icon: Compass, label: t("common.navExplore") },
                  { icon: Calendar, label: t("common.navEvents") },
                  { icon: Ticket, label: t("common.navTickets") },
                  { icon: User, label: t("common.navAccount") },
                ] as const
              ).map(({ icon: Icon, label }, i) => (
                <YStack key={i} alignItems="center" gap={2} flex={1}>
                  <Icon
                    size={20}
                    strokeWidth={1.6}
                    color={theme.colorMuted?.val}
                  />
                  <Text
                    style={{ fontSize: 10, lineHeight: 14 }}
                    tone="muted"
                  >
                    {String(label)}
                  </Text>
                </YStack>
              ))}
            </XStack>
          </MobileScreen>
        </MobileDeviceFrame>
      )}

      {viewport === "email" && (
        <EmailFrame
          data-testid="preview-frame-email"
          style={{ width: EMAIL_WIDTH, maxWidth: "calc(100% - 32px)" }}
        >
          {renderEmailPreview()}
        </EmailFrame>
      )}
    </PreviewWrapper>
  );
}

export default EventPreview;
