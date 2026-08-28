/**
 * Smoke test — verify the scanner app launches and renders the sign-in screen.
 */
import {
  expectUnauthenticatedSignIn,
  foregroundScannerApp,
  selectors,
  waitForDisplayed,
} from "./support/scanner-app.js";

describe("Scanner app smoke test", () => {
  beforeEach(async () => {
    await foregroundScannerApp();
  });

  it("should launch and reach unauthenticated sign-in after bootstrapping", async () => {
    await expectUnauthenticatedSignIn();

    const emailInput = await waitForDisplayed(
      selectors.signInEmailInput,
      10_000,
    );
    const sendMagicLinkButton = await waitForDisplayed(
      selectors.signInSendButton,
      10_000,
    );

    expect(await emailInput.isDisplayed()).toBe(true);
    expect(await sendMagicLinkButton.isDisplayed()).toBe(true);
  });
});
