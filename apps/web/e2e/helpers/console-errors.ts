import type { ConsoleMessage, Page } from "@playwright/test";

// ─────────────────────────────────────────────────────────────────────────────
// Console-error collector
// ─────────────────────────────────────────────────────────────────────────────
// Attaches to `page.on("console")` and `page.on("pageerror")` to capture
// errors that appear in the browser DevTools console. Use the returned
// `errors()` function after navigation + idle to assert zero console errors.
//
// Known-noisy messages (e.g. favicon 404, Stripe.js warnings, HMR messages)
// are filtered out so the signal stays clean.
// ─────────────────────────────────────────────────────────────────────────────

/** Substrings/patterns that are expected noise and should not fail tests. */
const IGNORED_PATTERNS: RegExp[] = [
  // Browser / infra noise
  /favicon\.ico/i,
  // Next.js dev-mode noise
  /Fast Refresh/i,
  /\[HMR\]/i,
  /ReactDOM\.render is no longer supported/i,
  /legacyBehavior.*is deprecated/i,
  // Next.js / React performance measurement noise
  /cannot have a negative time stamp/i,
  // Stripe.js noise
  /Stripe\.js/i,
  // ── React hydration ───────────────────────────────────────────────────
  // Exactly ONE hydration message is ignorable, and only because React
  // itself classes it as a recoverable warning: a server/client ATTRIBUTE
  // difference on an otherwise-matching tree.
  /hydrated but some attributes of the server rendered html didn't match the client properties/i,
  //
  // Do NOT re-add a broad hydration pattern here. Two used to live at this
  // spot and both swallowed genuine failures:
  //
  //   /hydration-mismatch/i   — React appends the docs link
  //                             "https://react.dev/link/hydration-mismatch"
  //                             to REAL "Hydration failed because the server
  //                             rendered HTML didn't match the client"
  //                             errors, so this matched every one of them.
  //   /did not match.*server/i — matches "Text content did not match.
  //                             Server: … Client: …", also a real failure.
  //
  // Consequence: this gate reported zero console errors on a page that was
  // throwing a full hydration failure on every load (a settings route SSR-ing
  // a pending-session spinner where the client rendered resolved chrome).
  // It looked like coverage and was not. A whole-tree hydration failure means
  // React threw the server HTML away and re-rendered on the client — that is
  // a correctness and performance bug, and it must fail the test.
  // Chrome-specific extension noise
  /chrome-extension:\/\//i,
  // tRPC devtools styled console output (debug logs, not real errors)
  /%c << query #\d+/i,
  // React Native Web / Tamagui prop-leaking: textTransform, dataSet, etc.
  /does not recognize the.*prop on a DOM element.*textTransform/i,
  // ── Conditional-UI passkey in headless Chromium ───────────────────────
  // `LoginCard` arms WebAuthn conditional mediation on the step-1 identifier
  // field, gated on the spec's own `isConditionalMediationAvailable()`.
  // Headless Chromium answers TRUE to that and then refuses the ceremony
  // ("Resident credentials or empty 'allowCredentials' lists are not
  // supported at this time"), and Better Auth's passkey client console.errors
  // its own catch — so every spec that merely LANDS on a sign-in surface
  // collected an error for a feature that is working as designed.
  //
  // Deliberately pinned to all three parts (passkey + NotSupportedError +
  // "Resident credentials"). A real passkey failure in a real browser is a
  // NotAllowedError (user cancel / timeout), a SecurityError (RP-ID
  // mismatch) or a fetch failure, and none of those match this. Do NOT widen
  // it to /passkey/i — that would swallow exactly the failures worth seeing.
  /Error verifying passkey NotSupportedError: Resident credentials/i,
];

function isIgnored(text: string): boolean {
  return IGNORED_PATTERNS.some((re) => re.test(text));
}

// ── Chrome's own line for a handled tRPC refusal ─────────────────────────
// Chrome logs EVERY 4xx response as "Failed to load resource: the server
// responded with a status of 409 (Conflict)". The text carries no URL, so a
// text pattern could only exempt every 4xx on every page. This exemption is
// keyed on the message's source URL instead: a batch made ONLY of the
// procedures below, at the status codes their handled refusals map to.
//
// "The deal" reads `deals.getTermsDeal` on every agreement page and event
// builder; a target with no deal answers 404 (PAYOUT_TERMS_NOT_FOUND), 403
// (AGREEMENT_FINALIZED, terms owned by the booking) or 409
// (AGREEMENT_MISSING_PAYOUT_TERMS), and the editor draws each as a state.
// A real fault on the same procedure is still caught: the tRPC logger link
// console.errors any refusal not in `EXPECTED_PROCEDURE_ERRORS`
// (src/trpc.ts), e.g. NOT_AGREEMENT_PARTY, which is also a 403.
const HANDLED_REFUSAL_RESOURCES: ReadonlyArray<{
  procedure: string;
  statuses: readonly number[];
}> = [{ procedure: "deals.getTermsDeal", statuses: [403, 404, 409] }];

const FAILED_RESOURCE_RE =
  /^Failed to load resource: the server responded with a status of (\d{3}) \(/;

/** Exported for tests. */
export function isHandledRefusalResource(
  text: string,
  sourceUrl: string | undefined,
): boolean {
  const status = FAILED_RESOURCE_RE.exec(text)?.[1];
  if (!status || !sourceUrl) return false;
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    return false;
  }
  const match = /^\/trpc\/([^/]+)$/.exec(url.pathname);
  if (!match) return false;
  const procedures = decodeURIComponent(match[1]).split(",");
  return HANDLED_REFUSAL_RESOURCES.some(
    (entry) =>
      entry.statuses.includes(Number(status)) &&
      procedures.every((p) => p === entry.procedure),
  );
}

export interface ConsoleErrorCollector {
  /** All collected error messages (filtered). */
  errors: () => string[];
  /** Stop collecting — call in afterEach / finally if desired. */
  detach: () => void;
}

/**
 * Start collecting console errors for a page.
 * Call `errors()` after navigation is complete to get the list.
 */
export function collectConsoleErrors(page: Page): ConsoleErrorCollector {
  const collected: string[] = [];

  const onConsole = (msg: ConsoleMessage) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (isHandledRefusalResource(text, msg.location().url)) return;
    if (!isIgnored(text)) {
      collected.push(text);
    }
  };

  const onPageError = (err: Error) => {
    const text = err.message ?? String(err);
    if (!isIgnored(text)) {
      collected.push(`[pageerror] ${text}`);
    }
  };

  page.on("console", onConsole);
  page.on("pageerror", onPageError);

  return {
    errors: () => [...collected],
    detach: () => {
      page.removeListener("console", onConsole);
      page.removeListener("pageerror", onPageError);
    },
  };
}
