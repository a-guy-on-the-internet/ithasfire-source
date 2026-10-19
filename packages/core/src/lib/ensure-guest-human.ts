import type { HumansRepo } from "@th/ports/repos/humans";

/**
 * Resolve-or-create a shadow guest Human by email WITHOUT ever renaming an
 * existing account.
 *
 * `HumansRepo.ensureGuestHuman` resolves by EMAIL. It used to OVERWRITE an
 * existing account's `name` with whatever name was passed; every caller here
 * gets the name from someone other than the account holder (a guest form, an
 * organiser, an owner), so that let a stranger rename a real account just by
 * typing its email. The adapter no longer renames (B2, 2026-10-16); this
 * wrapper keeps the guarantee at the call site as well.
 *
 * This wrapper never passes `name` to the repo, and applies it ONLY on the
 * branch where this very call minted the Human (there is nothing to clobber).
 * Same pattern as `notify-booking-inquirer.ts`.
 *
 * Works with the tx-scoped repo (`tx.humans`) or the root one; the name write
 * joins whatever transaction the repo is bound to.
 */
export async function ensureGuestHumanKeepingName(
  humans: Pick<HumansRepo, "ensureGuestHuman" | "update">,
  input: { email: string; name?: string | null },
): Promise<{ humanId: string; created: boolean }> {
  const result = await humans.ensureGuestHuman({ email: input.email });
  const name = input.name?.trim();
  if (result.created && name) {
    await humans.update(result.humanId, { name });
  }
  return result;
}
