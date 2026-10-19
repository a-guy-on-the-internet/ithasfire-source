import { fail, isAppError } from "@th/errors";

import { ORG_EDIT_ROLES, type ScannerAccessResult } from "../../../lib/rbac";

/**
 * Whether this door seller may enter the event's tax rate by hand
 * (`setManualEventTaxRate`): an Owner, Admin or Editor of the event's org by
 * membership (owner ruling R5). A Scanner may not, and neither may platform
 * staff selling through the admin override — the rate is the org's call.
 */
export function canEnterManualTaxRate(
  access: ScannerAccessResult | null,
): boolean {
  return access?.via === "membership" && ORG_EDIT_ROLES.includes(access.role);
}

/**
 * Run the door's tax prepare; a TAX_RATE_UNAVAILABLE refusal is rethrown
 * with `meta.canEnterManualTaxRate`, so the Sell screen can offer "Enter tax
 * rate" to an Editor and tell a Scanner that an Editor is needed (FR-007).
 * The refusal was already reported where it was raised; nothing else is
 * touched.
 */
export async function withManualTaxRateHint<T>(
  access: ScannerAccessResult | null,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (isAppError(err) && err.code === "TAX_RATE_UNAVAILABLE") {
      fail("TAX_RATE_UNAVAILABLE", {
        message: err.message,
        cause: err.cause,
        meta: {
          ...(err.meta ?? {}),
          canEnterManualTaxRate: canEnterManualTaxRate(access),
        },
      });
    }
    throw err;
  }
}
