import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { fail } from "@th/errors";

import { parseInput } from "../../../lib/io";
import {
  INVITE_OPT_OUT_TOKEN_MAX_LENGTH,
  type InviteOptOutClaims,
  verifyInviteOptOutToken,
} from "../../../lib/security/invite-optout-token";

/**
 * "Stop invites from this organiser" (gated-event invite links, owner
 * ruling 2026-10-05). Every invite email carries a signed opt-out token for
 * (organiser, recipient address) in its footer link and its
 * List-Unsubscribe header. Public: no authz, the token is the credential,
 * and all it can do is opt that one address out of that one organiser.
 *
 *  - {@link peekInviteOptOut}: READ-ONLY, for the confirmation page (a GET
 *    page must never change state: link scanners prefetch). Returns the
 *    organiser's display name, or INVALID.
 *  - {@link optOutOfOrganiserInvites}: records the opt-out. Idempotent. Used
 *    by the page's confirm button and by the RFC 8058 one-click POST (which
 *    stays organiser-scoped: a mail client's Unsubscribe means "this
 *    sender").
 *  - {@link optOutOfAllInvites}: "Stop all event invites" (owner ruling
 *    3(b), 2026-10-06), the page's second, smaller choice. Same token, no
 *    account, idempotent; covers every organiser. Works even when the
 *    token's organiser has since been deleted (peek then reports
 *    `organiserGone`, and the per-organiser stop answers INVALID).
 *
 * All three report `alreadyStopped`, read for the token's OWN address only:
 * "ALL" when it had stopped every organiser, "ORGANISER" when only this one,
 * else null. For the two writes it is the state BEFORE this call, so a
 * second tap can say "You'd already stopped invites from {organiser}."
 *
 * Opt-outs only block SENDING new invites: invites already sent keep
 * working (redeem and peek-invite never read them). None of these echoes
 * the address: whoever holds the link already knows it, and a response is
 * no place to repeat it.
 */

export const inviteOptOutInputSchema = z
  .object({
    token: z.string().min(1).max(INVITE_OPT_OUT_TOKEN_MAX_LENGTH),
  })
  .strict();

export const inviteOptOutOutputSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      /**
       * Org name, or the owning person's name; null if it has none or is
       * gone.
       */
      organiserName: z.string().nullable(),
      /**
       * The token's organiser no longer exists (the token itself verified).
       * Only peek and stop-all answer ok for this; the page then offers only
       * "Stop all event invites".
       */
      organiserGone: z.boolean(),
      /**
       * What already covered the token's address before this call (peek:
       * what covers it now). Never about any other address.
       */
      alreadyStopped: z.enum(["ORGANISER", "ALL"]).nullable(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      /**
       * Forged or malformed; for the per-organiser stop also "the organiser
       * no longer exists" (it would never mail again).
       */
      reason: z.literal("INVALID"),
    })
    .strict(),
]);

export type InviteOptOutInput = z.infer<typeof inviteOptOutInputSchema>;
export type InviteOptOutOutput = z.infer<typeof inviteOptOutOutputSchema>;

export type InviteOptOutDeps = {
  repos: Pick<Repos, "organizations" | "humans" | "eventInviteOptOuts">;
  /** HKDF-derived opt-out key (`deriveInviteOptOutSecret`). */
  inviteOptOutSecret: string;
  clock?: ClockPort;
  logger?: LoggerPort;
};

const INVALID: InviteOptOutOutput = { ok: false, reason: "INVALID" };

/**
 * Verify the token, then look up its organiser. Null only when the token is
 * bad: the MAC alone proves the (organiser, address hash) pair. `gone` when
 * the organiser no longer exists (a deleted org takes its own opt-outs with
 * it, CASCADE, and sends nothing anyway); callers decide what that means.
 */
async function resolve(
  deps: InviteOptOutDeps,
  token: string,
): Promise<{
  claims: InviteOptOutClaims;
  organiserName: string | null;
  gone: boolean;
} | null> {
  if (!deps.inviteOptOutSecret) {
    throw fail("NOT_CONFIGURED", { message: "invite_opt_out_secret_missing" });
  }
  const claims = verifyInviteOptOutToken(token, deps.inviteOptOutSecret);
  if (!claims) return null;
  const organiser =
    claims.owner.kind === "ORG"
      ? await deps.repos.organizations.getById(claims.owner.orgId)
      : await deps.repos.humans.getById(claims.owner.humanId);
  return organiser
    ? { claims, organiserName: organiser.name ?? null, gone: false }
    : { claims, organiserName: null, gone: true };
}

/** The organiser, for log metadata; never the address. */
function organiserMetadata(claims: InviteOptOutClaims) {
  return claims.owner.kind === "ORG"
    ? { orgId: claims.owner.orgId }
    : { humanOwnerId: claims.owner.humanId };
}

export async function peekInviteOptOut(
  deps: InviteOptOutDeps,
  rawInput: unknown,
): Promise<InviteOptOutOutput> {
  const input = parseInput(inviteOptOutInputSchema, rawInput);
  const resolved = await resolve(deps, input.token);
  if (!resolved) return INVALID;
  // Read-only: a GET page calls this and link scanners prefetch.
  const alreadyStopped = await deps.repos.eventInviteOptOuts.standing({
    owner: resolved.claims.owner,
    emailHash: resolved.claims.emailHash,
  });
  return inviteOptOutOutputSchema.parse({
    ok: true,
    organiserName: resolved.organiserName,
    organiserGone: resolved.gone,
    alreadyStopped,
  });
}

export async function optOutOfOrganiserInvites(
  deps: InviteOptOutDeps,
  rawInput: unknown,
): Promise<InviteOptOutOutput> {
  const input = parseInput(inviteOptOutInputSchema, rawInput);
  const resolved = await resolve(deps, input.token);
  // A gone organiser will never mail again: nothing to stop (and its row
  // could not be stored, the owner FK is gone).
  if (!resolved || resolved.gone) {
    deps.logger?.info("event_gate", {
      category: "event_gate",
      action: "invite_opt_out",
      result: "invalid",
    });
    return INVALID;
  }
  const { claims } = resolved;
  const before = await deps.repos.eventInviteOptOuts.standing({
    owner: claims.owner,
    emailHash: claims.emailHash,
  });
  // Recorded even under a stop-all, so this organiser's opt-out stands on
  // its own.
  const { created } = await deps.repos.eventInviteOptOuts.add({
    owner: claims.owner,
    emailHash: claims.emailHash,
  });
  // A double tap racing past `standing` still says "already" on the loser.
  const alreadyStopped = before ?? (created ? null : "ORGANISER");
  deps.logger?.info("event_gate", {
    category: "event_gate",
    action: "invite_opt_out",
    result: "success",
    // The organiser only; never the address.
    metadata: organiserMetadata(claims),
  });
  return inviteOptOutOutputSchema.parse({
    ok: true,
    organiserName: resolved.organiserName,
    organiserGone: false,
    alreadyStopped,
  });
}

/**
 * "Stop all event invites": no organiser may send this address a new
 * invite. Only the token's MAC is required: it proves the address hash, and
 * the ownerless row needs no organiser. The organiser named in the token
 * (the email it came from) is looked up for its name only; if it is gone
 * this still succeeds, with `organiserName: null, organiserGone: true`.
 */
export async function optOutOfAllInvites(
  deps: InviteOptOutDeps,
  rawInput: unknown,
): Promise<InviteOptOutOutput> {
  const input = parseInput(inviteOptOutInputSchema, rawInput);
  const resolved = await resolve(deps, input.token);
  if (!resolved) {
    deps.logger?.info("event_gate", {
      category: "event_gate",
      action: "invite_opt_out_all",
      result: "invalid",
    });
    return INVALID;
  }
  const { claims } = resolved;
  const { created } = await deps.repos.eventInviteOptOuts.addForAllOrganisers({
    emailHash: claims.emailHash,
  });
  deps.logger?.info("event_gate", {
    category: "event_gate",
    action: "invite_opt_out_all",
    result: "success",
    // The organiser whose email carried the link; never the address.
    metadata: organiserMetadata(claims),
  });
  return inviteOptOutOutputSchema.parse({
    ok: true,
    organiserName: resolved.organiserName,
    organiserGone: resolved.gone,
    alreadyStopped: created ? null : "ALL",
  });
}
