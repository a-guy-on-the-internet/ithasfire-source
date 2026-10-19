import type {
  AuthNErrorCode,
  AuthNPort,
  AuthNPortError,
  EnsureAuthedHumanFromApiKeyInput,
  EnsureAuthedHumanFromApiKeyResult,
  EnsureAuthedHumanInput,
  EnsureAuthedHumanResult,
  GetProviderUserIdInput,
  GetProviderUserIdResult,
} from "@th/ports/authn";
import {
  ensureAuthedHumanFromApiKeyInputSchema,
  ensureAuthedHumanFromApiKeyResultSchema,
  ensureAuthedHumanInputSchema,
  ensureAuthedHumanResultSchema,
  getProviderUserIdInputSchema,
  getProviderUserIdResultSchema,
} from "@th/ports/authn";
import type { Repos } from "@th/ports/repos";

// Better Auth adapter.
//
// The API authenticates requests by:
// - extracting a Bearer JWT (minted by Better Auth's jwt plugin)
// - verifying it via Better Auth JWKS
// - using `sub` as providerUserId (stable user id)
// - mapping that to our internal humanId via `humans.ensureByProvider`.

/**
 * After this instant every JWT must carry `sid` (the Better Auth session it
 * was minted from). `sid` was added by the jwt plugin's `definePayload` on
 * 2026-09-29; JWTs live 15 minutes, so a sid-less token ISSUED after this
 * cutoff cannot be one of ours from before that change — it is refused.
 * Chosen as roughly "now + 1 day" at the time of the change (2026-09-29
 * ~04:40Z), leaving a day for the deploy to land. If the deploy lands AFTER
 * this instant, sid-less tokens minted in between are refused and clients
 * re-mint once (≤15 min of friction) — acceptable, and safer than a gate that
 * never closes.
 */
export const SID_REQUIRED_AFTER = new Date("2026-09-30T05:00:00Z");

export type BetterAuthAuthNAdapterDeps = {
  repos: Repos;
  verifyJwt: (token: string) => Promise<{
    sub: string | null;
    sid?: string | null;
    /** `iat` claim, seconds since epoch. */
    iat?: number | null;
  }>;
  /** Test seam for {@link SID_REQUIRED_AFTER}. */
  sidRequiredAfter?: Date;
};

class AuthNAdapterError extends Error implements AuthNPortError {
  readonly code: AuthNErrorCode;

  constructor(code: AuthNErrorCode, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "BetterAuthAuthNAdapterError";
    this.code = code;
  }
}

function makeInvalidInputError(message: string): AuthNAdapterError {
  return new AuthNAdapterError("invalid_input", message);
}

function makeUnauthorizedError(
  message: string,
  cause?: unknown,
): AuthNAdapterError {
  return new AuthNAdapterError("unauthorized", message, cause);
}

function makeDependencyFailedError(
  message: string,
  cause?: unknown,
): AuthNAdapterError {
  return new AuthNAdapterError("dependency_failed", message, cause);
}

function makeTransientError(
  message: string,
  cause?: unknown,
): AuthNAdapterError {
  return new AuthNAdapterError("transient", message, cause);
}

function extractProviderUserIdFromJwtPayload(payload: {
  sub: string | null;
}): string | null {
  const value = payload.sub;
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

/**
 * Build a URL-safe profile slug for auto-provisioned Humans.
 * Mirrors the slug logic in `provision-human-for-auth-user.ts`.
 */
function buildAutoProvisionSlug(
  humanId: string,
  name: string | null,
  email: string,
): string {
  const source = name ?? email.split("@")[0] ?? humanId;
  const slugBase = source
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const fallback =
    slugBase.length > 0 ? slugBase : `user-${humanId.slice(0, 8)}`;
  const suffix = humanId.slice(0, 8);
  return `${fallback}-${suffix}`;
}

export function createBetterAuthAuthNAdapterWithDeps({
  repos,
  verifyJwt,
  sidRequiredAfter = SID_REQUIRED_AFTER,
}: BetterAuthAuthNAdapterDeps): AuthNPort {
  async function getProviderUserId(
    input: GetProviderUserIdInput,
  ): Promise<GetProviderUserIdResult> {
    const parsed = getProviderUserIdInputSchema.parse(input);
    const token = parsed.token.trim();
    if (!token) {
      throw makeUnauthorizedError("Token is required");
    }

    let payload: { sub: string | null; sid?: string | null; iat?: number | null };
    try {
      payload = await verifyJwt(token);
    } catch (err) {
      throw makeUnauthorizedError("Token invalid or expired", err);
    }

    const providerUserId = extractProviderUserIdFromJwtPayload(payload);
    if (!providerUserId) {
      throw makeDependencyFailedError(
        "Unable to determine provider user id from token",
        payload,
      );
    }

    // `sid` = the Better Auth session this JWT was minted from (added by the
    // jwt plugin's `definePayload` in apps/api/src/auth/better-auth.ts).
    const sessionId =
      typeof payload.sid === "string" && payload.sid.trim().length > 0
        ? payload.sid.trim()
        : undefined;

    // A sid-less JWT is only a legacy token from before `sid` existed, so it
    // must have been issued before the cutoff. Missing `iat` counts as "after"
    // (fail closed): our jwt plugin always sets it.
    if (!sessionId) {
      const issuedAtMs =
        typeof payload.iat === "number" ? payload.iat * 1000 : null;
      if (issuedAtMs === null || issuedAtMs >= sidRequiredAfter.getTime()) {
        throw makeUnauthorizedError("Token is not bound to a session");
      }
    }

    return getProviderUserIdResultSchema.parse({
      providerUserId,
      ...(sessionId ? { sessionId } : {}),
    });
  }

  async function ensureAuthedHumanFromApiKey(
    input: EnsureAuthedHumanFromApiKeyInput,
  ): Promise<EnsureAuthedHumanFromApiKeyResult> {
    const parsed = ensureAuthedHumanFromApiKeyInputSchema.parse(input);

    try {
      // ONE statement on the root client (NFR-003): the key, its scope and
      // the holder's status come back from the same UPDATE ... RETURNING.
      // No repos.tx(): a single statement is atomic on its own, and the
      // BEGIN/COMMIT pair would add two round trips to every keyed call.
      const resolved = await repos.apiKeys.getHumanIdForKey({
        apiKey: parsed.apiKey,
      });

      if (!resolved) {
        throw makeUnauthorizedError("API key invalid, revoked or expired");
      }

      // A ban/suspension must stop API keys too, not only sessions. The
      // status comes back from the key lookup itself (one statement).
      if (resolved.humanStatus !== "ACTIVE") {
        throw makeUnauthorizedError("API key owner is not active");
      }

      return ensureAuthedHumanFromApiKeyResultSchema.parse({
        humanId: resolved.humanId,
        keyScope: resolved.keyScope,
      });
    } catch (err) {
      if (err instanceof AuthNAdapterError) {
        throw err;
      }
      throw makeTransientError(
        "Failed to ensure authenticated human via API key",
        err,
      );
    }
  }

  async function ensureAuthedHuman(
    input: EnsureAuthedHumanInput,
  ): Promise<EnsureAuthedHumanResult> {
    const parsed = ensureAuthedHumanInputSchema.parse(input);
    const providerUserId = parsed.providerUserId.trim();
    const sessionId = parsed.sessionId;

    // Better Auth is authoritative for auth identity. Our DB schema links
    // `AuthUser.id` (Better Auth user id) -> `AuthUser.humanId` (domain human).
    //
    // Therefore, the API auth boundary is:
    //   verify bearer token -> extract `sub` -> find AuthUser -> return humanId.
    //
    // If the AuthUser exists but is not linked to a Human, it means the signup
    // hook (`databaseHooks.user.create.after`) failed silently. We recover by
    // auto-provisioning a Human + Profile on the fly so the user doesn't get
    // stuck in an "unauthorized" loop.
    try {
      const resolved = await repos.tx(async (tx) => {
        // Hot path: one read returns the humanId, Human.status AND (for a
        // session-bound JWT) whether its session still exists.
        const actor = await tx.humans.getAuthActorForAuthUserId(
          providerUserId,
          { sessionId },
        );
        if (actor) return actor;

        // ── Auto-provision: signup hook must have failed ──
        const details = await tx.humans.getAuthUserById(providerUserId);
        if (!details) {
          // No AuthUser row at all — genuinely unauthorized
          return null;
        }

        const provision = await tx.humans.ensureByProvider({
          providerUserId: details.id,
          email: details.email,
          name: details.name,
        });

        // Create a default entity page so downstream queries (getMyProfile, etc.)
        // don't fail after provisioning.
        const existingPage = await tx.entityPages.getByOwner(
          "HUMAN",
          provision.humanId,
        );
        if (!existingPage) {
          const slug = buildAutoProvisionSlug(
            provision.humanId,
            details.name,
            details.email,
          );
          await tx.entityPages.upsert({
            ownerType: "HUMAN",
            ownerId: provision.humanId,
            slug,
            displayName: details.name,
            avatarUrl: details.image,
          });
        }

        // Rare path. `ensureByProvider` can link to an EXISTING Human (matched
        // by email), which may be suspended/banned, so re-read status (and the
        // session binding) rather than assuming a fresh ACTIVE row.
        const provisioned = await tx.humans.getAuthActorForAuthUserId(
          providerUserId,
          { sessionId },
        );
        return {
          humanId: provision.humanId,
          status: provisioned?.status ?? null,
          sessionActive: provisioned?.sessionActive ?? (sessionId ? false : null),
        };
      });

      if (!resolved) {
        throw makeUnauthorizedError("No linked human for auth user id");
      }

      // Suspended/banned (or not-yet-active) humans do not authenticate.
      // Checked here — not in the tRPC guard — because this port IS the
      // per-request identity load: the status rides the same read, so the
      // guard gets it for free and every AuthNPort caller inherits the rule.
      if (resolved.status !== "ACTIVE") {
        throw makeUnauthorizedError("Human is not active");
      }

      // A JWT is valid for 15 minutes on its own signature. Binding it to its
      // session means revoking sessions — ban, password reset, the
      // account-takeover sweep — also revokes every JWT minted from them,
      // instead of leaving a window in which e.g. `apiKeys.create` still works.
      //
      // A JWT WITHOUT `sid` never reaches here with a session to check:
      // `getProviderUserId` refuses it unless it was issued before
      // SID_REQUIRED_AFTER (legacy tokens from before `sid` existed).
      if (resolved.sessionActive === false) {
        throw makeUnauthorizedError("Session for this token has ended");
      }

      return ensureAuthedHumanResultSchema.parse({ humanId: resolved.humanId });
    } catch (err) {
      if (err instanceof AuthNAdapterError) {
        throw err;
      }
      throw makeTransientError(
        "Failed to ensure authenticated human via Better Auth",
        err,
      );
    }
  }

  return {
    getProviderUserId,
    ensureAuthedHuman,
    ensureAuthedHumanFromApiKey,
  };
}

export type BetterAuthAuthNAdapter = ReturnType<
  typeof createBetterAuthAuthNAdapterWithDeps
>;

export function createBetterAuthAuthNAdapter(params: {
  repos: Repos;
  jwksUrl: string;
  issuer?: string;
  audience?: string;
}): AuthNPort {
  // JWKS-based verification implementation using jose.
  // We keep it self-contained so apps/api doesn't need to depend on Next.js.

  type JoseModule = typeof import("jose");
  type Verifier = {
    jose: JoseModule;
    jwks: ReturnType<JoseModule["createRemoteJWKSet"]>;
  };

  // `createRemoteJWKSet` returns a resolver that caches the fetched key set
  // INSIDE the returned closure (with its own refresh/cooldown logic). Building
  // one per call therefore threw that cache away and made every single
  // authenticated request re-fetch the JWKS endpoint — this sits on the hot path
  // of every API request. `params.jwksUrl` is fixed at adapter-construction
  // time, so one resolver per adapter is correct.
  //
  // We memoize the PROMISE, not the resolved value, so concurrent cold-start
  // calls share one dynamic import + one resolver instead of each racing their
  // own. The dynamic import stays lazy on purpose: it keeps the adapter
  // tree-shakable and avoids a hard `jose` dependency in test environments that
  // never verify a JWT.
  let verifierPromise: Promise<Verifier> | null = null;

  const getVerifier = (): Promise<Verifier> => {
    if (!verifierPromise) {
      verifierPromise = (async (): Promise<Verifier> => {
        const jose = await import("jose");
        return { jose, jwks: jose.createRemoteJWKSet(new URL(params.jwksUrl)) };
      })().catch((err: unknown) => {
        // Never cache a failed init — a transient module-load (or malformed
        // URL) failure would otherwise poison every subsequent verification for
        // the lifetime of the process.
        verifierPromise = null;
        throw err;
      });
    }
    return verifierPromise;
  };

  const verifyJwt = async (token: string) => {
    const { jose, jwks } = await getVerifier();

    // Verification failures are expected and attacker-triggerable (expired or
    // forged tokens), so they are not logged here. The throw is wrapped by
    // `getProviderUserId` into an `unauthorized` AuthNAdapterError that carries
    // this error as its `cause`, so genuine diagnostics survive.
    const { payload } = await jose.jwtVerify(token, jwks, {
      issuer: params.issuer,
      audience: params.audience,
    });

    const sub = typeof payload.sub === "string" ? payload.sub : null;
    const sid = typeof payload.sid === "string" ? payload.sid : null;
    const iat = typeof payload.iat === "number" ? payload.iat : null;
    return { sub, sid, iat };
  };

  return createBetterAuthAuthNAdapterWithDeps({
    repos: params.repos,
    verifyJwt,
  });
}
