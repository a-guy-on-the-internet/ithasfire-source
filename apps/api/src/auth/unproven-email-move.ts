import { APIError } from "better-auth/api";

import {
  holdsEmailAttachedRowsInDb,
  type EmailAttachedRowsDb,
} from "@th/adapters/db/prisma/email-attached-rows";

/**
 * AN UNVERIFIED ACCOUNT THAT HOLDS EMAIL-ATTACHED ROWS CANNOT MOVE ITS ADDRESS (B2,
 * account squatting through guest checkout, owner ruling 2026-10-16).
 *
 * Password sign-up does not require a verified email, so anyone can open an
 * unverified account under someone else's address. Guest checkout, comps,
 * door sales and volunteer rewards resolve the buyer BY EMAIL, so the real
 * inbox owner's orders and tickets land on that account's Human, and the
 * own-orders surfaces hide them until the account proves the inbox
 * (tRPC `verifiedEmailProcedure`).
 *
 * The email change is the way round that: `/email-otp/change-email` proves
 * the NEW address and writes `{ email: new, emailVerified: true }` onto the
 * same AuthUser (better-auth 1.6.9 `plugins/email-otp/routes.mjs`). It is not
 * an email-proof sign-in, so the unproven-account sweep does not run, and the
 * squatter's own inbox would turn the account verified with the victim's
 * orders still on it.
 *
 * So an unverified account that holds anything attached BY EMAIL must prove
 * its CURRENT address (email code or magic link, which runs the sweep) before
 * it can change it. Such an account cannot have earned those rows itself (the
 * signed-in checkouts and coordinator surfaces refuse an unverified actor), so
 * a legitimate holder loses nothing: they verify the address the rows were
 * sent to. The typo fix on a fresh unverified account (`VerifyEmailCard`)
 * holds nothing and is unaffected.
 *
 * WHAT COUNTS AS "ATTACHED BY EMAIL". Every path that resolves a Human from a
 * typed address (`ensureGuestHuman` / `ensureGuestHumanKeepingName`) and then
 * writes a row onto an EXISTING Human:
 *
 *   - Order.buyerHumanId: embed guest checkout, comps, door sales, volunteer
 *     rewards (all buy on the inbox owner's behalf).
 *   - Ticket.ownerHumanId: the tickets those orders issue.
 *   - VolunteerGroup.coordinatorHumanId: `assignGroupCoordinator` by
 *     coordinatorEmail seats an existing account as coordinator, which opens
 *     the roster (contact details of other volunteers) to it.
 *   - EventHuman.humanId: `inviteLineupHumanToRegister` links a lineup row to
 *     the account that owns the invited address.
 *
 * Excluded, because no email-resolved path attaches them to an existing
 * Human:
 *
 *   - VolunteerSignup.humanId: an anonymous signup whose address already has
 *     a Human is stored CONTACT-ONLY (humanId null, `resolveSignupHuman`).
 *   - BookingRequest performer owner: `notifyBookingInquirer` attaches only a
 *     Human the same call minted (`ensured.created`).
 *   - Pending email transfers: keyed by recipient address, not a Human. The
 *     ticket moves only when a signed-in, VERIFIED account claims it
 *     (`claimPendingTransfer` calls `ensureEmailVerified`); after that the
 *     moved Ticket row is what this check sees.
 *
 * A new email-resolved attach path must add its table to the query, which
 * lives in `packages/adapters/src/db/prisma/email-attached-rows.ts` and is
 * shared with the staff force-verify refusal (`adminForceVerifyEmail`).
 *
 * Lookups fail closed: an error propagates and the change does not happen.
 */

export const VERIFY_CURRENT_EMAIL_FIRST = {
  code: "VERIFY_CURRENT_EMAIL_FIRST",
  message: "Verify your current email address before changing it.",
} as const;

/** The Better Auth endpoint that writes a new, verified address. */
export const CHANGE_EMAIL_PATH = "/email-otp/change-email";

export type UnprovenEmailMoveLookup = {
  /** The AuthUser's own verification flag and linked Human. */
  loadAuthUser(
    authUserId: string,
  ): Promise<{ emailVerified: boolean; humanId: string | null } | null>;
  /**
   * Whether the Human holds any row an email-resolved path can attach to an
   * existing account: an order, a ticket, a coordinator seat or a lineup link.
   */
  holdsEmailAttachedRows(humanId: string): Promise<boolean>;
};

/** True when this account may not change its address yet. */
export async function isUnprovenEmailMoveRefused(
  lookup: UnprovenEmailMoveLookup,
  authUserId: string,
): Promise<boolean> {
  const authUser = await lookup.loadAuthUser(authUserId);
  if (!authUser) return false;
  if (authUser.emailVerified) return false;
  if (!authUser.humanId) return false;
  return lookup.holdsEmailAttachedRows(authUser.humanId);
}

type PrismaForLookup = EmailAttachedRowsDb & {
  authUser: {
    findUnique(args: {
      where: { id: string };
      select: { emailVerified: true; humanId: true };
    }): Promise<{ emailVerified: boolean; humanId: string | null } | null>;
  };
};

export function prismaUnprovenEmailMoveLookup(
  db: PrismaForLookup,
): UnprovenEmailMoveLookup {
  return {
    loadAuthUser: (authUserId) =>
      db.authUser.findUnique({
        where: { id: authUserId },
        select: { emailVerified: true, humanId: true },
      }),
    // The same query backs the force-verify refusal (HumansRepo
    // .holdsEmailAttachedRows), so the two cannot drift.
    holdsEmailAttachedRows: (humanId) =>
      holdsEmailAttachedRowsInDb(db, humanId),
  };
}

/** The signed-in AuthUser id of a Better Auth hook context, if any. */
function sessionAuthUserId(ctx: unknown): string | null {
  const id = (
    ctx as { context?: { session?: { user?: { id?: unknown } } | null } } | null
  )?.context?.session?.user?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * For `user.update.before`. On `/email-otp/change-email` (which sets the new
 * address), refuses an unverified account that holds email-attached rows with
 * 403 VERIFY_CURRENT_EMAIL_FIRST. This is the authoritative check: the code
 * may have been requested before a row attached. Any other path passes.
 */
export async function refuseUnprovenEmailMove(
  lookup: UnprovenEmailMoveLookup,
  path: string | undefined,
  ctx: unknown,
): Promise<void> {
  if (path !== CHANGE_EMAIL_PATH) return;
  const authUserId = sessionAuthUserId(ctx);
  // The endpoint runs behind Better Auth's session middleware; no session
  // here means we cannot tell whose address moves, so refuse.
  if (!authUserId || (await isUnprovenEmailMoveRefused(lookup, authUserId))) {
    throw new APIError("FORBIDDEN", { ...VERIFY_CURRENT_EMAIL_FIRST });
  }
}
