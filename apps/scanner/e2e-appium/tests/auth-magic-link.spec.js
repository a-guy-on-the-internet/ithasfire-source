/**
 * Magic-link auth integration spec.
 *
 * Drives the realest production sign-in path:
 *   SignInScreen email entry  ->  POST /api/auth/sign-in/magic-link  ->
 *   Better Auth -> Mailer -> Mailpit (SMTP)  ->
 *   Test polls Mailpit, extracts the verify URL  ->
 *   `xcrun simctl openurl` opens it in the simulator  ->
 *   Safari -> /api/auth/magic-link/verify -> 302 to ithasfire-scanner://auth-callback?token=  ->
 *   Scanner app receives the deep link, persists the session token  ->
 *   App renders an authenticated route (eventSelection / home / accessDenied).
 *
 * Required services:
 *   - Mailpit (infra/docker docker-compose.yml -> port 8025/api, 1025/smtp)
 *   - API with SMTP_HOST=127.0.0.1 SMTP_PORT=1025 SMTP_SECURE=false
 *   - A booted iOS simulator with the scanner app installed and unauthenticated
 *
 * Required env:
 *   E2E_SCANNER_EMAIL   email of a seeded operator (SCANNER-eligible org member)
 *   E2E_MAILPIT_URL     (optional) defaults to http://127.0.0.1:8025
 *   E2E_SIMULATOR_UDID  (optional) defaults to "booted"
 *
 * Test ordering: the banner-only test runs FIRST so it executes against a
 * fresh signIn screen. The full sign-in test runs LAST because it leaves the
 * app authenticated. Do not reorder without revisiting the per-test
 * preconditions.
 *
 * Mailpit isolation: this spec deliberately does NOT call `mailpit.clear()`
 * because that would destroy in-flight messages from any other local consumer
 * (web e2e, jobs, etc.). It instead filters on (recipient, subject hint,
 * sinceTimestamp) so stale or unrelated mail is ignored.
 */
import { expect } from "chai";

import {
  expectAuthenticatedScannerRoute,
  foregroundScannerApp,
  selectors,
  waitForDisplayed,
} from "./support/scanner-app.js";
import { signInWithMagicLink } from "./support/auth-helpers.js";
import { createMailpitClient } from "./support/mailpit.js";

const operatorEmail = process.env.E2E_SCANNER_EMAIL;
const appBundleId = process.env.E2E_APP_BUNDLE_ID ?? "com.anonymous.scanner";

describe("Scanner magic-link auth (real flow via Mailpit)", function () {
  // Mailpit polling + Safari redirect + deep-link handoff + relaunch can
  // take a while; budget generously.
  this.timeout(180_000);

  before(function () {
    if (!operatorEmail) {
      this.skip();
    }
  });

  beforeEach(async () => {
    await foregroundScannerApp();
  });

  it("ensures Mailpit is reachable before driving the UI", async () => {
    const mailpit = createMailpitClient();
    await mailpit.ready();
    expect(mailpit.origin).to.match(/^https?:\/\//);
  });

  // Runs SECOND on the unauthenticated signIn screen. Verifies the banner +
  // Mailpit delivery without consuming the link, so this test stays cheap and
  // doesn't change the app's auth state.
  it("surfaces the success banner immediately after sending the link", async () => {
    const sinceTimestamp = Date.now() - 1_000;
    const mailpit = createMailpitClient();
    await mailpit.ready();

    const emailInput = await waitForDisplayed(
      selectors.signInEmailInput,
      10_000,
    );
    await emailInput.setValue(operatorEmail);

    const sendButton = await waitForDisplayed(
      selectors.signInSendButton,
      10_000,
    );
    await sendButton.click();

    const success = await waitForDisplayed(
      selectors.signInSuccessMessage,
      15_000,
    );
    expect(await success.isDisplayed()).to.equal(true);

    const delivered = await mailpit.waitForEmailTo(operatorEmail, {
      timeoutMs: 20_000,
      sinceTimestamp,
      subjectIncludes: "scanner",
    });
    expect((delivered.Subject ?? "").toLowerCase()).to.include("scanner");
  });

  // Runs LAST: completes the full real flow and leaves the app authenticated.
  // Includes a terminate+relaunch step to prove the session token actually
  // round-tripped through SecureStore (not just lived in in-memory state).
  it("signs in via magic link, lands on an authenticated route, and persists the session across relaunch", async () => {
    const mailpit = createMailpitClient();
    await mailpit.ready();

    const { screen, verifyUrl } = await signInWithMagicLink({
      email: operatorEmail,
      mailpit,
    });

    // Sanity-check the URL Better Auth actually produced.
    expect(verifyUrl).to.match(/\/api\/auth\/magic-link\/verify/);
    expect(decodeURIComponent(verifyUrl)).to.include(
      "ithasfire-scanner://auth-callback",
    );

    expect(screen).to.be.oneOf([
      "eventSelection",
      "home",
      "ticketScan",
      "volunteerCheckIn",
      "settings",
    ]);

    const signInScreen = await $(selectors.signInScreen);
    expect(await signInScreen.isDisplayed()).to.equal(false);

    // Persistence proof: terminate and relaunch. If the token were only held
    // in in-memory state this would drop the user back to signIn. Better
    // Auth's expoClient writes the bearer token to SecureStore on every
    // successful response, so a relaunch must reach the same authenticated
    // route family.
    await browser.terminateApp(appBundleId);
    await browser.activateApp(appBundleId);
    const screenAfterRelaunch = await expectAuthenticatedScannerRoute(45_000);
    expect(screenAfterRelaunch).to.be.oneOf([
      "eventSelection",
      "home",
      "ticketScan",
      "volunteerCheckIn",
      "settings",
    ]);
  });
});
