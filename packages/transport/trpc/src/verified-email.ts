import { TRPCError } from "@trpc/server";
import { ensureEmailVerified } from "@th/core/use-cases/_helpers/ensure-email-verified";

import type { Ctx } from "./context";
import { t } from "./trpc";
import { toTrpcError } from "./utils";

/**
 * The own-orders / own-tickets gate (B2, account squatting through guest
 * checkout, owner ruling 2026-10-16: "forcing some type of account is okay").
 *
 * Password sign-up does not require a verified email, so anyone can hold an
 * UNVERIFIED account under someone else's address. Guest checkout, comps, door
 * sales and volunteer rewards resolve the buyer BY EMAIL
 * (`humans.ensureGuestHuman`), so the real inbox owner's orders and tickets
 * land on that account's Human. The signed-in checkouts refuse an unverified
 * actor (`orders.createCheckout`, `orders.updateOrderItems`,
 * `resale.createCheckout`), so every order an unverified account holds came
 * from someone else. It sees none of them, and can act on none, until it
 * proves the inbox (email code or magic link). Proving it runs the
 * unproven-account sweep in apps/api `better-auth.ts`, which removes the
 * squatter's password and sessions, and the orders are then the prover's.
 *
 * Throws `{ code: "forbidden", message: "email_verification_required" }` (the
 * same error the checkouts throw) as tRPC FORBIDDEN. Chain it AFTER
 * `requireAuth` (`verifiedEmailProcedure` in init.ts does).
 */
export const requireVerifiedEmail = t.middleware(async ({ ctx, next }) => {
  const actorHumanId = ctx.actorHumanId;
  if (!actorHumanId) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "unauthorized" });
  }
  try {
    await ensureEmailVerified(ctx.repos, actorHumanId);
  } catch (err) {
    throw toTrpcError(err);
  }
  return next();
});

/**
 * The same question for AMBIENT reads (navbar next night, cart recovery):
 * those answer with their empty result for an unverified actor instead of
 * throwing, so the page around them still renders. A failing lookup throws;
 * nothing is swallowed.
 */
export async function isActorEmailVerified(
  ctx: Pick<Ctx, "repos">,
  actorHumanId: string,
): Promise<boolean> {
  const result = await ctx.repos.humans.getByIdWithIdentity(actorHumanId);
  return result?.identity.emailVerified === true;
}
