import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { OrganizationsRepo } from "@th/ports/repos/organizations";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";
import { asKnownError } from "../../lib/errors";
import { describeError, parseInput } from "../../lib/io";
import { sanitizeText } from "../../lib/slug-utils";
import { enforceQuota, incrementResourceUsage } from "../quotas/enforce-quota";
import { reindexAfterMutation } from "../search/reindex-after-mutation";
import { markForSearchReindex } from "../search/search-reindex-marks";
import { fail } from "@th/errors";
import { sanitizePlainText } from "../../lib/sanitize-plain-text";

const IDEMPOTENCY_TTL_SECONDS = 120;

export const createOrgInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    // Sanitize BEFORE length validation (matches `plainTextRequired`'s
    // ordering) so the min/max bounds apply to the cleaned value; composed
    // manually here because the org name needs a `min(2)` floor that the
    // shared `plainTextRequired` helper (fixed at `min(1)`) doesn't expose.
    name: z
      .string()
      .transform(sanitizePlainText)
      .pipe(z.string().min(2, "name_min_length").max(140, "name_max_length")),
    clientKey: z.string().min(8, "client_key_min_length"),
  })
  .strict();

export const createOrgOutputSchema = z
  .object({
    orgId: z.uuid(),
  })
  .strict();

export type CreateOrgInput = z.infer<typeof createOrgInputSchema>;
export type CreateOrgOutput = z.infer<typeof createOrgOutputSchema>;

export type CreateOrgDeps = {
  repos: Repos;
  idempotency: IdempotencyPort;
  authz: AuthZPort;
  clock: ClockPort;
  logger?: LoggerPort;
  /** Best-effort: when provided, indexes the new org for search. */
  search?: MultiSearchPort;
};

interface StoredCreateOrgRecord {
  payloadHash: string;
  response: CreateOrgOutput;
}

export async function createOrg(
  deps: CreateOrgDeps,
  rawInput: unknown,
): Promise<CreateOrgOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "createOrg" });

  const execute = async () => {
    const input = parseInput(createOrgInputSchema, rawInput);
    const normalizedName = input.name.trim();

    // Enforce org-creation quota for this human.
    void deps.authz;

    const payloadHash = JSON.stringify({
      actorHumanId: input.actorHumanId,
      name: normalizedName,
    });
    const idempotencyKey = buildIdempotencyKey(
      input.actorHumanId,
      normalizedName,
      input.clientKey,
    );

    const replay =
      await deps.idempotency.get<StoredCreateOrgRecord>(idempotencyKey);
    if (replay) {
      ensurePayloadConsistency(replay.payloadHash, payloadHash);
      return replay.response;
    }

    const claimed = await deps.idempotency.begin(
      idempotencyKey,
      IDEMPOTENCY_TTL_SECONDS,
    );
    if (!claimed) {
      const afterWait =
        await deps.idempotency.get<StoredCreateOrgRecord>(idempotencyKey);
      if (afterWait) {
        ensurePayloadConsistency(afterWait.payloadHash, payloadHash);
        return afterWait.response;
      }
      throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS");
    }

    try {
      const result = await createOrgInternal({
        repos: deps.repos,
        clock: deps.clock,
        logger: scopedLogger,
        actorHumanId: input.actorHumanId,
        name: normalizedName,
      });

      await deps.idempotency.commit<StoredCreateOrgRecord>(
        idempotencyKey,
        { payloadHash, response: result },
        IDEMPOTENCY_TTL_SECONDS,
      );

      reindexAfterMutation(
        {
          repos: deps.repos,
          search: deps.search,
          clock: deps.clock,
          logger: deps.logger,
        },
        "createOrg",
        { kind: "organization", id: result.orgId },
      );

      return result;
    } catch (error) {
      await deps.idempotency.fail(idempotencyKey, describeError(error));
      throw asKnownError("create_org", error);
    }
  };

  if (scopedLogger) {
    return scopedLogger.withTime("createOrg", execute);
  }

  return execute();
}

async function createOrgInternal(input: {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
  actorHumanId: string;
  name: string;
}): Promise<CreateOrgOutput> {
  const now = input.clock.now();

  const result = await input.repos.tx(async (tx) => {
    // Enforce ORGS_OWNED quota before creating
    await enforceQuota(tx, {
      subjectType: "HUMAN",
      subjectId: input.actorHumanId,
      kind: "ORGS_OWNED",
    });

    const org = await createOrganization(tx.organizations, {
      name: input.name,
      createdAt: now,
    });

    await tx.organizations.addMember({
      orgId: org.id,
      humanId: input.actorHumanId,
      role: "OWNER",
      addedAt: now,
    });

    await tx.audit.log({
      entity: "organization",
      entityId: org.id,
      action: "organization.created",
      data: {
        actorHumanId: input.actorHumanId,
        name: org.name,
      },
      at: now,
    });

    // Track org-creation usage
    await incrementResourceUsage(tx, {
      subjectType: "HUMAN",
      subjectId: input.actorHumanId,
      kind: "ORGS_OWNED",
    });

    // Auto-provision an EntityPage for the new org so the page editor works
    // immediately and public profile routes have something to render.
    const pageSlug = buildPageSlug(org.name, org.id);
    await tx.entityPages.upsert({
      ownerType: "ORGANIZATION",
      ownerId: org.id,
      slug: pageSlug,
      displayName: org.name,
    });

    await markForSearchReindex(tx, [{ kind: "organization", id: org.id }], now);

    return org;
  });

  input.logger?.info("createOrg.succeeded", { orgId: result.id });

  return createOrgOutputSchema.parse({ orgId: result.id });
}

async function createOrganization(
  repo: OrganizationsRepo,
  input: { name: string; createdAt: Date },
) {
  const slug = input.name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();

  return repo.create({
    name: input.name,
    slug: slug.length > 0 ? slug : "org",
    status: "ACTIVE",
    createdAt: input.createdAt,
  });
}

function ensurePayloadConsistency(
  existingHash: string,
  nextHash: string,
): void {
  if (existingHash !== nextHash) {
    throw fail("IDEMPOTENCY_KEY_CONFLICT");
  }
}

function buildIdempotencyKey(
  actorHumanId: string,
  name: string,
  clientKey: string,
): string {
  return `org:create:${actorHumanId}:${name}:${clientKey}`;
}

/**
 * Derive a page-slug for a new organization.
 *
 * Sanitises the org name into a URL-safe fragment and appends the first 8
 * chars of the org ID to keep it unique. Falls back to `org-<id>` if the
 * name is entirely non-alphanumeric.
 */
function buildPageSlug(name: string, orgId: string): string {
  const base = sanitizeText(name);
  const suffix = orgId.replace(/-/g, "").slice(0, 8);
  if (!base) return `org-${suffix}`;
  return `${base}-${suffix}`;
}
