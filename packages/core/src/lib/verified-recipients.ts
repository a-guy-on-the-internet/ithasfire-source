import type { HumansRepo } from "@th/ports/repos/humans";

/**
 * B2 (account squatting through guest checkout, owner ruling 2026-10-16).
 *
 * Guest checkout, comps, door sales, volunteer rewards, coordinator seats by
 * address and lineup invites resolve a Human BY EMAIL, so an account whose
 * email is unverified may be one someone opened under another person's
 * address. A notice still goes to that address's INBOX (the real owner reads
 * it), but in-app, push and SMS reach whoever is signed in, or whose phone is
 * on the account, so they go only to accounts that proved their inbox.
 */

/** `notify` channels for a recipient whose account has not proved its inbox. */
export const EMAIL_ONLY_CHANNELS = {
  inApp: { enabled: false },
  push: { enabled: false },
  sms: { enabled: false },
} as const;

/**
 * The subset of `humanIds` whose account email is verified.
 *
 * Best-effort, failing to the safe side: a lookup error returns an EMPTY set
 * (every recipient gets email only) and calls `onLookupFailed`, where the
 * caller ERROR-logs and reports through its guarded `reportError`. A throwing
 * `onLookupFailed` never changes the result.
 */
export async function loadVerifiedRecipientIds(args: {
  humans: Pick<HumansRepo, "listEmailVerifiedIds">;
  humanIds: readonly string[];
  onLookupFailed: (error: unknown) => void;
}): Promise<ReadonlySet<string>> {
  const ids = [...new Set(args.humanIds)];
  if (ids.length === 0) return new Set();
  try {
    return new Set(await args.humans.listEmailVerifiedIds(ids));
  } catch (error) {
    try {
      args.onLookupFailed(error);
    } catch {
      // best-effort only
    }
    return new Set();
  }
}

/** The channels override for one recipient: none when verified. */
export function channelsForRecipient(
  verified: ReadonlySet<string>,
  humanId: string,
): { channels?: typeof EMAIL_ONLY_CHANNELS } {
  return verified.has(humanId) ? {} : { channels: EMAIL_ONLY_CHANNELS };
}
