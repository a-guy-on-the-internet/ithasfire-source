import { getSignInUrl } from "@/lib/auth/urls";
import { appendRedirectParam } from "@/lib/redirect";

// `formatAuthErrorMessage` + `isWebAuthnCancel` now live in `@th/errors` so
// web, scanner, and mobile share one implementation. `formatAuthErrorMessage`
// already falls back to the exact `defaultErrorMessage` string below, so this
// re-export is behaviour-preserving for every existing caller.
export { formatAuthErrorMessage, isWebAuthnCancel } from "@th/errors";

export const defaultErrorMessage =
  "We couldn't complete that action. Double-check your details and try again.";
export const DEFAULT_POST_AUTH_PATH = "/";

export const buildDestination = (redirectPath: string | null): string => {
  const baseDestination = getSignInUrl();
  return appendRedirectParam(baseDestination, redirectPath);
};

export const resolvePostAuthDestination = (
  redirectPath: string | null,
): string => {
  return redirectPath ?? DEFAULT_POST_AUTH_PATH;
};
