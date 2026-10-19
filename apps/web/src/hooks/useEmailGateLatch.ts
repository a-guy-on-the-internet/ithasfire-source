"use client";

import { useState } from "react";

import { isEmailVerificationRequired } from "@/lib/email-verification-required";

/**
 * Whether a gated query is behind the B2 email gate, held steady across
 * refetches.
 *
 * A refetch of an errored query with no data resets it to pending with
 * `error: null` (react-query's fetch reducer). Read raw, that unmounted the
 * prompt and the open code card whenever the user came back from their mail
 * tab (focus refetch), and the remount offered "Email me a code" again,
 * which mails a new code over the one they hold. So once the gate is seen it
 * stays until the query succeeds or fails for some other reason.
 *
 * The focus refetch itself is kept: if the email was verified elsewhere (a
 * magic link in another tab), returning to the page shows the content.
 */
export function useEmailGateLatch(query: {
  error: unknown;
  isSuccess: boolean;
}): boolean {
  const gatedNow = isEmailVerificationRequired(query.error);
  const otherError = query.error != null && !gatedNow;
  const [latched, setLatched] = useState(false);

  // Derived-state update during render (React's documented pattern for
  // "information from previous renders"): an effect would commit one frame
  // of the loading state first, which is exactly the unmount to avoid.
  if (gatedNow && !latched) setLatched(true);
  if (latched && (query.isSuccess || otherError)) setLatched(false);

  return gatedNow || (latched && !query.isSuccess && !otherError);
}
