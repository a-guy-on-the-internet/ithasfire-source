/**
 * Scanner-side adapter for the canonical passkey display-name derivation.
 *
 * `derivePasskeyName` (`packages/types/src/passkey-name.ts`) is deliberately
 * environment-pure — it never touches react-native's `Platform` — so every
 * consumer has to supply its own `deviceLabel`. This module is the scanner's
 * single supplier of that label.
 *
 * It exists because the two scanner enrollment entry points (Settings →
 * "Add a passkey", and the post-sign-in `PasskeyEnrollPromptScreen`) each used
 * to build the name themselves and had drifted: settings produced
 * `"Tom's iPhone"` with an ASCII apostrophe, while the prompt passed the bare
 * person name — or, when the account had no display name, the operator's raw
 * EMAIL ADDRESS — straight through as the credential label. Both now call
 * {@link scannerPasskeyName}, so they cannot drift again.
 *
 * Note on `existingNames`: the settings screen supplies it (best effort, via
 * {@link collectExistingPasskeyNames}) so a second scanner of the same kind
 * enrolls as `"Tom’s Android scanner (2)"` rather than a second row with a
 * byte-identical label — which in the web passkey list also means two identical
 * `"Remove Tom’s Android scanner"` screen-reader labels next to an unconfirmed
 * delete. The post-sign-in prompt deliberately does NOT: it is the first-run,
 * lowest-friction path, where a pre-enrollment network round-trip costs more
 * than the duplicate label it would prevent (and on first run the list is
 * usually empty anyway).
 */

import { Platform } from "react-native";

import { derivePasskeyName } from "@th/types";

import type { PasskeyResult, ScannerPasskey } from "./passkey-client";

export interface ScannerDeviceIdentity {
  /**
   * `Platform.OS`. Typed as a plain string on purpose: an OS value we don't
   * recognise should degrade to "no device label" at runtime rather than fail
   * to compile when react-native adds a new target.
   */
  os: string;
  /**
   * `Platform.isPad`. Only meaningful when `os === "ios"`; react-native does
   * not define it on the other platform statics.
   */
  isPad?: boolean;
}

/**
 * Marks the credential as having been enrolled from the OPERATOR app rather
 * than from the consumer web account settings.
 *
 * Not cosmetic: scanner hardware is routinely shared, handed off between door
 * staff, or a venue-owned loaner. An operator auditing their passkey list on
 * the web needs to be able to tell "the iPhone in my pocket" from "the iPad
 * that lives at the box office", and revoke the right one. Lower-cased on
 * purpose — it reads as a qualifier ("Tom’s iPhone scanner"), not as a second
 * proper noun.
 */
const SCANNER_QUALIFIER = "scanner";

const qualify = (deviceKind: string): string =>
  `${deviceKind} ${SCANNER_QUALIFIER}`;

/**
 * Human-readable device label for a passkey enrolled from this app.
 *
 * Returns `null` — not a guess — for an OS we don't have wording for. A null
 * label makes {@link derivePasskeyName} fall back to `"Tom’s passkey"` /
 * `"Passkey"`, which is better than mislabelling the credential as a device
 * the operator doesn't own. Note that the fallback is deliberately NOT
 * `"scanner"` on its own: the qualifier only ever rides along with a device
 * noun we actually recognised.
 *
 * Pure and exported for tests; production callers want
 * {@link scannerPasskeyName}.
 */
export function scannerDeviceLabel(
  device: ScannerDeviceIdentity,
): string | null {
  switch (device.os) {
    case "ios":
      // The old settings-screen string said "iPhone" unconditionally, which
      // mislabelled every iPad. `Platform.isPad` is the cheap fix.
      return device.isPad ? qualify("iPad") : qualify("iPhone");
    case "android":
      // No Android equivalent of `isPad` worth trusting, and "Android tablet"
      // vs "Android phone" isn't a distinction operators care about here.
      return qualify("Android");
    case "macos":
      return qualify("Mac");
    case "windows":
      return qualify("Windows");
    case "web":
      // Expo web (`expo start --web`) — a dev-only surface. Deliberately NOT
      // run through `qualify()`: "Browser scanner" reads as a product name,
      // and this is the one platform where the browser is the incidental
      // detail and "scanner" is the identity. Parenthesised instead so the
      // qualifier still leads.
      return "Scanner (browser)";
    default:
      return null;
  }
}

/**
 * The display name to send with a scanner passkey enrollment.
 *
 * For an operator named "Tom": `"Tom’s iPhone scanner"` on iOS,
 * `"Tom’s Android scanner"` on Android (typographic apostrophe, per the shared
 * helper). With no display name on the account: `"iPhone scanner"` /
 * `"Android scanner"`.
 *
 * Callers must pass the person's NAME. Never pass an email address — an email
 * is not a device name, and the shared helper's no-name fallback is a better
 * label than leaking an address into a credential list.
 */
export function scannerPasskeyName(
  userName?: string | null,
  existingNames?: readonly (string | null | undefined)[],
): string {
  return derivePasskeyName({
    deviceLabel: scannerDeviceLabel({
      os: Platform.OS,
      isPad: Platform.OS === "ios" ? Platform.isPad : undefined,
    }),
    userName,
    existingNames,
  });
}

/**
 * How long we are willing to wait for the operator's existing passkey list
 * before enrolling without collision suffixes.
 *
 * A duplicate label is cosmetic; a "nothing happened when I tapped Add a
 * passkey" is not. Door staff run this on venue wifi, so the ceiling is
 * deliberately short — enrollment still has two more round-trips plus a native
 * biometric prompt ahead of it.
 */
const EXISTING_NAMES_TIMEOUT_MS = 2500;

/**
 * Best-effort `existingNames` for {@link scannerPasskeyName}.
 *
 * Takes the lister as a parameter rather than importing it so this module stays
 * free of runtime dependencies on the native passkey stack (the import above is
 * type-only) and so the failure branches are testable from a plain node vitest
 * run. Production callers pass `listUserPasskeys` from `./passkey-client`.
 *
 * NEVER throws and never rejects: every failure mode (transport error, API
 * error payload, malformed body, slow response) resolves to `undefined`, which
 * makes the caller derive a name with no collision suffix. Enrollment must not
 * be blocked by an optional nicety.
 */
export async function collectExistingPasskeyNames(
  list: () => Promise<PasskeyResult<ScannerPasskey[]>>,
  timeoutMs: number = EXISTING_NAMES_TIMEOUT_MS,
): Promise<string[] | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      list(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    // `null` == the timeout won. `result.error` == the API said no. Both are
    // "carry on without suffixes".
    if (!result || result.error || !Array.isArray(result.data)) {
      devWarnListFailed(
        result?.error?.message ?? (result ? "malformed_body" : "timed_out"),
      );
      return undefined;
    }
    const names = result.data
      .map((passkey) => passkey.name)
      .filter(
        (name): name is string =>
          typeof name === "string" && name.trim().length > 0,
      );
    return names.length > 0 ? names : undefined;
  } catch (err) {
    devWarnListFailed(err instanceof Error ? err.message : String(err));
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Dev-only breadcrumb. Matches the convention in `passkey-client.ts`: the
 * message only, never the response body or headers, and nothing at all on a
 * production binary — a passkey list is account metadata.
 */
function devWarnListFailed(message: string): void {
  if (typeof __DEV__ !== "undefined" && __DEV__) {
    // eslint-disable-next-line no-console
    console.warn(
      "[passkey-name] couldn't read existing passkey names; enrolling without collision suffixes (dev-only)",
      message,
    );
  }
}
