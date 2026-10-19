import { TRPCError } from "@trpc/server";
import type { Ctx } from "../context";

/**
 * The actor for a request that carries an API key, as the key gate
 * (`./gate.ts`) left it. `guard.ts`'s `resolveActorHumanId` calls this instead
 * of resolving the key a second time (NFR-003: one key query per request).
 *
 * - Holder id: an ORG, PERSONAL or STAFF key, and a legacy key.
 * - null: a PLATFORM_WIDE key, which runs as a signed-out visitor (FR-007).
 *
 * Fails closed when the gate did not run (a chain built without it): the key
 * is then treated as no credential at all, never as its holder's session.
 * `optionalAuth` reads that as anonymous, `requireAuth` as UNAUTHORIZED.
 */
export function actorFromApiKeyGate(
  ctx: Pick<Ctx, "keyScope" | "actorHumanId">,
): string | null {
  if (!ctx.keyScope) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "unauthorized: API key gate did not run",
    });
  }
  return ctx.actorHumanId;
}

/**
 * For `apiKeys.renewSelf` (step 5) alone: the calling key and its holder. Set
 * by the gate only on the `selfRenewal`-tagged path, so the holder id of a
 * PLATFORM_WIDE key reaches no other procedure (FR-007, FR-009).
 */
export function requireKeySelfRenewal(
  ctx: Pick<Ctx, "keySelfRenewal">,
): { keyId: string; holderHumanId: string } {
  if (!ctx.keySelfRenewal) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "API_KEY_SCOPE: only an API key may renew itself",
    });
  }
  return ctx.keySelfRenewal;
}
