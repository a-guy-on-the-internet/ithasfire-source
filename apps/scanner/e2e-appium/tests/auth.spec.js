/**
 * Auth flow — test magic link sign-in and session persistence.
 */
import {
  expectUnauthenticatedSignIn,
  foregroundScannerApp,
  selectors,
  waitForDisplayed,
} from "./support/scanner-app.js";

describe("Scanner auth flow", () => {
  beforeEach(async () => {
    await foregroundScannerApp();
  });

  it("should expose the magic-link form on the sign-in screen", async () => {
    await expectUnauthenticatedSignIn();

    const emailInput = await waitForDisplayed(
      selectors.signInEmailInput,
      10_000,
    );
    expect(await emailInput.isDisplayed()).toBe(true);
  });

  it("should validate invalid email locally", async () => {
    await expectUnauthenticatedSignIn();

    const emailInput = await waitForDisplayed(
      selectors.signInEmailInput,
      10_000,
    );
    await emailInput.setValue("not-an-email");

    const submitButton = await waitForDisplayed(
      selectors.signInSendButton,
      10_000,
    );
    await submitButton.click();

    const errorMessage = await waitForDisplayed(
      selectors.signInErrorMessage,
      5_000,
    );

    expect(await errorMessage.isDisplayed()).toBe(true);
    expect(await errorMessage.getText()).toContain("valid email");
  });
});
