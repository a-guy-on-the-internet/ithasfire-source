"use client";

import { CalendarOff, CheckCircle } from "lucide-react";

import {
  BORDER,
  SUCCESS,
  SURFACE_MUTED,
  TEXT,
  TEXT_CAPTION,
  TEXT_MUTED,
} from "@/app/embed/[embedId]/_components/embed-theme";

// ─────────────────────────────────────────────────────────────────────────────
// Shared centered-screen scaffold (mirrors EmbedErrorScreen's layout)
// ─────────────────────────────────────────────────────────────────────────────

function CenteredScreen({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: React.ReactNode;
}) {
  return (
    <div
      className="th-embed-fade-in"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        minHeight: 320,
        padding: "40px 24px",
        textAlign: "center",
      }}
    >
      <div
        style={{
          display: "flex",
          height: 56,
          width: 56,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 0,
          background: SURFACE_MUTED,
          border: `2px solid ${BORDER}`,
        }}
      >
        {icon}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <h2
          style={{
            margin: 0,
            fontSize: 15,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            color: TEXT,
          }}
        >
          {title}
        </h2>
        <p
          style={{
            margin: 0,
            maxWidth: 340,
            fontSize: 14,
            lineHeight: 1.6,
            color: TEXT_MUTED,
          }}
        >
          {body}
        </p>
      </div>
      <p
        style={{
          marginTop: 12,
          fontSize: 10,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: TEXT_CAPTION,
        }}
      >
        Powered by Ithas Fire
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Screens
// ─────────────────────────────────────────────────────────────────────────────

/** Calm not-accepting state (FR-002) — deliberately NOT an error. */
export function BookingNotAcceptingScreen({ placeName }: { placeName: string }) {
  return (
    <CenteredScreen
      icon={<CalendarOff size={28} style={{ color: TEXT_MUTED }} aria-hidden />}
      title="Not taking booking requests right now"
      body={`${placeName} isn't accepting booking requests at the moment. Check back later.`}
    />
  );
}

export type BookingSuccessState =
  | { mode: "anonymous"; email: string }
  | { mode: "signedIn" };

/** Post-submit confirmation — calm copy, no dark patterns. */
export function BookingSuccessScreen({
  placeName,
  success,
}: {
  placeName: string;
  success: BookingSuccessState;
}) {
  return (
    <CenteredScreen
      icon={<CheckCircle size={28} style={{ color: SUCCESS }} aria-hidden />}
      title="Request sent"
      body={
        success.mode === "anonymous" ? (
          <>
            {placeName} has your request and will reply to{" "}
            <strong style={{ color: TEXT }}>{success.email}</strong>.
          </>
        ) : (
          <>
            {placeName} has your request. You can follow replies from your
            Ithas Fire account.
          </>
        )
      }
    />
  );
}
