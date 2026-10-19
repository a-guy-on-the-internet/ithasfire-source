import type { AuthZPort, HumanRole } from "@th/ports/authz";

import { requirePlatformStaff } from "../../lib/rbac";

/**
 * Who works the resale-claims desk (`/platform/claims`): the platform roles
 * allowed to list ANY claim, read ANY claim, and review (approve / deny) one.
 *
 * ADMIN + SUPPORT, for the same reason `staffRefundOrder`
 * (`use-cases/orders/staff-refund-order.ts`) uses exactly this pair: approving
 * a claim moves a refund through the payments port, and support is the desk
 * that fields the buyer's "my resale ticket didn't work" thread. The
 * `/platform` nav entry for the claims desk mirrors this set — keep them
 * reconciled (`apps/web/src/app/platform/_components/platform-nav-sections.tsx`).
 *
 * Read and review share ONE set on purpose: this desk has no read-only
 * audience today. Split it (see `DISPUTE_DESK_READ_ROLES` /
 * `DISPUTE_DESK_WRITE_ROLES`) the day one appears — do not widen this one.
 */
export const CLAIM_DESK_ROLES: readonly HumanRole[] = ["ADMIN", "SUPPORT"];

export type ClaimDeskAuthzDeps = {
  authz: Pick<AuthZPort, "hasStaffRole">;
};

/**
 * Non-throwing probe: is the actor claim-desk staff? Used where staff is one
 * of several ways in (the claim's own buyer/seller, an event's org member).
 */
export async function isClaimDeskStaff(
  deps: ClaimDeskAuthzDeps,
  actorHumanId: string,
): Promise<boolean> {
  const result = await deps.authz.hasStaffRole({
    actorHumanId,
    requiredRoles: [...CLAIM_DESK_ROLES],
  });
  return result.allowed;
}

/**
 * Throwing gate, enforced INSIDE the use case (the transport only proves an
 * actor exists). Throws `STAFF_ONLY` (→ tRPC FORBIDDEN) — the same code every
 * other staff-only use case throws. `claims.*` is mounted at the root router,
 * NOT under `platform.*`, so it does not inherit the second-factor gate; this
 * check is the only thing between a signed-in user and the desk.
 */
export async function requireClaimDeskStaff(
  deps: ClaimDeskAuthzDeps,
  actorHumanId: string,
): Promise<void> {
  await requirePlatformStaff({
    authz: deps.authz,
    actorHumanId,
    roles: CLAIM_DESK_ROLES,
  });
}
