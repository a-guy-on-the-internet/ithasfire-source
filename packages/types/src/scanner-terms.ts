export type ScannerTerms = {
  title: string;
  bullets: string[];
  confirmLabel: string;
};

/**
 * The seller terms an operator must accept before taking their first payment.
 *
 * ONE version serves EVERY selling surface — the scanner app's Tap to Pay, the
 * web box office driving a countertop reader, and cash or comp at either. That
 * is deliberate and it is the constraint that shapes the copy: the version
 * string is what makes an acknowledgement valid, so if two surfaces showed
 * different text under one version, people would have agreed to different
 * things and the stored record could not say which. Copy that only makes sense
 * on one device is therefore a bug, not a wording preference.
 *
 * Old versions stay in this map. They are the text a past acknowledgement
 * actually refers to, and deleting one would leave those records pointing at
 * nothing.
 */
export const SCANNER_TERMS_VERSION = "2";

export const SCANNER_TERMS_TEXT: Record<string, ScannerTerms> = {
  /**
   * v1 — scanner-app only, and it shows. Every bullet but one named the phone:
   * "Tap to Pay", "the device", "the app". When the web box office shipped,
   * an operator running a countertop reader from a laptop was asked to agree
   * to rules about a payment method they were not using, in an app they were
   * not in. Superseded by v2; kept because acknowledgements referencing "1"
   * are records of THIS text.
   */
  "1": {
    title: "Before you take your first payment",
    bullets: [
      "Tap to Pay is in your user account name — sign out when you hand the device off.",
      "If the device is lost or stolen, tell your event organizer and Ithas Fire immediately.",
      "Refunds always go through the app — never refund in cash.",
      "Do not photograph or copy card numbers, PINs, or expiration dates.",
    ],
    confirmLabel: "Got it",
  },

  /**
   * v2 — surface-neutral. Says the same four things as v1 and none of them
   * assume a phone, a card reader, or a particular tender:
   *
   *   1. Sales are attributed to YOU, so handing over the till means signing
   *      out first. (v1 said "Tap to Pay is in your user account name", which
   *      is meaningless on a browser.)
   *   2. Report a lost device. Unchanged in substance; "device" now covers a
   *      door tablet and a laptop as well as a phone.
   *   3. Never hand cash back for a card payment. v1's "refunds always go
   *      through the app" was both wrong on the web and confusing at a cash
   *      door, where a refund IS cash. The rule that actually matters is the
   *      one about not settling a card sale out of the drawer.
   *   4. Never copy card details. Unchanged.
   */
  "2": {
    title: "Before you take your first payment",
    bullets: [
      "Every sale you take is recorded under your account. Sign out before you hand the till to someone else.",
      "If the device you sell on is lost or stolen, tell your organiser and Ithas Fire straight away.",
      "Never hand back cash for a card payment. Card refunds go through Ithas Fire.",
      "Never photograph, copy or write down card numbers, PINs or expiry dates.",
    ],
    confirmLabel: "Got it",
  },
};
