import { expect, test } from "./fixtures";
import { removeAllPasskeys } from "./helpers/passkeys";

/**
 * Passkey end-to-end coverage.
 *
 * Uses Chrome DevTools Protocol's WebAuthn domain to inject a virtual
 * authenticator before each test, so we can:
 *   - register a passkey from /account/settings/security (Passkeys → Add)
 *   - sign in via the `PASSKEY` peer on step 1 of /sign-in
 *     (`auth-sign-in-passkey` — it was the accent "Continue with Passkey"
 *     CTA before the two-step redesign demoted it to an ink-outline peer
 *     beside Google and Apple; the test id and the behaviour are unchanged)
 *
 * The virtual authenticator is created with `hasResidentKey: true` so that
 * userless (discoverable) credentials work — Better Auth's signIn.passkey()
 * relies on this for the no-username flow.
 */

interface VirtualAuthenticatorHandle {
  authenticatorId: string;
  cleanup: () => Promise<void>;
}

async function installVirtualAuthenticator(
  page: import("@playwright/test").Page,
): Promise<VirtualAuthenticatorHandle> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = await cdp.send(
    "WebAuthn.addVirtualAuthenticator",
    {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    },
  );
  return {
    authenticatorId,
    cleanup: async () => {
      try {
        await cdp.send("WebAuthn.removeVirtualAuthenticator", {
          authenticatorId,
        });
      } catch {
        // best-effort
      }
      try {
        await cdp.detach();
      } catch {
        // best-effort
      }
    },
  };
}

test.describe("Passkey", () => {
  // Remove every passkey these tests enrol.
  //
  // Matters specifically under E2E_USE_LIVE_STACK=1, where the database is
  // NOT reset between runs: without this each run leaves credentials behind,
  // and they accumulate on the shared test account. Observed after a handful
  // of runs — six rows, several with identical names, because enrolling while
  // the list is still loading sees an empty `existingNames` and skips the
  // disambiguating suffix. Best-effort: cleanup must never fail the suite.
  test.afterEach(async ({ page }) => {
    try {
      // The Security ROUTE, not bare /account/settings — settings is one route
      // per section now, and the bare path renders Profile, where there is no
      // passkey list to clear. Cleanup pointed there silently removed nothing.
      await page.goto("/account/settings/security");
      await removeAllPasskeys(page);
    } catch {
      // best-effort — a signed-out or failed test has nothing to clean.
    }
  });

  test("user can enroll a passkey from account settings", async ({ page }) => {
    const auth = await installVirtualAuthenticator(page);
    try {
      await page.goto("/account/settings/security");

      // Passkeys are an independent primary factor — the card renders for
      // every signed-in user, including OAuth-only ones. (Password and TOTP,
      // its route-mates, are the credential-gated pair.)
      const addBtn = page.getByTestId("passkey-add");
      await expect(addBtn).toBeVisible({ timeout: 15_000 });

      await addBtn.click();

      // On success the section reloads its list and the Add button returns
      // to its idle label. The new passkey row should appear shortly after.
      await expect(addBtn).toContainText(/Add a passkey/i, { timeout: 10_000 });

      // The list is rendered inside the same SectionCard. The first row's
      // Remove button is the cheapest "yes there is one" assertion.
      const remove = page.getByRole("button", { name: /Remove/i }).first();
      await expect(remove).toBeVisible({ timeout: 5_000 });
    } finally {
      await auth.cleanup();
    }
  });

  test("user can sign in with a passkey", async ({ page }) => {
    const auth = await installVirtualAuthenticator(page);
    try {
      // Step 1 — enroll a passkey while signed in.
      await page.goto("/account/settings/security");
      await page.getByTestId("passkey-add").click();
      await expect(
        page.getByRole("button", { name: /Remove/i }).first(),
      ).toBeVisible({
        timeout: 10_000,
      });

      // Step 2 — sign out, then sign back in via the passkey CTA.
      // Signing out via the API endpoint avoids depending on the profile-menu DOM.
      //
      // Must target the API ORIGIN explicitly. Better Auth is mounted on the
      // Fastify app at :3001; the web origin's own /api/auth shim answers
      // POST /api/auth/sign-out with **501**. This used to be an in-page
      // `fetch("/api/auth/sign-out")` whose failure was swallowed by a
      // best-effort catch, so the session survived, /sign-in bounced the
      // still-authenticated user, and the passkey CTA never rendered. Use
      // `page.request` (shares the browser context's cookie jar, so the
      // clearing Set-Cookie applies) rather than an in-page cross-origin fetch,
      // which would additionally need CORS to permit it.
      // The `Origin` header is REQUIRED: Better Auth validates it against its
      // trusted origins for state-changing requests, and an authenticated
      // sign-out without one is rejected 403 (verified: 403 bare, 200 with
      // `origin: http://localhost:3000`).
      const apiBaseUrl =
        process.env.PLAYWRIGHT_API_BASE_URL ?? "http://localhost:3001";
      const webOrigin =
        process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
      const signOut = await page.request.post(
        `${apiBaseUrl}/api/auth/sign-out`,
        { headers: { origin: webOrigin } },
      );
      expect(
        signOut.ok(),
        `sign-out failed (${signOut.status()}) — the rest of this test is meaningless if the session survives`,
      ).toBeTruthy();

      await page.goto("/sign-in");
      const cta = page.getByTestId("auth-sign-in-passkey");
      await expect(cta).toBeVisible();
      await cta.click();

      // Successful passkey sign-in redirects to "/" by default.
      await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), {
        timeout: 15_000,
      });
      expect(page.url()).not.toContain("/sign-in");
    } finally {
      await auth.cleanup();
    }
  });
});
