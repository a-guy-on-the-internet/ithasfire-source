"use client";

import { useEffect, useMemo, useState } from "react";
import { Toaster, toast as sonnerToast, type ExternalToast } from "sonner";
import { useThemeName } from "tamagui";

import type {
  NotifyOptions,
  ToastDedupeStrategy,
  ToastPosition,
  ToastVariant,
} from "./types";

const SONNER_POSITION: Record<
  ToastPosition,
  | "top-left"
  | "top-right"
  | "top-center"
  | "bottom-left"
  | "bottom-right"
  | "bottom-center"
> = {
  "top-left": "top-left",
  "top-right": "top-right",
  "top-center": "top-center",
  "bottom-left": "bottom-left",
  "bottom-right": "bottom-right",
  "bottom-center": "bottom-center",
  // Sonner has no "middle-*" — collapse onto the closest edge.
  "middle-left": "top-left",
  "middle-center": "top-center",
  "middle-right": "top-right",
};

function hashId(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i += 1) {
    h = ((h << 5) + h) ^ input.charCodeAt(i);
  }
  return `th-${(h >>> 0).toString(36)}`;
}

function resolveId(
  opts: NotifyOptions,
  _dedupeStrategy: ToastDedupeStrategy,
): string {
  if (opts.id) return opts.id;
  // Always dedupe by content when caller didn't pin an id. Otherwise rapid
  // retries (e.g. mashing "Sign in") stack identical toasts.
  const variant = opts.variant ?? "info";
  return hashId(`${variant}|${opts.title ?? ""}|${opts.message ?? ""}`);
}

function buildSonnerOptions(opts: NotifyOptions, id: string): ExternalToast {
  const out: ExternalToast = { id };
  if (opts.message != null && opts.title) out.description = opts.message;
  if (opts.durationMs != null)
    out.duration =
      opts.durationMs === Infinity ? Number.POSITIVE_INFINITY : opts.durationMs;
  if (opts.action) {
    out.action = {
      label: opts.action.label,
      onClick: () => opts.action?.onPress(),
    };
  }
  if (opts.position) out.position = SONNER_POSITION[opts.position] ?? undefined;
  return out;
}

export function notifyWeb(
  opts: NotifyOptions,
  dedupeStrategy: ToastDedupeStrategy,
): string {
  const id = resolveId(opts, dedupeStrategy);
  const sonnerOpts = buildSonnerOptions(opts, id);
  const headline = opts.title ?? opts.message ?? "";
  const variant: ToastVariant = opts.variant ?? "info";

  switch (variant) {
    case "success":
      sonnerToast.success(headline, sonnerOpts);
      break;
    case "warning":
      sonnerToast.warning(headline, sonnerOpts);
      break;
    case "danger":
      sonnerToast.error(headline, sonnerOpts);
      break;
    case "info":
      sonnerToast.info(headline, sonnerOpts);
      break;
    case "neutral":
    default:
      sonnerToast(headline, sonnerOpts);
      break;
  }

  return id;
}

export function dismissWeb(id?: string): void {
  if (id) {
    sonnerToast.dismiss(id);
  } else {
    sonnerToast.dismiss();
  }
}

export function clearWeb(): void {
  sonnerToast.dismiss();
}

interface PromiseMessages<T> {
  loading: string;
  success: string | ((data: T) => string);
  error: string | ((err: unknown) => string);
}

export function promiseWeb<T>(
  promise: Promise<T> | (() => Promise<T>),
  messages: PromiseMessages<T>,
): Promise<T> {
  const p = typeof promise === "function" ? promise() : promise;
  sonnerToast.promise(p, messages);
  return p;
}

// ─── Swiss-style theming ─────────────────────────────────────────────────────
// Sonner ships its own CSS; we override a small set of CSS variables to bridge
// onto the Ithas Fire design tokens. Square corners (radius: 0), 2px borders,
// monospace timestamps elsewhere — toasts mirror that with hard edges, a
// 2px tone-coloured left rail, and uppercase semibold titles.

export const ITHASFIRE_TOAST_CSS = `
/* The doubled class is deliberate: Sonner's own
   [data-sonner-toaster][data-sonner-theme=dark|light] rules set these same
   --normal-* / --<type>-* vars at equal specificity (0,2,0), so a single
   .th-toaster would win only by stylesheet order. (0,3,0) wins outright. */
.th-toaster.th-toaster[data-sonner-toaster] {
	/* The surface/text/border vars come from <body>: SSR inlines the active
	   mode's theme keys there (themeCssVarsForMode) and ActiveThemeInjector
	   re-mirrors them on the client. --surfaceRaised has NO globals.css :root
	   fallback (only inside [data-auth-ink]), so its stub value rides inline
	   and a toast always paints. The ink/border fallbacks repeat the :root
	   mirror for consumers outside apps/web. */
	--normal-bg: var(--surfaceRaised, #EFE7D6);
	--normal-text: var(--color, #211C16);
	--normal-border: var(--borderColor, #211C16);
	--success-bg: var(--surfaceRaised, #EFE7D6);
	--success-text: var(--color, #211C16);
	--success-border: var(--success);
	--info-bg: var(--surfaceRaised, #EFE7D6);
	--info-text: var(--color, #211C16);
	--info-border: var(--info);
	--warning-bg: var(--surfaceRaised, #EFE7D6);
	--warning-text: var(--color, #211C16);
	--warning-border: var(--warning);
	--error-bg: var(--surfaceRaised, #EFE7D6);
	--error-text: var(--color, #211C16);
	--error-border: var(--danger);
	font-family: inherit;
}

.th-toaster [data-sonner-toast] {
	border-radius: 0 !important;
	border-width: 1px !important;
	border-left-width: 4px !important;
	box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35) !important;
	/* Right padding reserves the lane the close button sits in (8px inset +
	   28px hit area) so neither a long title nor a right-aligned [data-button]
	   action ever runs under it. */
	padding: 14px 44px 14px 16px !important;
	gap: 12px !important;
	align-items: flex-start !important;
}

.th-toaster [data-sonner-toast] [data-title] {
	font-weight: 700 !important;
	letter-spacing: 0.4px !important;
	text-transform: uppercase !important;
	font-size: 12px !important;
	line-height: 1.4 !important;
}

.th-toaster [data-sonner-toast] [data-description] {
	font-size: 13px !important;
	line-height: 1.5 !important;
	/* Sonner colours the description per ITS theme (#3f3f3f light, #e8e8e8
	   under [data-sonner-theme=dark]). Under the old theme="system" an OS in
	   dark mode painted #e8e8e8 on the cream stub surface (~1.1:1); the
	   theme now follows the app, and this pin keeps it safe regardless.
	   Inherit the toast's own ink (--normal-text; no richColors).
	   At 0.85 the blend stays AA: stub 9.1:1, ember (dark) 10.9:1. */
	color: inherit !important;
	opacity: 0.85 !important;
	margin-top: 4px !important;
}

.th-toaster [data-sonner-toast] [data-icon] {
	margin-top: 1px !important;
}

/* Close button. Sonner's default is a 20px CIRCLE pinned to the toast's top-LEFT
   corner and pushed OUTSIDE the frame (translate(-35%, -35%)), carrying its own
   near-white --gray4 border. On our cream surface that reads as a stray white box
   clipped by the toast's edge, with a 12px hairline glyph floating inside it.
   Everything positional is re-declared here rather than via sonner's
   --toast-close-button-* vars: those are defined on [data-sonner-toaster][dir=ltr]
   (same specificity as our selector), so they'd hinge on stylesheet order.
   Result: a square ghost affordance INSIDE the frame, top-right, in the toast's
   own ink — and a 16px/2px glyph that reads at a glance. */
.th-toaster [data-sonner-toast] [data-close-button] {
	left: auto !important;
	right: 8px !important;
	top: 8px !important;
	transform: none !important;
	width: 28px !important;
	height: 28px !important;
	border-radius: 0 !important;
	border: 0 !important;
	background: transparent !important;
	color: var(--colorMuted, #5C544A) !important;
	transition: background-color 120ms ease, color 120ms ease;
}

.th-toaster [data-sonner-toast] [data-close-button] svg {
	width: 16px !important;
	height: 16px !important;
	stroke-width: 2 !important;
}

.th-toaster [data-sonner-toast] [data-close-button]:hover {
	background: var(--surfaceOverlay, rgba(33, 28, 22, 0.04)) !important;
	color: var(--color, #211C16) !important;
}

/* v2 focus ring (2px $accent, 2px offset) in place of sonner's soft box-shadow. */
.th-toaster [data-sonner-toast] [data-close-button]:focus-visible {
	box-shadow: none !important;
	outline: 2px solid var(--accent, #E2481D) !important;
	outline-offset: 2px !important;
}

.th-toaster [data-sonner-toast] [data-button] {
	border-radius: 0 !important;
	font-weight: 700 !important;
	text-transform: uppercase !important;
	letter-spacing: 0.6px !important;
	font-size: 11px !important;
	padding: 0 10px !important;
	/* Small (11px) bold label ⇒ needs WCAG AA (4.5:1). Resting is the HARD
	   accent with --onStructure, the ink colors.ts pairs with accentHard fills
	   (--onBrandSecondary is dark ink in ember and swiss, 1.9:1 on their steel
	   blue): stub 5.7:1, ember/swiss 9.5:1. Hover keeps that pair and
	   underlines the label: the lighter --accent fill would drop the label
	   below 4.5:1 (stub 3.9:1, ember 3.2:1), and an 11px label gets no
	   large-text allowance. Inline fallbacks cover a missing body var. */
	background: var(--accentHard, #B93312) !important;
	color: var(--onStructure, #FDFAF3) !important;
	/* In ember the steel-blue fill is only 1.5:1 against the navy frame, so
	   the button's shape vanished. A 1px edge in the toast's own ink draws it
	   in every mode (vs the toast surface: stub 13.7:1, ember 14.6:1, swiss 17.8:1).
	   A border, not an inset shadow: forced-colors mode keeps borders and
	   drops shadows. !important beats Sonner's [data-button]{border:none}. */
	border: 1px solid var(--color, #211C16) !important;
}

.th-toaster [data-sonner-toast] [data-button]:hover {
	text-decoration: underline !important;
	text-underline-offset: 3px !important;
}

/* Same v2 ring as the close button. Sonner's own is rgba(0,0,0,.4), which
   vanishes on the ember navy surface. */
.th-toaster [data-sonner-toast] [data-button]:focus-visible {
	box-shadow: none !important;
	outline: 2px solid var(--accent, #E2481D) !important;
	outline-offset: 2px !important;
}

.th-toaster [data-sonner-toast][data-type="success"] [data-icon] { color: var(--success) !important; }
.th-toaster [data-sonner-toast][data-type="info"] [data-icon] { color: var(--info) !important; }
.th-toaster [data-sonner-toast][data-type="warning"] [data-icon] { color: var(--warning) !important; }
.th-toaster [data-sonner-toast][data-type="error"] [data-icon] { color: var(--danger) !important; }
`;

/**
 * Sonner's light/dark base for the active Tamagui theme. Tamagui reports
 * sub-themes as "<base>_<sub>" (e.g. "ember_Button"), so only the base prefix
 * counts. ember (the web app's dark mode) and a plain "dark" map to "dark";
 * stub, swiss and anything unresolved map to "light", the default stub mode.
 */
export function sonnerThemeForThemeName(
  themeName: string | null | undefined,
): "light" | "dark" {
  const base = (themeName ?? "").split("_")[0];
  return base === "ember" || base === "dark" ? "dark" : "light";
}

interface SonnerViewportProps {
  position: ToastPosition;
  durationMs: number;
}

export function SonnerViewport({ position, durationMs }: SonnerViewportProps) {
  // Sonner renders DOM that doesn't survive SSR/CSR diffing cleanly under
  // Tamagui (and a bunch of upstream issues track this). Defer mount one
  // tick so the first client paint matches the server output.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const sonnerTheme = sonnerThemeForThemeName(useThemeName());

  const sonnerPosition = useMemo(
    () => SONNER_POSITION[position] ?? "top-right",
    [position],
  );

  if (!mounted) return null;

  return (
    <>
      <style>{ITHASFIRE_TOAST_CSS}</style>
      <Toaster
        position={sonnerPosition}
        duration={durationMs}
        closeButton
        expand
        // Colours are fully driven by the design-token CSS vars above (bg/text/
        // border/icon/buttons/description all !important) and stay pinned.
        // The theme follows the APP's mode (the ambient Tamagui theme under
        // apps/web's <Theme name={appearance}>), not the OS, so any Sonner
        // base rule we have not overridden agrees with the app as well.
        // "system" followed the OS and painted #e8e8e8 on cream.
        theme={sonnerTheme}
        visibleToasts={4}
        toastOptions={{
          unstyled: false,
          // Anchor our CSS overrides via a stable attribute selector.
          classNames: {
            toast: "th-toast",
          },
        }}
        className="th-toaster"
        containerAriaLabel="Notifications"
        offset={16}
        gap={10}
      />
    </>
  );
}
