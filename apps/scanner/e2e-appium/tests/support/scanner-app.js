/**
 * ⚠️ This map has PRE-EXISTING rot beyond the unified-scan consolidation.
 * `send-magic-link-button`, `event-selection-*`, `settings-switch-event-button`
 * and `settings-screen` (the real testID is `scanner-settings-screen`) all
 * pre-date the current UI and were already dead before the scan flows were
 * merged. The suites also don't run today — vitest picks them up and fails with
 * `describe is not defined` because they're written for WebdriverIO.
 *
 * The entries below were corrected for the scan consolidation; the rest are
 * left as-is rather than silently "fixed" in a suite that cannot be executed to
 * verify the fix. Reviving this needs its own change with a working runner.
 */
export const selectors = {
  signInScreen: "~sign-in-screen",
  signInEmailInput: "~sign-in-email-input",
  signInSendButton: "~send-magic-link-button",
  signInErrorMessage: "~sign-in-error-message",
  signInSuccessMessage: "~sign-in-success-message",
  accessDeniedScreen: "~access-denied-screen",
  accessDeniedSignOutButton: "~access-denied-sign-out-button",
  eventSelectionScreen: "~event-selection-screen",
  eventSelectionList: "~event-selection-list",
  eventSelectionManualToggle: "~event-selection-manual-toggle",
  scannerHomeScreen: "~scanner-home-screen",
  // One scan surface: the separate ticket / volunteer entry points and their
  // two camera screens were deleted when the resolver became unconditional.
  openScanButton: "~open-scan-button",
  openLookupButton: "~open-lookup-button",
  scanScreen: "~unified-scan-screen",
  grantCameraAccessButton: "~grant-camera-access-button",
  scanCameraFrame: "~unified-scan-camera-frame",
  settingsScreen: "~settings-screen",
  settingsSwitchEventButton: "~settings-switch-event-button",
  settingsSignOutButton: "~settings-sign-out-button",
};

const screenSelectors = {
  signIn: selectors.signInScreen,
  accessDenied: selectors.accessDeniedScreen,
  eventSelection: selectors.eventSelectionScreen,
  home: selectors.scannerHomeScreen,
  scan: selectors.scanScreen,
  settings: selectors.settingsScreen,
};

const appBundleId = process.env.E2E_APP_BUNDLE_ID ?? "com.anonymous.scanner";

const describeAppState = (state) => {
  switch (state) {
    case 0:
      return "not installed";
    case 1:
      return "not running";
    case 2:
      return "running in background or suspended";
    case 3:
      return "running in background";
    case 4:
      return "running in foreground";
    default:
      return `unknown (${state})`;
  }
};

export async function foregroundScannerApp() {
  const state = await browser.queryAppState(appBundleId);

  if (state !== 4) {
    await browser.activateApp(appBundleId);
  }

  await browser.waitUntil(
    async () => (await browser.queryAppState(appBundleId)) === 4,
    {
      timeout: 10_000,
      timeoutMsg: `Scanner app ${appBundleId} did not reach the foreground.`,
    },
  );
}

export async function waitForDisplayed(selector, timeout = 30_000) {
  const element = await $(selector);
  await element.waitForDisplayed({ timeout });
  return element;
}

export async function waitForAnyDisplayed(
  candidateSelectors,
  timeout = 30_000,
) {
  let matchedSelector = null;

  await browser.waitUntil(
    async () => {
      for (const selector of candidateSelectors) {
        if (await isDisplayed(selector)) {
          matchedSelector = selector;
          return true;
        }
      }

      return false;
    },
    {
      timeout,
      interval: 250,
      timeoutMsg: `None of the expected selectors became visible: ${candidateSelectors.join(", ")}`,
    },
  );

  return $(matchedSelector);
}

async function isDisplayed(selector) {
  try {
    const element = await $(selector);
    return await element.isDisplayed();
  } catch {
    return false;
  }
}

export async function getCurrentScannerScreen(timeout = 30_000) {
  let activeScreen = null;

  try {
    await browser.waitUntil(
      async () => {
        const appState = await browser.queryAppState(appBundleId);

        if (appState !== 4) {
          await browser.activateApp(appBundleId);
          return false;
        }

        for (const [screenName, selector] of Object.entries(screenSelectors)) {
          if (await isDisplayed(selector)) {
            activeScreen = screenName;
            return true;
          }
        }

        return false;
      },
      {
        timeout,
        interval: 250,
        timeoutMsg: "Scanner app did not reach a known screen.",
      },
    );
  } catch {
    const appState = await browser.queryAppState(appBundleId);
    const stateDescription = describeAppState(appState);

    if (appState === 4) {
      throw new Error(
        "Scanner app stayed in the foreground but never exposed a known React screen. " +
          "The app is likely stuck on the native splash screen before the React UI mounted.",
      );
    }

    throw new Error(
      `Scanner app did not remain foregrounded while waiting for a known screen (state: ${stateDescription}). ` +
        "The simulator may have fallen back to SpringBoard or the app may have exited during launch.",
    );
  }

  return activeScreen;
}

export async function expectUnauthenticatedSignIn(timeout = 30_000) {
  const screen = await getCurrentScannerScreen(timeout);

  if (screen !== "signIn") {
    throw new Error(
      `Expected unauthenticated sign-in after bootstrapping, but landed on ${screen}. ` +
        "Clear the simulator's persisted scanner session before running this spec.",
    );
  }

  return screen;
}

export async function expectAuthenticatedScannerRoute(timeout = 30_000) {
  const screen = await getCurrentScannerScreen(timeout);

  if (screen === "signIn") {
    throw new Error(
      "Authenticated scan-flow precondition not met: the simulator is unauthenticated and landed on sign-in. " +
        "Seed a valid scanner session before running scan-flow.spec.js.",
    );
  }

  if (screen === "accessDenied") {
    throw new Error(
      "Authenticated scan-flow precondition not met: the simulator session is signed in but lacks scanner access and landed on access denied. " +
        "Provision the SCANNER role for this account before running scan-flow.spec.js.",
    );
  }

  return screen;
}
