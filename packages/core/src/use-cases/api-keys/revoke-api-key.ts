import type { Repos } from "@th/ports/repos";
import type { LoggerPort } from "@th/ports/logger";

import { parseInput } from "../../lib/io";
import { revokeApiKeyInputSchema } from "./schemas";
import { fail } from "@th/errors";

export type RevokeApiKeyDeps = {
  repos: Pick<Repos, "apiKeys" | "audit" | "tx">;
  logger?: LoggerPort;
};

/**
 * @deprecated Legacy revoke of ONE key, holder only. Replaced by
 * `revokeScopedApiKey` (holder / org admin / staff ADMIN; revokes both keys
 * of a renewal overlap). Kept because the router still imports it; plan step
 * 5 swaps the procedure over and removes this file.
 */
export async function revokeApiKey(
  deps: RevokeApiKeyDeps,
  rawInput: unknown,
): Promise<void> {
  const input = parseInput(revokeApiKeyInputSchema, rawInput);

  await deps.repos.tx(async (tx) => {
    const existing = await tx.apiKeys.getById({
      apiKeyId: input.apiKeyId,
      humanId: input.actorHumanId,
    });

    if (!existing) {
      throw fail("API_KEY_NOT_FOUND");
    }

    if (existing.revokedAt) {
      throw fail("API_KEY_ALREADY_REVOKED");
    }

    await tx.apiKeys.revoke({
      apiKeyId: input.apiKeyId,
      humanId: input.actorHumanId,
    });

    await tx.audit.log({
      entity: "api_key",
      entityId: input.apiKeyId,
      action: "api_key.revoked",
      data: {
        actorHumanId: input.actorHumanId,
      },
      at: new Date(),
    });
  });
}
