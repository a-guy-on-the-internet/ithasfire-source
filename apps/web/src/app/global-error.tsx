"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

/**
 * Global error boundary — replaces the *entire* page (including RootLayout)
 * when an unhandled render error propagates to the root.
 *
 * ## Intentionally self-contained — do NOT tokenize this file
 *
 * The layout is gone, so this renders without Tamagui, without globals.css and
 * without `ActiveThemeInjector`. No `$token`, no `var(--x)` and no theme hook
 * can be relied on here: `var(--accent, …)` would silently collapse to its
 * fallback at best, and a theme-dependent color could paint invisible at worst.
 * Every value below is therefore a hardcoded literal, and that is correct —
 * this page has to survive a crash of everything around it.
 *
 * The literals mirror the **Stub** (warm paper) theme, which is the shipped
 * default: cream #F6F0E4 page, ink #211C16 text, #5C544A muted, accent family
 * for the one primary action. If the Stub palette ever moves, hand-sync it here
 * (see `packages/ui/src/ui/tamagui/tokens/colors.ts`).
 */
export default function GlobalError(
  props: Readonly<{
    error: Error & { digest?: string };
    reset: () => void;
  }>,
) {
  const { error, reset } = props;

  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily:
            "Montserrat, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
          background: "#F6F0E4",
          color: "#211C16",
        }}
      >
        <main
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 24,
            padding: "32px 24px",
            textAlign: "center",
            maxWidth: 480,
          }}
        >
          {/* Alert icon — inline SVG so it works without external deps */}
          <div
            style={{
              width: 80,
              height: 80,
              borderRadius: 0,
              background: "rgba(33,28,22,0.05)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width={32}
              height={32}
              viewBox="0 0 24 24"
              fill="none"
              stroke="rgba(33,28,22,0.25)"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {/* Lucide "alert-triangle" */}
              <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <h1
              style={{
                margin: 0,
                fontSize: 28,
                fontWeight: 700,
                letterSpacing: "-0.01em",
              }}
            >
              Something went wrong
            </h1>
            <p
              style={{
                margin: 0,
                maxWidth: 360,
                fontSize: 16,
                lineHeight: 1.6,
                color: "#5C544A",
              }}
            >
              An unexpected error occurred. You can try again or head back to
              the home page.
            </p>
          </div>

          {/* Error digest — helps support requests without leaking details */}
          {error.digest && (
            <p
              style={{
                margin: 0,
                fontSize: 12,
                // Muted ink, not a fainter tint: support asks users to read this
                // reference aloud, and ink at the old 0.3 alpha lands ~2:1 on
                // cream. The 12px size + muted color separate it from body copy
                // (Montserrat is the only brand font — no mono here).
                color: "#5C544A",
                letterSpacing: "0.02em",
              }}
            >
              Error reference: {error.digest}
            </p>
          )}

          <div
            style={{
              display: "flex",
              gap: 16,
              marginTop: 8,
              flexWrap: "wrap",
              justifyContent: "center",
            }}
          >
            <button
              onClick={() => reset()}
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "12px 28px",
                fontSize: 15,
                fontWeight: 700,
                fontFamily: "inherit",
                // White on the #B93312 accent fill, NOT on #E2481D: at 15px the
                // label needs 4.5:1, and white on #E2481D is only ~4.1:1. The
                // darker fill reaches ~5.9:1 (design-system-v2 "Divergences").
                color: "#FFFFFF",
                background: "#B93312",
                border: "none",
                borderRadius: 0,
                cursor: "pointer",
                transition: "opacity 0.15s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.opacity = "0.9";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.opacity = "1";
              }}
            >
              Try again
            </button>
            <a
              href="/"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "12px 28px",
                fontSize: 15,
                fontWeight: 700,
                fontFamily: "inherit",
                color: "#211C16",
                background: "transparent",
                border: "1px solid rgba(33,28,22,0.3)",
                borderRadius: 0,
                cursor: "pointer",
                textDecoration: "none",
                transition: "background 0.15s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "rgba(33,28,22,0.04)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
              }}
            >
              Go home
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
