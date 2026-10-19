import type { SupportThreadStaffDto } from "@th/core/use-cases/support";

/**
 * Resolved identity for a support thread's attendee, ready for display in the
 * operator inbox. Mirrors the platform-orders buyer rendering: a bold primary
 * line plus a muted secondary line, falling back to a shortened id only when
 * neither name nor email is known.
 *
 * `primary` / `secondary` carry display strings; `isFallback` is true when we
 * could only show a shortened id (both name + email were null). Callers pass
 * resolved i18n strings for the fallback to keep this module locale-agnostic.
 */
export interface ThreadIdentity {
  primary: string;
  secondary: string | null;
  isFallback: boolean;
}

export function resolveThreadIdentity(
  thread: Pick<SupportThreadStaffDto, "humanId" | "humanDisplayName" | "humanEmail">,
  labels: { unknown: string; fallback: (idFragment: string) => string },
): ThreadIdentity {
  const name = thread.humanDisplayName?.trim() || null;
  const email = thread.humanEmail?.trim() || null;

  if (name) {
    return { primary: name, secondary: email, isFallback: false };
  }
  if (email) {
    return { primary: email, secondary: null, isFallback: false };
  }
  // humanId is nullable: a GDPR/CCPA-erased owner leaves an owner-less thread
  // with null name/email AND a null humanId. With no id fragment to render, fall
  // back to the generic "unknown" label instead of crashing on null.
  const idFragment = thread.humanId?.slice(0, 8) ?? null;
  return {
    primary: idFragment
      ? labels.fallback(idFragment) || labels.unknown
      : labels.unknown,
    secondary: null,
    isFallback: true,
  };
}
