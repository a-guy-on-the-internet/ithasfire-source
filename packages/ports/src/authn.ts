import { z } from "zod";

export const ensureAuthedHumanInputSchema = z
  .object({
    providerUserId: z.string().trim().min(1, "providerUserId must be provided"),
    token: z.string().trim().min(1, "token must not be empty").optional(),
    /**
     * The Better Auth session the bearer JWT was minted from (`sid` claim).
     * When present, the adapter refuses the request unless that session still
     * exists, so revoking sessions (ban, password reset, account-takeover
     * sweep) also kills JWTs minted from them.
     */
    sessionId: z.string().trim().min(1).optional(),
  })
  .strict();

export type EnsureAuthedHumanInput = z.infer<
  typeof ensureAuthedHumanInputSchema
>;

export const ensureAuthedHumanResultSchema = z
  .object({
    humanId: z.uuid(),
  })
  .strict();

export type EnsureAuthedHumanResult = z.infer<
  typeof ensureAuthedHumanResultSchema
>;

export const ensureAuthedHumanFromApiKeyInputSchema = z
  .object({
    apiKey: z.string().trim().min(1, "apiKey must be provided"),
  })
  .strict();

export type EnsureAuthedHumanFromApiKeyInput = z.infer<
  typeof ensureAuthedHumanFromApiKeyInputSchema
>;

/**
 * The key scope resolved with the key (scoped-api-keys spec, NFR-003: in the
 * same single statement as the key itself). `legacy` = a key with no subject
 * from the old `apiKeys.create`; it authenticates until the FR-013 cutover
 * and is never granted a scope implicitly: what it may reach is the
 * transport's decision (step 4).
 */
export const apiKeyScopeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("scoped"),
      keyId: z.string().min(1),
      requestId: z.string().min(1),
      subject: z.enum(["ORG", "PERSONAL", "STAFF", "PLATFORM_WIDE"]),
      access: z.enum(["READ", "READ_WRITE"]),
      orgId: z.string().min(1).nullable(),
    })
    .strict(),
  z.object({ kind: z.literal("legacy"), keyId: z.string().min(1) }).strict(),
]);

export type ApiKeyScope = z.infer<typeof apiKeyScopeSchema>;

export const ensureAuthedHumanFromApiKeyResultSchema = z
  .object({
    humanId: z.uuid(),
    keyScope: apiKeyScopeSchema,
  })
  .strict();

export type EnsureAuthedHumanFromApiKeyResult = z.infer<
  typeof ensureAuthedHumanFromApiKeyResultSchema
>;

export const getProviderUserIdInputSchema = z
  .object({
    token: z.string().trim().min(1, "token must not be empty"),
  })
  .strict();

export type GetProviderUserIdInput = z.infer<
  typeof getProviderUserIdInputSchema
>;

export const getProviderUserIdResultSchema = z
  .object({
    providerUserId: z.string().trim().min(1, "providerUserId must be provided"),
    /** `sid` claim, when the JWT carries one (see `ensureAuthedHumanInputSchema`). */
    sessionId: z.string().trim().min(1).optional(),
  })
  .strict();

export type GetProviderUserIdResult = z.infer<
  typeof getProviderUserIdResultSchema
>;

export type AuthNErrorCode =
  | "invalid_input"
  | "unauthorized"
  | "dependency_failed"
  | "transient";

export interface AuthNPortError extends Error {
  readonly code: AuthNErrorCode;
}

export interface AuthNPort {
  ensureAuthedHuman(
    input: EnsureAuthedHumanInput,
  ): Promise<EnsureAuthedHumanResult>;

  /**
   * Resolve an API key to its holder and key scope. Refuses (unauthorized)
   * an unknown, revoked or expired key (`expires_at` at or before the DB
   * clock) and a holder who is not ACTIVE. One indexed statement (NFR-003).
   */
  ensureAuthedHumanFromApiKey(
    input: EnsureAuthedHumanFromApiKeyInput,
  ): Promise<EnsureAuthedHumanFromApiKeyResult>;

  getProviderUserId(
    input: GetProviderUserIdInput,
  ): Promise<GetProviderUserIdResult>;
}
