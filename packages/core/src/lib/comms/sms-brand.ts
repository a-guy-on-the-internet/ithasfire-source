/**
 * Every notification text opens with the brand, so the person (and the
 * carrier, who expects it on a registered campaign) knows who sent it.
 * Passcode texts already open with the product name and do not take this.
 * ASCII only, so it never pushes a body out of GSM-7.
 */
export const SMS_BRAND_PREFIX = "Ithas Fire: ";
