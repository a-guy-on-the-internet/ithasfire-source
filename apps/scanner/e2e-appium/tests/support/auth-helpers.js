/**
 * Auth helpers for the Appium e2e harness.
 *
 * `signInWithMagicLink` drives the full production magic-link flow:
 *   1. Type the operator email into the SignInScreen and tap "Send magic link".
 *   2. Poll Mailpit for the resulting email and extract the Better Auth verify URL.
 *   3. Open the URL on the booted iOS simulator with `xcrun simctl openurl`.
 *      iOS Safari hits the API verify endpoint, which 302-redirects to
 *      `ithasfire-scanner://auth-callback?token=<sessionToken>`. iOS then
 *      hands the deep link to the scanner app, where the Better Auth Expo
 *      client persists the session token from the `set-auth-token` header.
 *   4. Wait for an authenticated route. We deliberately do NOT call
 *      `foregroundScannerApp` between `openUrlOnSimulator` and the wait,
 *      because pulling the scanner forward mid-redirect can cancel the
 *      Safari->API->scheme handoff. `expectAuthenticatedScannerRoute`
 *      already re-activates the scanner if it isn't in front once the OS
 *      has dispatched the deep link.
 *
 * MFA: the scanner intentionally exposes only the magic-link path (BYOD
 * operators, no password). Better Auth's `twoFactor` plugin only triggers on
 * password sign-ins, so the magic-link flow does not produce a TOTP challenge.
 * If a password path is ever added to SignInScreen, extend this helper to
 * detect a `~mfa-totp-input` testID and feed in a deterministic code.
 */
import { execSync } from "node:child_process";

import {
  expectAuthenticatedScannerRoute,
  expectUnauthenticatedSignIn,
  foregroundScannerApp,
  getCurrentScannerScreen,
  selectors,
  waitForDisplayed,
} from "./scanner-app.js";
import {
  createMailpitClient,
  extractMagicLinkUrlFromMailpitMessage,
} from "./mailpit.js";

const MAGIC_LINK_SUBJECT_HINT = "scanner";
const appBundleId = process.env.E2E_APP_BUNDLE_ID ?? "com.anonymous.scanner";

function shellEscape(value) {
  // simctl URL arguments are passed as a single positional shell arg; wrap in
  // single quotes and escape any embedded single quotes.
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * Open `url` on the iOS simulator. Defaults to the booted device but supports
 * targeting a specific UDID via E2E_SIMULATOR_UDID.
 */
export function openUrlOnSimulator(url) {
  const target =
    process.env.E2E_SIMULATOR_UDID &&
    process.env.E2E_SIMULATOR_UDID.trim().length > 0
      ? process.env.E2E_SIMULATOR_UDID.trim()
      : "booted";

  try {
    execSync(
      `xcrun simctl openurl ${shellEscape(target)} ${shellEscape(url)}`,
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    const stderr = error?.stderr?.toString?.() ?? "";
    throw new Error(
      `xcrun simctl openurl failed for target=${target}: ${stderr || error.message}. ` +
        "Ensure a simulator is booted (xcrun simctl list devices booted).",
    );
  }
}

/**
 * Sign out from any post-auth screen so the next sign-in test starts clean.
 *
 * If the app is already on signIn, this is a no-op. From accessDenied or
 * settings we use the in-app sign-out button. As a last resort (authenticated
 * but no sign-out button reachable) we terminate and relaunch the app, which
 * the Better Auth Expo client treats as a fresh launch with the persisted
 * session — so we additionally clear the session via the settings flow when
 * possible. Used between `it` blocks to keep specs order-independent.
 */
export async function ensureUnauthenticated({ timeout = 30_000 } = {}) {
  await foregroundScannerApp();

  let screen = null;
  try {
    screen = await getCurrentScannerScreen(timeout);
  } catch {
    screen = null;
  }

  if (screen === "signIn") return;

  if (screen === "accessDenied") {
    const button = await waitForDisplayed(
      selectors.accessDeniedSignOutButton,
      10_000,
    );
    await button.click();
    await expectUnauthenticatedSignIn(timeout);
    return;
  }

  if (screen === "settings") {
    const button = await waitForDisplayed(
      selectors.settingsSignOutButton,
      10_000,
    );
    await button.click();
    await expectUnauthenticatedSignIn(timeout);
    return;
  }

  // Authenticated but on a screen without a sign-out button. Terminating the
  // app does NOT clear the persisted SecureStore token, so on relaunch the
  // user will still be signed in. We surface that explicitly so callers know
  // to tear down via a screen that exposes sign-out.
  throw new Error(
    `ensureUnauthenticated: cannot sign out from screen=${screen ?? "<unknown>"}. ` +
      "Navigate to settings or accessDenied first, or call signOut via the in-app UI.",
  );
}

/**
 * Drive a real magic-link sign-in end-to-end.
 *
 * Preconditions:
 *  - Scanner app is foregrounded on the SignInScreen (unauthenticated).
 *  - The API is wired to Mailpit (SMTP_HOST/PORT match infra/docker).
 *  - The operator account exists with a SCANNER-eligible org membership.
 *
 * Returns the authenticated screen name (e.g. "eventSelection", "home", or
 * "accessDenied" if the account lacks the SCANNER role).
 */
export async function signInWithMagicLink({
  email,
  mailpit = createMailpitClient(),
  emailTimeoutMs = 20_000,
  authTimeoutMs = 30_000,
  expectAccessDenied = false,
} = {}) {
  if (!email || typeof email !== "string") {
    throw new Error("signInWithMagicLink: 'email' is required.");
  }

  // Capture the cutoff so we don't pick up a stale email from a previous run
  // even when Mailpit isn't cleared (e.g. shared local-dev inbox).
  const sinceTimestamp = Date.now() - 1_000;

  await foregroundScannerApp();
  await expectUnauthenticatedSignIn(authTimeoutMs);

  const emailInput = await waitForDisplayed(selectors.signInEmailInput, 10_000);
  await emailInput.setValue(email);

  const sendButton = await waitForDisplayed(selectors.signInSendButton, 10_000);
  await sendButton.click();

  // The success message confirms the API accepted the request and the email
  // is on its way. Surfacing this gives a much better failure signal than
  // timing out on Mailpit alone.
  await waitForDisplayed(selectors.signInSuccessMessage, 15_000);

  const message = await mailpit.waitForEmailTo(email, {
    timeoutMs: emailTimeoutMs,
    sinceTimestamp,
    subjectIncludes: MAGIC_LINK_SUBJECT_HINT,
  });

  const verifyUrl = extractMagicLinkUrlFromMailpitMessage(message);
  openUrlOnSimulator(verifyUrl);

  // Do NOT eagerly foreground the scanner here: Safari is mid-request to the
  // API and pulling the scanner forward can cancel the redirect that fires
  // the `ithasfire-scanner://` scheme. `expectAuthenticatedScannerRoute`
  // (and `getCurrentScannerScreen` underneath it) re-activates the scanner
  // once it loses foreground after the OS dispatches the deep link.

  try {
    if (expectAccessDenied) {
      const screen = await getCurrentScannerScreen(authTimeoutMs);
      return { screen, verifyUrl, mailpitMessageId: message.ID };
    }

    const screen = await expectAuthenticatedScannerRoute(authTimeoutMs);
    return { screen, verifyUrl, mailpitMessageId: message.ID };
  } catch (error) {
    let currentScreen = "<unknown>";
    try {
      currentScreen = (await getCurrentScannerScreen(5_000)) ?? "<unresolved>";
    } catch {
      // ignore — we already have the underlying error to rethrow.
    }
    const enriched = new Error(
      `Magic-link sign-in failed for ${email}. ` +
        `verifyUrl=${verifyUrl} mailpitMessageId=${message.ID} currentScreen=${currentScreen}. ` +
        `Underlying: ${error.message}`,
    );
    enriched.cause = error;
    throw enriched;
  }
}

export { appBundleId as scannerAppBundleId };
