import { TRPCError } from "@trpc/server";
import { createHash } from "node:crypto";
import { z } from "zod";

import {
  listConsentByAnonymousId,
  listConsentByHumanId,
  recordConsent,
  recordConsentClientInputSchema,
} from "@th/core/use-cases/consent";

import { authedProcedure, optionalProcedure } from "../init";
import { rateLimit } from "../guard";
import { toTrpcError } from "../utils";

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toTrpcError(err);
  }
}

/**
 * SHA-256 hash of `${ip}:${salt}`. Returns null if either input is missing.
 * The salt comes from `CONSENT_IP_HASH_SALT` — fail closed (null) when
 * unset rather than store unsalted hashes.
 */
function hashIp(ip: string | null): string | null {
  const salt = process.env.CONSENT_IP_HASH_SALT;
  if (!ip || !salt) return null;
  return createHash("sha256").update(`${ip}:${salt}`).digest("hex");
}

export const consentRouter = {
  /**
   * Persist a consent decision. Public — the banner runs for anonymous
   * visitors. Rate-limited per anonymousId so a single device can't spam
   * the log.
   */
  record: optionalProcedure
    // Public surface — only client-trusted fields. actorHumanId / ipHash /
    // userAgent are merged in below from `ctx`, never from input, so a
    // caller can't forge a consent record against another account.
    // `.input()` MUST come before `.use(rateLimit(...))` — middleware sees
    // `input: undefined` until the input parser runs, so reading
    // `input.anonymousId` against an unparsed input throws at runtime.
    .input(recordConsentClientInputSchema)
    .use(
      rateLimit<{ anonymousId: string }>({
        // Compose with clientIp so rotating the localStorage anonymousId
        // doesn't bypass the limit. Falls back to "no-ip" when the
        // request lacks a forwarded address (rare in real deployments;
        // always present behind Cloud Run + Cloudflare).
        key: (ctx, input) =>
          `consent:record:${ctx.clientIp ?? "no-ip"}:${input.anonymousId}`,
        maxRequests: 10,
        windowSeconds: 60,
        message: "recording consent",
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return call(() =>
        recordConsent(
          { repos: ctx.repos, logger: ctx.logger },
          {
            ...input,
            actorHumanId: ctx.actorHumanId,
            ipHash: hashIp(ctx.clientIp),
            userAgent: ctx.userAgent,
          },
        ),
      );
    }),

  /**
   * List consent records for a human. Platform admin only — used for
   * fulfilling DSARs ("show me all consents on file for this user").
   */
  listForHuman: authedProcedure
    .input(z.object({ humanId: z.uuid() }).strict())
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) throw new TRPCError({ code: "UNAUTHORIZED" });
      const staff = await ctx.authz.hasStaffRole({
        actorHumanId,
        requiredRoles: ["ADMIN"],
      });
      if (!staff.allowed) throw new TRPCError({ code: "FORBIDDEN" });

      return call(() =>
        listConsentByHumanId({ repos: ctx.repos, logger: ctx.logger }, input),
      );
    }),

  /** Same shape, keyed on the device's anonymousId. Platform admin only. */
  listForAnonymous: authedProcedure
    .input(z.object({ anonymousId: z.uuid() }).strict())
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) throw new TRPCError({ code: "UNAUTHORIZED" });
      const staff = await ctx.authz.hasStaffRole({
        actorHumanId,
        requiredRoles: ["ADMIN"],
      });
      if (!staff.allowed) throw new TRPCError({ code: "FORBIDDEN" });

      return call(() =>
        listConsentByAnonymousId(
          { repos: ctx.repos, logger: ctx.logger },
          input,
        ),
      );
    }),
};
