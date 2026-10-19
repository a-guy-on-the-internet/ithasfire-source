import { z } from "zod";

import { parseInput } from "../../lib/io";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";
import { reindexAfterMutation } from "../search/reindex-after-mutation";
import { markForSearchReindex } from "../search/search-reindex-marks";
import { plainTextOptional } from "../../lib/sanitize-plain-text";

export const provisionHumanForAuthUserInputSchema = z
  .object({
    actorSystem: z.literal("service"),

    // Better Auth user id (AuthUser.id).
    authUserId: z.string().trim().min(1),

    // Email is passed for logging/debugging but no longer stored on Human.
    // AuthUser is the source of truth for identity.
    email: z
      .string()
      .trim()
      .min(1)
      .email()
      .transform((v) => v.toLowerCase()),

    // Optional profile enrichment.
    name: plainTextOptional(200)
      .optional()
      .transform((v) => (v && v.length > 0 ? v : undefined)),

    // OAuth image URL to sync to Profile.avatarUrl
    image: z
      .string()
      .url()
      .optional()
      .transform((v) => (v && v.length > 0 ? v : undefined)),

    // Locale from the OAuth provider (e.g. "en", "en-US")
    locale: z
      .string()
      .trim()
      .optional()
      .transform((v) => (v && v.length > 0 ? v : undefined)),

    // request correlation (see create-human)
    clientKey: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .transform((value) => value || "auth-provision"),
  })
  .strict();

export const provisionHumanForAuthUserOutputSchema = z
  .object({
    humanId: z.uuid(),
    created: z.boolean(),
    linked: z.boolean(),
  })
  .strict();

export type ProvisionHumanForAuthUserInput = z.infer<
  typeof provisionHumanForAuthUserInputSchema
>;
export type ProvisionHumanForAuthUserOutput = z.infer<
  typeof provisionHumanForAuthUserOutputSchema
>;

export type ProvisionHumanForAuthUserDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
  /** Best-effort: when provided, indexes the new/linked human for search. */
  search?: MultiSearchPort;
};

export async function provisionHumanForAuthUser(
  deps: ProvisionHumanForAuthUserDeps,
  rawInput: unknown,
): Promise<ProvisionHumanForAuthUserOutput> {
  const scopedLogger = deps.logger?.child({
    useCase: "provisionHumanForAuthUser",
  });

  const execute = async () => {
    const input = parseInput(provisionHumanForAuthUserInputSchema, rawInput);
    const name = input.name ?? null;

    const result = await deps.repos.tx(async (tx) => {
      // Serialize concurrent provisions for the SAME auth user. Without this,
      // two requests bearing the same cookie (common — a page fires several
      // authed requests at once) can both pass the null checks below, each
      // CREATE a Human, and the link update is last-write-wins → one orphaned
      // duplicate Human (Human has no unique identity field to catch it). The
      // transaction-scoped advisory lock is held until this tx commits, so the
      // second waiter then sees the first's committed link and no-ops. MUST be
      // the first statement so both the signup-rollback and self-heal paths
      // are protected.
      await tx.humans.lockForAuthUser(input.authUserId);

      // If already linked, we're done.
      const existingLink = await tx.humans.getHumanIdForAuthUserId(
        input.authUserId,
      );
      if (existingLink?.humanId) {
        // Sync profile avatar from OAuth whenever we have a new image URL.
        // Always overwrite so the latest provider picture stays current.
        if (input.image) {
          const page = await tx.entityPages.getByOwner(
            "HUMAN",
            existingLink.humanId,
          );
          if (page && page.avatarUrl !== input.image) {
            await tx.entityPages.upsert({
              ownerType: "HUMAN",
              ownerId: existingLink.humanId,
              slug: page.slug,
              displayName: page.displayName,
              avatarUrl: input.image,
            });
          }
        }
        return provisionHumanForAuthUserOutputSchema.parse({
          humanId: existingLink.humanId,
          created: false,
          linked: false,
        });
      }

      // Check if Human already exists via AuthUser email lookup
      const existingHumanWithIdentity = await tx.humans.getByEmail(input.email);

      let humanId: string;
      let created = false;

      if (existingHumanWithIdentity) {
        humanId = existingHumanWithIdentity.human.id;

        // Opportunistically fill name/locale if missing.
        const updates: Record<string, unknown> = {};
        if (!existingHumanWithIdentity.human.name && name) updates.name = name;
        if (!existingHumanWithIdentity.human.locale && input.locale)
          updates.locale = input.locale;
        if (Object.keys(updates).length > 0) {
          await tx.humans.update(humanId, updates);
        }
      } else {
        const createdHuman = await tx.humans.create({
          name,
          status: "ACTIVE",
          locale: input.locale ?? null,
        });

        humanId = createdHuman.id;
        created = true;

        // Create entity page with displayName and avatar from OAuth
        const slug = buildProfileSlug(humanId, name, input.email);
        await tx.entityPages.upsert({
          ownerType: "HUMAN",
          ownerId: humanId,
          slug,
          displayName: name,
          avatarUrl: input.image ?? null,
        });
      }

      await tx.humans.linkAuthUserToHuman({
        authUserId: input.authUserId,
        humanId,
      });

      scopedLogger?.info("provisionHumanForAuthUser.succeeded", {
        authUserId: input.authUserId,
        humanId,
        created,
      });

      await markForSearchReindex(
        tx,
        [{ kind: "human", id: humanId }],
        deps.clock.now(),
      );

      return provisionHumanForAuthUserOutputSchema.parse({
        humanId,
        created,
        linked: true,
      });
    });

    // AFTER commit (it used to run inside the callback, where the index read
    // could not see the uncommitted human).
    if (result.linked) {
      reindexAfterMutation(
        {
          repos: deps.repos,
          search: deps.search,
          clock: deps.clock,
          logger: deps.logger,
        },
        "provisionHumanForAuthUser",
        { kind: "human", id: result.humanId },
      );
    }
    return result;
  };

  if (scopedLogger) {
    return scopedLogger.withTime("provisionHumanForAuthUser", execute);
  }

  return execute();
}

function buildProfileSlug(
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
