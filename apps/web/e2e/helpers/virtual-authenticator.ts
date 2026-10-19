import type { Page } from "@playwright/test";

/**
 * Install a CDP virtual WebAuthn authenticator on a page.
 *
 * Extracted so passkey specs share one definition — it was duplicated, and the
 * option set is load-bearing in non-obvious ways:
 *
 * - `hasResidentKey: true` is required for DISCOVERABLE (userless) credentials,
 *   which is what Better Auth's `signIn.passkey()` no-username flow relies on.
 * - `isUserVerified` + `automaticPresenceSimulation` make the ceremony complete
 *   without a real user gesture, which is the only reason this works headless.
 *
 * Known limitation, so nobody burns an afternoon on it: enrolling a SECOND
 * passkey for the same user against the SAME authenticator intermittently fails
 * with "Previously registered". That is correct WebAuthn behaviour — Better
 * Auth sends `excludeCredentials` listing the user's existing credentials, and
 * the authenticator refuses to create a duplicate. Tests needing two
 * credentials must install a second authenticator BEFORE the first enrollment,
 * and even then Chromium may route both ceremonies to the first device.
 */
export interface VirtualAuthenticatorHandle {
  authenticatorId: string;
  cleanup: () => Promise<void>;
}

export async function installVirtualAuthenticator(
  page: Page,
): Promise<VirtualAuthenticatorHandle> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

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
