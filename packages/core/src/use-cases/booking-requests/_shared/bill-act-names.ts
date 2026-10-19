import type { Repos } from "@th/ports/repos";
import type { BookingRequestActRecord } from "@th/ports/repos/booking-requests";

import {
  billIdentityOf,
  resolveBillIdentities,
  type BillIdentity,
} from "./bill-items";

// ─────────────────────────────────────────────────────────────────────────────
// One act's NAME as the ledger and the bill notices snapshot it
// (lineup-booking-requests v3). Every writer that puts an act's name into a
// `booking_request.*` entry (`act_confirmed`, `act_declined`, `bill_changed`)
// or a notification payload goes through here, so a nameless act reads the
// same everywhere and never fails a `min(1)` schema.
//
// The name is the bill's own identity (`resolveBillIdentities`): a platform
// act's PUBLIC page display name, else its human / org name; a by-name act's
// typed name. Clipped to the ledger bound, never empty.
// ─────────────────────────────────────────────────────────────────────────────

/** The ledger snapshot's bound (`act_confirmed` / `bill_changed` schemas). */
export const BILL_ACT_NAME_MAX_LENGTH = 120;

/**
 * Snapshot name when the act resolves to nothing (a tagged human always had a
 * PUBLIC page at tag time, so this is a deleted / renamed-to-empty edge). The
 * ledger schemas require a non-empty name.
 */
export const BILL_ACT_NAME_FALLBACK = "An artist";

/** Trim + clip a display name to the ledger bound; empty → the fallback. */
export function clipBillActName(name: string | null | undefined): string {
  return (
    (name ?? "").trim().slice(0, BILL_ACT_NAME_MAX_LENGTH).trim() ||
    BILL_ACT_NAME_FALLBACK
  );
}

/** One act's snapshot name out of an already-resolved identity batch. */
export function billActNameOf(
  act: Pick<
    BookingRequestActRecord,
    "source" | "actOwnerType" | "actOwnerId" | "externalName"
  >,
  identities: ReadonlyMap<string, BillIdentity>,
): string {
  return clipBillActName(billIdentityOf(act, identities).displayName);
}

/**
 * Snapshot names for `acts`, keyed by act id — ONE identity batch for all of
 * them (at most four reads, none when every act is by-name).
 */
export async function resolveBillActNames(
  repos: Pick<Repos, "humans" | "organizations" | "entityPages">,
  acts: readonly BookingRequestActRecord[],
): Promise<Map<string, string>> {
  const identities = await resolveBillIdentities(repos, acts);
  return new Map(acts.map((act) => [act.id, billActNameOf(act, identities)]));
}

/** {@link resolveBillActNames} for a single act. */
export async function resolveBillActName(
  repos: Pick<Repos, "humans" | "organizations" | "entityPages">,
  act: BookingRequestActRecord,
): Promise<string> {
  return (await resolveBillActNames(repos, [act])).get(act.id) as string;
}
