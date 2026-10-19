import type { Repos } from "@th/ports/repos";
import type { LoggerPort } from "@th/ports/logger";

import { parseInput } from "../../lib/io";
import { ensureEmailVerified } from "../_helpers/ensure-email-verified";
import { createApiKeyInputSchema, type CreateApiKeyOutput } from "./schemas";

/**
 * Most unrevoked API keys one human may hold at once.
 *
 * Keys are full-scope, non-expiring bearer credentials; an uncapped create let
 * one stolen session mint an unbounded pile of permanent credentials
 * (2026-09-29 review, F5). Five covers "a key per machine / CI job" and forces
 * a revoke before a sixth.
 */
export const MAX_ACTIVE_API_KEYS_PER_HUMAN = 5;

/**
 * @deprecated Legacy full-scope mint (scoped-api-keys spec FR-001: nobody
 * mints a key directly). Kept only because `apiKeys.create` in the router
 * still imports it; plan step 5 removes the procedure and this file, ahead of
 * the FR-013 cutover. New keys come from `requestApiKey` → `decideApiKeyRequest`
 * → `collectApiKey`.
 */
export type CreateApiKeyDeps = {
  repos: Pick<Repos, "apiKeys" | "humans" | "audit" | "tx">;
  logger?: LoggerPort;
};

/** @deprecated See {@link CreateApiKeyDeps}: removed in plan step 5 (FR-001). */
export async function createApiKey(
  deps: CreateApiKeyDeps,
  rawInput: unknown,
): Promise<CreateApiKeyOutput> {
  const input = parseInput(createApiKeyInputSchema, rawInput);

  const result = await deps.repos.tx(async (tx) => {
    // An unverified address may belong to someone else entirely (sign-up does
    // not require verification), so it must not be able to mint a credential
    // that outlives the session it came from.
    await ensureEmailVerified(tx, input.actorHumanId);

    // Serialized per human (advisory lock inside the repo) so concurrent
    // creates cannot race past the cap.
    const active = await tx.apiKeys.lockAndCountActiveByHuman({
      humanId: input.actorHumanId,
    });
    if (active >= MAX_ACTIVE_API_KEYS_PER_HUMAN) {
      throw {
        code: "forbidden",
        message: "quota_exceeded",
        meta: { limit: MAX_ACTIVE_API_KEYS_PER_HUMAN, active },
      } as const;
    }

    const created = await tx.apiKeys.create({
      humanId: input.actorHumanId,
      label: input.label,
    });

    await tx.audit.log({
      entity: "api_key",
      entityId: created.id,
      action: "api_key.created",
      data: {
        actorHumanId: input.actorHumanId,
        label: input.label ?? null,
      },
      at: created.createdAt,
    });

    return created;
  });

  return {
    id: result.id,
    key: result.key,
    label: input.label ?? null,
    createdAt: result.createdAt,
  } satisfies CreateApiKeyOutput;
}
