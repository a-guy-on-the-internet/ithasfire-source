"use client";

import {
  DANGER,
  DANGER_BG,
} from "@/app/embed/[embedId]/_components/embed-theme";

/** Inline submit-error banner — Swiss flat, thick border, no card nesting. */
export function SubmitErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div
      role="alert"
      style={{
        border: `2px solid ${DANGER}`,
        background: DANGER_BG,
        padding: "10px 12px",
      }}
    >
      <p
        style={{
          margin: 0,
          fontSize: 13,
          fontWeight: 600,
          lineHeight: 1.5,
          color: DANGER,
        }}
      >
        {message}
      </p>
    </div>
  );
}
