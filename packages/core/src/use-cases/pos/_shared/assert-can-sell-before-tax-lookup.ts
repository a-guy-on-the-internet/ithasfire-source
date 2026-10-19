import type { AuthZPort } from "@th/ports/authz";
import type { Repos } from "@th/ports/repos";
import { fail } from "@th/errors";

import {
  ORG_SCAN_ROLES,
  requireScannerAccessOnOrg,
  type ScannerAccessResult,
} from "../../../lib/rbac";
import { assertDoorSellsEvent } from "./door-event-gate";

/**
 * The scanner-role check, on plain (non-transaction) reads, run before the
 * tax lookup so an outsider cannot make the platform pay for one. Only
 * refuses what the transaction would also refuse, with the same codes. A
 * personal event (no org) is refused here too: the door prepare skips the
 * unpublished and event-ended shortcuts, so letting it through would spend a
 * paid lookup on a sale the transaction then refuses. A missing event is left
 * to the transaction; the prepare looks nothing up for it.
 *
 * The door's published-events-only rule (`assertDoorSellsEvent`) is checked
 * here too, after the role, for the same reason.
 *
 * Shared by both door paths (`startPosSale` card, `recordCashSale` cash), so
 * the order "RBAC, then the paid lookup, then the transaction" is one rule.
 *
 * Returns the seller's access (`null` for a missing event), so a
 * TAX_RATE_UNAVAILABLE refusal can say whether this seller may enter the rate
 * by hand (`withManualTaxRateHint`).
 */
export async function assertCanSellBeforeTaxLookup(
  deps: { repos: Repos; authz: AuthZPort },
  input: { eventId: string; actorHumanId: string },
): Promise<ScannerAccessResult | null> {
  const event = await deps.repos.events.getById(input.eventId);
  if (!event) return null;
  if (!event.orgId) {
    throw fail("EVENT_NOT_ORG_OWNED");
  }
  const access = await requireScannerAccessOnOrg({
    repos: deps.repos,
    authz: deps.authz,
    orgId: event.orgId,
    actorHumanId: input.actorHumanId,
    roles: ORG_SCAN_ROLES,
    errorCode: "INSUFFICIENT_ROLE",
  });
  // An unpublished or cancelled event is refused here, so it never pays for
  // a lookup; the transaction re-checks under its lock.
  assertDoorSellsEvent(event);
  return access;
}
