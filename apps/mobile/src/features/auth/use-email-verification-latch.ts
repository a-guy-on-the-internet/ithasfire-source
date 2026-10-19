import { useState } from "react";

import { nextVerificationLatch } from "./email-verification-required";

/**
 * True while a screen should show `EmailVerificationPrompt` in place of its
 * content. See `nextVerificationLatch` for why it is sticky: a foreground or
 * pull-to-refresh refetch must not unmount a code entry the user is halfway
 * through. Released when the query answers with anything but the gate; a
 * verify followed by `utils.invalidate()` produces a success.
 *
 * `answered`: the query has settled (`isSuccess || isError`). `gated` is
 * checked first, so a gate error keeps the latch.
 */
export const useEmailVerificationLatch = (query: {
  gated: boolean;
  answered: boolean;
}): boolean => {
  const [latched, setLatched] = useState(false);
  const next = nextVerificationLatch(latched, query);
  // Adjusting state during render (React's documented pattern for state
  // derived from props): the returned value is right on this render, with no
  // frame of the plain loading state in between.
  if (next !== latched) setLatched(next);
  return next;
};
