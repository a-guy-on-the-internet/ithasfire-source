import { z } from "zod";

import { parseInput } from "../../lib/io";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { EntityPageRecord } from "@th/ports/repos/entity-pages";
import { humanStatusSchema } from "@th/schema";
import { fail } from "@th/errors";

/**
 * @deprecated This use case is deprecated. Human provisioning now happens
 * automatically via Better Auth's `user.create.after` hook which calls
 * `provisionHumanForAuthUser`. Mobile clients should use that endpoint
 * with `authUserId` instead of email.
 *
 * This use case is kept for backwards compatibility but now only returns
 * existing humans - it cannot create new ones since Human no longer has
 * email/phone fields. Use `provisionHumanForAuthUser` for new auth flows.
 */

export const createHumanInputSchema = z
  .object({
    actorSystem: z.literal("service"),
    email: z
      .string()
      .trim()
      .min(1)
      .email()
      .transform((value) => value.toLowerCase()),
    name: z.string().optional(),
    phone: z
      .string()
      .trim()
      .optional()
      .transform((value) => (value && value.length > 0 ? value : undefined)),
    // clientKey is used for request correlation. In real clients it's usually a UUID,
    // but during auth redirect flows we sometimes only have a short token.
    // Keep it reasonably bounded but don't reject short values.
    clientKey: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .transform((value) => value || "auth-sync"),
  })
  .strict();

const humanSummarySchema = z
  .object({
    id: z.uuid(),
    email: z.string().email(),
    name: z.string().nullable(),
    phone: z.string().nullable(),
    status: humanStatusSchema,
  })
  .strict();

const profileSummarySchema = z
  .object({
    humanId: z.uuid(),
    slug: z.string(),
    displayName: z.string().nullable(),
  })
  .strict();

export const createHumanOutputSchema = z
  .object({
    humanId: z.uuid(),
    created: z.boolean(),
    human: humanSummarySchema,
    profile: profileSummarySchema,
  })
  .strict();

export type CreateHumanInput = z.infer<typeof createHumanInputSchema>;
export type CreateHumanOutput = z.infer<typeof createHumanOutputSchema>;

export type CreateHumanDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

/**
 * @deprecated See module-level deprecation notice. Use `provisionHumanForAuthUser` instead.
 */
export async function createHuman(
  deps: CreateHumanDeps,
  rawInput: unknown,
): Promise<CreateHumanOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "createHuman" });

  const execute = async () => {
    const input = parseInput(createHumanInputSchema, rawInput);

    scopedLogger?.warn("createHuman.deprecated", {
      message:
        "createHuman is deprecated. Use provisionHumanForAuthUser with authUserId instead.",
      email: input.email,
    });

    // Look up existing human by email (via AuthUser join)
    const existing = await deps.repos.humans.getByEmail(input.email);

    if (!existing) {
      // In the new model, Human creation only happens via Better Auth hooks.
      // If no human exists for this email, auth hasn't completed properly.
      throw fail("HUMAN_NOT_FOUND", { meta: { via: "email" } });
    }

    const { human, identity } = existing;

    // Get or create entity page
    let page = await deps.repos.entityPages.getByOwner("HUMAN", human.id);
    if (!page) {
      page = await deps.repos.entityPages.upsert({
        ownerType: "HUMAN",
        ownerId: human.id,
        slug: buildProfileSlug(human.id, human.name, identity.email),
        displayName: human.name,
      });
    }

    scopedLogger?.info("createHuman.found_existing", { humanId: human.id });

    return createHumanOutputSchema.parse({
      humanId: human.id,
      created: false, // Always false now - we only return existing
      human: {
        id: human.id,
        email: identity.email,
        name: human.name,
        phone: identity.phone,
        status: human.status,
      },
      profile: {
        humanId: page.ownerId,
        slug: page.slug,
        displayName: page.displayName,
      },
    });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("createHuman", execute);
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
