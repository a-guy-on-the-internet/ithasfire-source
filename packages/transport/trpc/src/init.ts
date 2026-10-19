export {
  createContextFactory,
  type CreateContextInput,
  type Ctx,
  type HeadersLike,
  type ViewerLocation,
  type ViewerLocationSource,
  type RequestAuth,
  type TrpcDeps,
} from "./context";

export { router, proc, timingMiddleware } from "./trpc";
export {
  publicOnly,
  optionalAuth,
  requireAuth,
  rateLimit,
  requireStaffSecondFactor,
} from "./guard";
export type { RateLimitOpts } from "./guard";

import {
  proc as baseProcedure,
  timingMiddleware,
  bumpPublicReadsAfterActorMutation,
} from "./trpc";
import {
  publicOnly as publicOnlyMiddleware,
  optionalAuth as optionalAuthMiddleware,
  requireAuth as requireAuthMiddleware,
  defaultRateLimit as defaultRateLimitMiddleware,
  requireStaffSecondFactor as requireStaffSecondFactorMiddleware,
} from "./guard";
import { apiKeyGate } from "./key-scope/gate";
import { requireVerifiedEmail } from "./verified-email";

// The API-key gate (key-scope/gate.ts) runs right after timing in all three
// chains, BEFORE auth: it resolves a key once, applies the FR-008 denylist
// and the procedure's `key` tag (default deny), narrows `ctx.authz` to the
// key, and sets the actor auth then reuses. No-op for a request without a key.
export const apiKeyGateNoActor = apiKeyGate({ resolvesActor: false });
export const apiKeyGateWithActor = apiKeyGate({ resolvesActor: true });

// Every procedure gets a conservative default rate-limit floor (defense in
// depth — see `defaultRateLimit` in guard.ts) chained AFTER the auth
// middleware so `ctx.actorHumanId` is resolved before the limiter keys on it.
// Router-level `.use(rateLimit(...))` calls layer additional, stricter limits
// on top of this floor for specific sensitive procedures.
export const publicProcedure = baseProcedure
  .use(timingMiddleware)
  .use(apiKeyGateNoActor)
  .use(publicOnlyMiddleware)
  .use(defaultRateLimitMiddleware);
// `bumpPublicReadsAfterActorMutation` goes LAST in the two chains that
// resolve an actor: only a verified actor's mutation invalidates the shared
// public-read caches (see trpc.ts). `publicProcedure` never resolves one.
export const optionalProcedure = baseProcedure
  .use(timingMiddleware)
  .use(apiKeyGateWithActor)
  .use(optionalAuthMiddleware)
  .use(defaultRateLimitMiddleware)
  .use(bumpPublicReadsAfterActorMutation);
// `requireStaffSecondFactor` (2FA step-up for platform/moderation staff) is
// chained after auth + the rate-limit floor so every authed procedure picks
// it up automatically; it no-ops for the overwhelming majority of paths that
// aren't on the gated allowlist (see guard.ts) — see that file for the full
// design rationale.
export const authedProcedure = baseProcedure
  .use(timingMiddleware)
  .use(apiKeyGateWithActor)
  .use(requireAuthMiddleware)
  .use(defaultRateLimitMiddleware)
  .use(requireStaffSecondFactorMiddleware)
  .use(bumpPublicReadsAfterActorMutation);
export const authed = authedProcedure;
// Every surface where a signed-in actor reads or acts on THEIR OWN orders and
// tickets: an unverified account is refused (B2, see verified-email.ts).
export const verifiedEmailProcedure = authedProcedure.use(requireVerifiedEmail);
