import type { PerformerProfileRecord } from "@th/ports/repos/performer-profiles";

/**
 * THE single performer-mode predicate (performer-mode.spec.yaml FR-002).
 *
 * An entity is a performer iff it has a PerformerProfile that was explicitly
 * enabled and not since disabled. Nothing in the app may infer performer
 * status from `Human.jobs[]` / `genreTags[]` — those are profile *content*.
 */
export function isPerformerEnabled(
  profile: Pick<PerformerProfileRecord, "enabledAt" | "disabledAt"> | null,
): boolean {
  return (
    profile !== null &&
    profile.enabledAt !== null &&
    profile.disabledAt === null
  );
}
