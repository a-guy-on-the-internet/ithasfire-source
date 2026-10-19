import type { Repos } from "@th/ports/repos";
import type { PerformerOwnerType } from "@th/ports/repos/performer-profiles";

/**
 * Guaranteed-non-empty fallback for an act whose name can't be resolved
 * (mirrors the "A performer" posture in notify-booking-request-received —
 * empty strings would fail renderer/template schemas downstream).
 */
export const ACT_NAME_FALLBACK = "Performer";

/**
 * Display name for an ACT (organizer-booking-requests FR-005/FR-006), used
 * for the minted Agreement title ("Booking — {act name}") and the
 * organizer-facing notification copy. Precedence:
 *
 * 1. the act's saved PerformerBookingDefaults.actName (their chosen stage
 *    name for booking surfaces);
 * 2. their entity page displayName;
 * 3. the canonical Human.name / Organization.name;
 * 4. {@link ACT_NAME_FALLBACK}.
 *
 * Every step tolerates missing rows — resolution must never fail the accept.
 */
export async function resolvePerformerActName(
  repos: Pick<
    Repos,
    "performerBookingDefaults" | "entityPages" | "humans" | "organizations"
  >,
  owner: { ownerType: PerformerOwnerType; ownerId: string },
): Promise<string> {
  const defaults = await repos.performerBookingDefaults.getByOwner({
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
  });
  const fromDefaults = defaults?.actName?.trim();
  if (fromDefaults) return fromDefaults;

  const page = await repos.entityPages.getByOwner(
    owner.ownerType === "human" ? "HUMAN" : "ORGANIZATION",
    owner.ownerId,
  );
  const fromPage = page?.displayName?.trim();
  if (fromPage) return fromPage;

  if (owner.ownerType === "human") {
    const human = await repos.humans.getById(owner.ownerId);
    const name = human?.name?.trim();
    if (name) return name;
  } else {
    const org = await repos.organizations.getById(owner.ownerId);
    const name = org?.name?.trim();
    if (name) return name;
  }

  return ACT_NAME_FALLBACK;
}
