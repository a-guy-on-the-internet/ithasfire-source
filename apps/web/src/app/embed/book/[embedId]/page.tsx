"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { Spinner } from "@th/ui";

import { trpc } from "@/trpc";
import { getEmbedHostOrigin } from "@/lib/embed-host-origin";
import { DEFAULT_SUPPORT_EMAIL } from "@/app/embed/[embedId]/_components/embed-helpers";
import { EmbedErrorScreen } from "@/app/embed/[embedId]/_components/EmbedErrorScreen";
import { useEmbedBridge } from "@/app/embed/[embedId]/_components/useEmbedBridge";
import { useEmbedThemeOverrides } from "@/app/embed/[embedId]/_components/useEmbedThemeOverrides";
import {
  BORDER,
  TEXT,
  TEXT_CAPTION,
  TEXT_MUTED,
  embedThemeBridgeStyle,
  sectionLabelStyle,
} from "@/app/embed/[embedId]/_components/embed-theme";

import { AnonymousBookingForm } from "./_components/AnonymousBookingForm";
import {
  BookingNotAcceptingScreen,
  BookingSuccessScreen,
  type BookingSuccessState,
} from "./_components/BookingWidgetScreens";
import { LoginAffordance } from "./_components/LoginAffordance";
import { SignedInBookingPanel } from "./_components/SignedInBookingPanel";
import { useEmbedAuthHandoff } from "./_components/useEmbedAuthHandoff";

/**
 * "Request to book" embed widget iframe
 * (spec 2026-07-13 booking-request-embed-button FR-002/FR-010/FR-011).
 *
 * Anonymous-first: name + email + pitch via the public
 * `embeds.createBookingInquiry`. Signed-in is a progressive enhancement — a
 * popup handoff mints a bearer JWT (held in memory only) and the form
 * switches to sender-picker mode over `bookingRequests.create`.
 */
export default function EmbedBookingWidgetPage() {
  // Apply URL-based theme overrides (same brandColor/bg/fontColor/accentColor
  // query params as the ticket widget) and bridge them onto the platform
  // tokens the page's wells and shared pieces paint with — the same bridge
  // the ticket widget applies at its screen root.
  const themeOverrides = useEmbedThemeOverrides();
  return (
    <div style={embedThemeBridgeStyle(themeOverrides)}>
      <EmbedBookingWidget />
    </div>
  );
}

function EmbedBookingWidget() {
  const { embedId } = useParams<{ embedId: string }>();

  const [success, setSuccess] = useState<BookingSuccessState | null>(null);

  // hf:ready + hf:resize so the SDK's inline/modal iframe sizes correctly.
  // The bridge's Screen vocabulary is the ticket widget's — map the booking
  // flow onto it (form → "grid", sent → "confirmation").
  useEmbedBridge(embedId, success ? "confirmation" : "grid");

  const auth = useEmbedAuthHandoff();

  const { data, isLoading, error, refetch } =
    trpc.embeds.getBookingWidget.useQuery(
      { embedId, hostOrigin: getEmbedHostOrigin() },
      {
        staleTime: 60_000,
        // An origin-allowlist rejection is deterministic — retrying can't
        // succeed, so don't burn two extra round-trips on FORBIDDEN.
        retry: (failureCount, err) =>
          err.data?.code !== "FORBIDDEN" && failureCount < 2,
        retryDelay: 1500,
        // Failures render the calm branded EmbedErrorScreen below — opt out
        // of the global error toast (GlobalQueryErrorLogger keys off
        // meta.silent) so it can't stack on top of it inside the iframe.
        meta: { silent: true },
      },
    );

  const { data: platformSettings } =
    trpc.embeds.getPlatformPublicSettings.useQuery(undefined, {
      staleTime: 300_000,
      retry: 1,
    });
  const supportEmail = platformSettings?.supportEmail ?? DEFAULT_SUPPORT_EMAIL;

  // ── Loading ─────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div
        className="th-embed-fade-in"
        style={{
          display: "flex",
          minHeight: 200,
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
        }}
      >
        <Spinner size="md" indicatorColor={TEXT_CAPTION} />
      </div>
    );
  }

  // ── Error (incl. blocked origin — EmbedErrorScreen maps FORBIDDEN) ──
  if (error || !data) {
    return (
      <EmbedErrorScreen
        error={error}
        onRetry={() => {
          void refetch();
        }}
        supportEmail={supportEmail}
      />
    );
  }

  const { place } = data;

  // ── Calm not-accepting state (NOT an error) ─────────────────────────
  if (!data.accepting) {
    return <BookingNotAcceptingScreen placeName={place.name} />;
  }

  // ── Success ─────────────────────────────────────────────────────────
  if (success) {
    return <BookingSuccessScreen placeName={place.name} success={success} />;
  }

  const locality = [place.city, place.region].filter(Boolean).join(", ");

  // ── Form ────────────────────────────────────────────────────────────
  return (
    <div
      className="th-embed-fade-in"
      style={{ display: "flex", flexDirection: "column" }}
    >
      <header
        style={{
          borderBottom: `2px solid ${BORDER}`,
          padding: "16px 20px",
          display: "flex",
          flexDirection: "column",
          gap: 4,
        }}
      >
        <p style={sectionLabelStyle}>Booking request</p>
        <h1
          style={{
            margin: 0,
            fontSize: 20,
            fontWeight: 800,
            lineHeight: 1.25,
            color: TEXT,
          }}
        >
          {place.name}
        </h1>
        {locality && (
          <p style={{ margin: 0, fontSize: 12, color: TEXT_MUTED }}>
            {locality}
          </p>
        )}
      </header>

      <div
        style={{
          padding: 20,
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        {auth.token ? (
          <SignedInBookingPanel
            // Keyed on the login COUNTER (not the raw JWT — keeps the token
            // out of React DevTools) so each fresh login remounts the panel.
            key={auth.loginCount}
            placeId={place.id}
            token={auth.token}
            onSuccess={() => setSuccess({ mode: "signedIn" })}
            onSessionExpired={auth.markSessionExpired}
            onLogout={auth.logout}
          />
        ) : (
          <>
            <LoginAffordance auth={auth} />
            <AnonymousBookingForm
              embedId={embedId}
              onSuccess={(email) => setSuccess({ mode: "anonymous", email })}
            />
          </>
        )}
      </div>
    </div>
  );
}
