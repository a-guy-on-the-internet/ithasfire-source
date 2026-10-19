"use client";

import { AlertTriangle, RefreshCw, ShieldCheck, WifiOff } from "lucide-react";

import { EMBED_ORIGIN_BLOCKED_MESSAGE } from "@/lib/embed-host-origin";
import {
  STEEL_BLUE,
  TEXT,
  TEXT_MUTED,
  TEXT_CAPTION,
  SURFACE_MUTED,
  BORDER,
  WARNING,
  secondaryButtonStyle,
} from "./embed-theme";
import { useIsFramed } from "./useIsFramed";

export function EmbedErrorScreen({
  error,
  onRetry,
  supportEmail,
}: {
  error: unknown;
  onRetry: () => void;
  supportEmail: string;
}) {
  // Inside a frame 100dvh IS the iframe's height, so a viewport-unit minHeight
  // feeds the resize bridge back into itself. Framed: fixed floor. Unframed
  // (embed URL opened directly): full viewport. useIsFramed is false on the
  // server and during hydration, then re-renders, so there is no mismatch.
  const framed = useIsFramed();
  const trpcError = error as {
    data?: { code?: string };
    message?: string;
  } | null;
  const code = trpcError?.data?.code;

  const isNotFound = code === "NOT_FOUND";
  const isForbidden = code === "FORBIDDEN" || code === "UNAUTHORIZED";
  const isNetwork =
    !code && trpcError?.message?.toLowerCase().includes("fetch");

  // The warning amber is picked for the platform's light ground; on a host
  // text colour's (dark) ground it measured 1.6:1, so the glyph follows the
  // host text there. The title beside it carries the meaning either way.
  let icon = (
    <AlertTriangle size={28} style={{ color: `var(--hf-text, ${WARNING})` }} />
  );
  let title = "Something went wrong";
  let description =
    "We couldn't load this content right now. This might be a temporary issue.";

  if (isNotFound) {
    title = "Widget not found";
    description =
      "This embed doesn't exist or may have been removed by the organizer.";
  } else if (isForbidden) {
    icon = <ShieldCheck size={28} style={{ color: STEEL_BLUE }} />;
    title = "Access restricted";
    description = EMBED_ORIGIN_BLOCKED_MESSAGE;
  } else if (isNetwork) {
    icon = <WifiOff size={28} style={{ color: TEXT_MUTED }} />;
    title = "Connection issue";
    description =
      "We couldn't reach the server. Check your internet connection and try again.";
  }

  return (
    <div
      className="th-embed-fade-in"
      style={{
        display: "flex",
        minHeight: framed ? 320 : "100dvh",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
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
        <h3
          style={{
            fontSize: 15,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            color: TEXT,
          }}
        >
          {title}
        </h3>
        <p
          style={{
            maxWidth: 320,
            fontSize: 14,
            lineHeight: 1.6,
            color: TEXT_MUTED,
          }}
        >
          {description}
        </p>
      </div>

      {!isNotFound && (
        <button
          type="button"
          onClick={onRetry}
          style={{
            ...secondaryButtonStyle,
            marginTop: 4,
          }}
        >
          <RefreshCw size={14} />
          Try again
        </button>
      )}

      <p
        style={{
          marginTop: 16,
          maxWidth: 300,
          fontSize: 11,
          lineHeight: 1.6,
          color: TEXT_CAPTION,
        }}
      >
        Go yell at us for breaking your ticketing experience at{" "}
        <a
          href={`mailto:${supportEmail}`}
          style={{
            fontWeight: 700,
            color: STEEL_BLUE,
            textDecoration: "underline",
            textUnderlineOffset: 2,
          }}
        >
          {supportEmail}
        </a>
      </p>

      <p
        style={{
          marginTop: 4,
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
