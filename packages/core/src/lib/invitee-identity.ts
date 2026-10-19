import type { HumansRepo } from "@th/ports/repos/humans";
import { fail } from "@th/errors";

/** Canonical form for comparing an account email with an invited email. */
export function normalizeInviteEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * The shared consent gate for every emailed/shared invitation (org invites,
 * delegate links): the SIGNED-IN account must own the invited address, and
 * must have verified it. A token alone is not enough — otherwise anyone who
 * obtains a link (forwarded, or minted by an attacker for their own address
 * and lured onto a victim's session) is enrolled as whoever is signed in.
 *
 * Both failures use codes the web accept pages already map:
 *  - mismatch → INVITATION_NOT_FOUND with a "different email" message (the
 *    invited address itself is never echoed);
 *  - unverified → EMAIL_NOT_VERIFIED.
 */
export async function requireInvitedIdentity(
  humans: Pick<HumansRepo, "getByIdWithIdentity">,
  actorHumanId: string,
  invitedEmail: string,
): Promise<void> {
  const actor = await humans.getByIdWithIdentity(actorHumanId);
  if (
    !actor ||
    normalizeInviteEmail(actor.identity.email) !==
      normalizeInviteEmail(invitedEmail)
  ) {
    throw fail("INVITATION_NOT_FOUND", {
      message:
        "This invitation was sent to a different email address. Sign in with the address it was sent to.",
    });
  }
  if (!actor.identity.emailVerified) {
    throw fail("EMAIL_NOT_VERIFIED");
  }
}
