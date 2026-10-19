import type { AuthZPort, HumanRole } from "@th/ports/authz";
import { fail } from "@th/errors";

/**
 * Who may READ the dispute desk: finance/ops admins and support (support
 * fields the buyer's "why was I charged" thread and needs the timeline).
 */
export const DISPUTE_DESK_READ_ROLES: HumanRole[] = ["ADMIN", "SUPPORT"];

/**
 * Who may CHANGE a package (edit / approve / submit / re-assemble): ADMIN
 * only. Submitting evidence is irreversible at the processor and speaks for
 * the merchant of record, so it stays with the narrowest platform role —
 * the same posture as fee waivers (`platform/fee-waivers.ts`).
 */
export const DISPUTE_DESK_WRITE_ROLES: HumanRole[] = ["ADMIN"];

export type DisputeDeskAuthzDeps = {
  authz: Pick<AuthZPort, "hasStaffRole">;
};

/**
 * Enforced INSIDE every desk use case (not only at the transport), mirroring
 * `requireStaff` in `platform/fee-waivers.ts`: the transport's
 * `requireStaffActor` only checks that an actor exists. Throws STAFF_ONLY.
 */
export async function requireDisputeDeskStaff(
  deps: DisputeDeskAuthzDeps,
  actorHumanId: string,
  access: "read" | "write",
): Promise<void> {
  const staffCheck = await deps.authz.hasStaffRole({
    actorHumanId,
    requiredRoles:
      access === "write" ? DISPUTE_DESK_WRITE_ROLES : DISPUTE_DESK_READ_ROLES,
  });
  if (!staffCheck.allowed) {
    throw fail("STAFF_ONLY");
  }
}
