"use client";

import {
  BORDER,
  DANGER,
  TEXT_MUTED,
  STEEL_BLUE,
} from "@/app/embed/[embedId]/_components/embed-theme";

import type { EmbedAuthHandoff } from "./useEmbedAuthHandoff";

const quietButtonStyle: React.CSSProperties = {
  border: `2px solid ${STEEL_BLUE}`,
  borderRadius: 0,
  background: "transparent",
  padding: "6px 14px",
  // Mobile tap-target floor.
  minHeight: 44,
  fontSize: 11,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: STEEL_BLUE,
  cursor: "pointer",
  fontFamily: "inherit",
  whiteSpace: "nowrap",
};

/**
 * Quiet signed-out affordance above the anonymous form (FR-010): chrome-style,
 * not shouting. Opens the first-party popup handoff; handles blocked popups,
 * the waiting state (with cancel), and the session-expired note.
 */
export function LoginAffordance({ auth }: { auth: EmbedAuthHandoff }) {
  const waiting = auth.status === "waiting";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        borderBottom: `1px solid ${BORDER}`,
        paddingBottom: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontSize: 12, color: TEXT_MUTED }}>
          {waiting
            ? "Finish signing in using the popup window."
            : "Booked with Ithas Fire before?"}
        </span>
        {waiting ? (
          <button type="button" onClick={auth.cancelLogin} style={quietButtonStyle}>
            Cancel
          </button>
        ) : (
          <button type="button" onClick={auth.login} style={quietButtonStyle}>
            Log in
          </button>
        )}
      </div>
      {auth.sessionExpired && !waiting && (
        <p
          role="status"
          style={{ margin: 0, fontSize: 11, lineHeight: 1.5, color: TEXT_MUTED }}
        >
          Your session expired — log in again to continue where you left off.
        </p>
      )}
      {auth.timedOut && !waiting && (
        <p
          role="status"
          style={{ margin: 0, fontSize: 11, lineHeight: 1.5, color: TEXT_MUTED }}
        >
          Sign-in timed out — try again.
        </p>
      )}
      {auth.popupBlocked && (
        <p role="alert" style={{ margin: 0, fontSize: 11, lineHeight: 1.5, color: DANGER }}>
          Your browser blocked the sign-in popup. Allow popups for this site
          and try again.
        </p>
      )}
    </div>
  );
}
