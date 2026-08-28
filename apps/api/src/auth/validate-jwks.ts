import { symmetricDecrypt } from "better-auth/crypto";
import { prisma } from "@th/db";

/**
 * Validates that existing JWKS private keys can be decrypted with the current
 * BETTER_AUTH_SECRET. If a secret rotation is detected (decrypt fails), all
 * stale JWKS rows are cleared so Better Auth can regenerate keys encrypted
 * with the new secret on the next request.
 *
 * This prevents a total auth outage when BETTER_AUTH_SECRET is rotated without
 * clearing the jwks table.
 */
export async function validateJwks(
  secret: string | undefined,
  logger: {
    info: (msg: string, extra?: Record<string, unknown>) => void;
    warn: (msg: string, extra?: Record<string, unknown>) => void;
  },
): Promise<void> {
  if (!secret) return; // No secret configured (local dev without encryption)

  const latestKey = await prisma.jwks.findFirst({
    orderBy: { createdAt: "desc" },
  });

  if (!latestKey) return; // No keys yet; Better Auth will create one

  try {
    await symmetricDecrypt({
      key: secret,
      data: JSON.parse(latestKey.privateKey),
    });
  } catch {
    // Secret mismatch — old keys encrypted with a different secret
    logger.warn("jwks_secret_mismatch_detected", {
      message:
        "BETTER_AUTH_SECRET changed since JWKS keys were created. Clearing stale keys so Better Auth can regenerate.",
      staleKeyId: latestKey.id,
      staleKeyCreatedAt: latestKey.createdAt,
    });
    const { count } = await prisma.jwks.deleteMany();
    logger.warn("jwks_stale_keys_cleared", { deletedCount: count });
  }
}
