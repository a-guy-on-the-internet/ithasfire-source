/**
 * The organizer chargeback-terms gate, as seen from the client.
 *
 * `chargeback_terms_required` is thrown by the core gate
 * (`packages/core/src/lib/payments/chargeback-terms.ts`) from three places:
 * the STRICT current-version gate on `stripeConnect.initiateOnboarding`, and
 * the version-agnostic backstops on publish and checkout. The payments page
 * and the event builder both branch on it, so the detector lives here rather
 * than in either route's private `_components`.
 */

export const CHARGEBACK_TERMS_REQUIRED_CODE = "chargeback_terms_required";

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error ?? "");
};

export const isChargebackTermsRequiredError = (error: unknown): boolean => {
  const message = getErrorMessage(error);
  return (
    message === CHARGEBACK_TERMS_REQUIRED_CODE ||
    String(error).includes(CHARGEBACK_TERMS_REQUIRED_CODE)
  );
};
