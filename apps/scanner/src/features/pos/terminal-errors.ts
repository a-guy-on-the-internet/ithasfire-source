/**
 * What the operator reads when the Stripe Terminal SDK fails. The SDK's own
 * message ("The command was canceled.", "Already connected to a reader. ...")
 * is written for developers, so it never reaches the screen. The SDK's error
 * CODE does, under the message, so support can act on a phone they can't see;
 * and every failure but an operator's own cancel is reported to Sentry
 * (`tap-to-pay-flow.ts`).
 *
 * The one rule: the card is only said to be uncharged for a failure that
 * happened BEFORE `confirmPaymentIntent` started. From confirm onward the
 * card may have been charged, so those say so and send the operator through
 * Back, which checks the server (`card-closing`) before cash is an option.
 * The phase is checked FIRST, so no code can pull a confirm-time failure
 * onto a "not charged" or "take cash" line.
 *
 * Back is the only button on the error screen, so every line names it.
 */
import type { ErrorCode } from "@stripe/stripe-terminal-react-native";

/** `ErrorCode.CANCELED` in `@stripe/stripe-terminal-react-native` (src/Errors/ErrorCodes.ts). */
export const TERMINAL_CANCELED = "CANCELED" satisfies ErrorCode;
/** `ErrorCode.ALREADY_CONNECTED_TO_READER` (same file). */
export const TERMINAL_ALREADY_CONNECTED =
  "ALREADY_CONNECTED_TO_READER" satisfies ErrorCode;

/**
 * Failures that trying again on this phone can't fix: the device, its
 * environment, the build, or the Stripe account / Location setup. Telling the
 * operator to try again would send them round a loop at the door.
 */
export const TERMINAL_NO_RETRY_CODES: ReadonlySet<string> = new Set([
  "INVALID_CLIENT_SECRET",
  // Not UNSUPPORTED_OPERATION: the iOS bridge maps passing states to it (a
  // phone call in progress, the app in the background, no passcode yet), so
  // it gets the "try again" copy and its Reader code line.
  "UNSUPPORTED_SDK",
  "MISSING_PREREQUISITE",
  "MISSING_REQUIRED_PARAMETER",
  "INVALID_REQUIRED_PARAMETER",
  "TAP_TO_PAY_LIBRARY_NOT_INCLUDED",
  "TAP_TO_PAY_UNSUPPORTED_DEVICE",
  "TAP_TO_PAY_UNSUPPORTED_ANDROID_VERSION",
  "TAP_TO_PAY_DEVICE_TAMPERED",
  "TAP_TO_PAY_INSECURE_ENVIRONMENT",
  "TAP_TO_PAY_DEBUG_NOT_SUPPORTED",
  "TAP_TO_PAY_UNSUPPORTED_PROCESSOR",
  "FEATURE_NOT_ENABLED_ON_ACCOUNT",
  "ANDROID_API_LEVEL_ERROR",
  "TAP_TO_PAY_READER_MERCHANT_BLOCKED",
] satisfies ErrorCode[]);

/** Phone settings the operator can switch on themselves. */
const TERMINAL_SETTING_CODES = {
  TAP_TO_PAY_NFC_DISABLED: "NFC",
  LOCATION_SERVICES_DISABLED: "Location",
} as const satisfies Partial<Record<ErrorCode, string>>;

/** Where in the flow a failure happened, as far as the card is concerned. */
export type TerminalPhase = "before-confirm" | "confirm-or-later";

/** The step of the Tap to Pay sequence a failure came from. */
export type TerminalStep =
  | "setup"
  | "initialize"
  | "reader-check"
  | "discover"
  | "find-reader"
  | "connect"
  | "retrieve"
  | "collect"
  | "confirm"
  | "finalize";

/**
 * The one step where CANCELED is the buyer or operator pressing the reader's
 * X. Elsewhere it is something else (iOS maps a dismissed Tap to Pay terms
 * sheet at connect to CANCELED), so it is a stop, and it is reported.
 */
const READER_CANCEL_STEP: TerminalStep = "collect";

export const READER_CANCELLED_MESSAGE =
  "Payment cancelled on the reader. The card wasn't charged. Press Back to try again or take cash.";
export const READER_STOPPED_MESSAGE =
  "The reader stopped before the card was charged. Press Back to try again or take cash.";
export const READER_UNAVAILABLE_MESSAGE =
  "Tap to Pay can't run on this phone right now. Press Back and take cash, or ask an admin to check the phone and the Tap to Pay setup.";
export const READER_STOPPED_MAYBE_CHARGED_MESSAGE =
  "The reader stopped while confirming the payment. The card may have been charged. Press Back to check before taking cash.";

export function readerSettingMessage(setting: string): string {
  return `${setting} is turned off on this phone, and Tap to Pay needs it. Turn it on in Settings, then press Back to try again or take cash.`;
}

export type TerminalFailure = {
  /** The operator's copy. */
  message: string;
  /** The SDK code shown under the copy ("Reader code: …"), or null. */
  code: string | null;
  /** False only for the reader's X during collect, before confirm. */
  report: boolean;
};

type ErrorLike = { code?: string | null } | null | undefined;

export function describeTerminalFailure(
  error: ErrorLike,
  phase: TerminalPhase,
  step: TerminalStep,
): TerminalFailure {
  const code = error?.code ? error.code : null;
  if (phase === "confirm-or-later") {
    return { message: READER_STOPPED_MAYBE_CHARGED_MESSAGE, code, report: true };
  }
  if (code === TERMINAL_CANCELED && step === READER_CANCEL_STEP) {
    return { message: READER_CANCELLED_MESSAGE, code: null, report: false };
  }
  if (code !== null && Object.hasOwn(TERMINAL_SETTING_CODES, code)) {
    const setting =
      TERMINAL_SETTING_CODES[code as keyof typeof TERMINAL_SETTING_CODES];
    return { message: readerSettingMessage(setting), code, report: true };
  }
  if (code !== null && TERMINAL_NO_RETRY_CODES.has(code)) {
    return { message: READER_UNAVAILABLE_MESSAGE, code, report: true };
  }
  return { message: READER_STOPPED_MESSAGE, code, report: true };
}

/**
 * Whether the native `getConnectedReader()` answer is a reader. It resolves to
 * a reader object, or null / `{ error }` / an empty object when none is
 * connected.
 */
export function isConnectedReader(answer: unknown): boolean {
  if (!answer || typeof answer !== "object") return false;
  if ("error" in answer && (answer as { error?: unknown }).error) return false;
  return Object.keys(answer).length > 0;
}
