/**
 * Scan flow — exercise the current authenticated routing states.
 *
 * Requires: authenticated session (run auth setup first or use
 * a pre-authenticated simulator state).
 */
import {
  expectAuthenticatedScannerRoute,
  foregroundScannerApp,
  selectors,
  waitForAnyDisplayed,
  waitForDisplayed,
} from "./support/scanner-app.js";

describe("Scanner scan flow", () => {
  beforeEach(async () => {
    await foregroundScannerApp();
  });

  it("should require a selected-event operator state and then reach a current scan surface", async () => {
    const screen = await expectAuthenticatedScannerRoute();

    if (screen === "eventSelection") {
      throw new Error(
        "Authenticated scan-flow precondition not met: the simulator has no selected event and landed on event selection. " +
          "Seed a selected event before running scan-flow.spec.js.",
      );
    }

    if (screen === "home") {
      const openTicketAdmissionButton = await waitForDisplayed(
        selectors.openTicketAdmissionButton,
        10_000,
      );
      const openVolunteerCheckInButton = await waitForDisplayed(
        selectors.openVolunteerCheckInButton,
        10_000,
      );

      expect(await openVolunteerCheckInButton.isDisplayed()).toBe(true);
      await openTicketAdmissionButton.click();

      const ticketSurfaceFromHome = await waitForAnyDisplayed(
        [
          selectors.ticketScanCameraFrame,
          selectors.grantCameraAccessButton,
          selectors.ticketScanProcessingState,
          selectors.ticketScanErrorState,
          selectors.ticketScanResultState,
        ],
        15_000,
      );
      expect(await ticketSurfaceFromHome.isDisplayed()).toBe(true);
      return;
    }

    if (screen === "settings") {
      throw new Error(
        "Authenticated scan-flow precondition not met: the simulator resumed on settings instead of a scan-capable route. " +
          "Return to home, ticket admission, or volunteer check-in before running scan-flow.spec.js.",
      );
    }

    if (screen === "volunteerCheckIn") {
      const scanModeButton = await waitForDisplayed(
        selectors.volunteerScanModeButton,
        10_000,
      );
      const searchModeButton = await waitForDisplayed(
        selectors.volunteerSearchModeButton,
        10_000,
      );

      expect(await scanModeButton.isDisplayed()).toBe(true);
      await searchModeButton.click();

      const volunteerSurface = await waitForAnyDisplayed(
        [selectors.volunteerSearchInput, selectors.volunteerSearchSubmitButton],
        10_000,
      );
      expect(await volunteerSurface.isDisplayed()).toBe(true);
      return;
    }

    if (screen === "ticketScan") {
      const ticketSurface = await waitForAnyDisplayed(
        [
          selectors.ticketScanCameraFrame,
          selectors.grantCameraAccessButton,
          selectors.ticketScanProcessingState,
          selectors.ticketScanErrorState,
          selectors.ticketScanResultState,
        ],
        15_000,
      );
      expect(await ticketSurface.isDisplayed()).toBe(true);
      return;
    }

    throw new Error(`Unhandled authenticated scanner screen: ${screen}`);
  });
});
