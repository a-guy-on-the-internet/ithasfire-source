import { z } from "zod";

import type { Repos } from "@th/ports/repos";
import { applicationSubmissionStatusSchema } from "@th/schema";

import { parseInput } from "../../../lib/io";
import { ORG_EDIT_ROLES } from "../../../lib/rbac";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export const listMyOpenCallApplicationsInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  })
  .strict();

export const listMyOpenCallApplicationsOutputSchema = z.array(
  z
    .object({
      submissionId: z.uuid(),
      publicId: z.string(),
      anchor: z.enum(["event", "series"]),
      title: z.string(),
      /** The applicant's own status. */
      status: applicationSubmissionStatusSchema,
      appliedAs: z
        .object({ kind: z.enum(["self", "org"]), orgName: z.string().nullable() })
        .strict(),
      createdAt: z.date(),
      /** The call page. */
      callPath: z.string(),
      /**
       * The status page path WITHOUT the token: the hub reads the status by
       * session (`auth: { kind: "session", submissionId }`).
       */
      statusPath: z.string(),
    })
    .strict(),
);

export type ListMyOpenCallApplicationsInput = z.input<
  typeof listMyOpenCallApplicationsInputSchema
>;
export type ListMyOpenCallApplicationsOutput = z.infer<
  typeof listMyOpenCallApplicationsOutputSchema
>;

export type ListMyOpenCallApplicationsDeps = {
  repos: Pick<Repos, "eventApplications" | "authz">;
};

/**
 * "My applications" in the hub (FR-009), newest first: the signed-in human's
 * own applications as themselves, plus EVERY application of each org where
 * they currently hold an ORG_EDIT_ROLES role, whoever submitted it (the same
 * rule as every other org-application session path, `actsForOpenCallOrg`).
 * An application they sent for an org they have since left is not listed.
 * Own data, so the status is shown.
 */
export async function listMyOpenCallApplications(
  deps: ListMyOpenCallApplicationsDeps,
  rawInput: unknown,
): Promise<ListMyOpenCallApplicationsOutput> {
  const input = parseInput(listMyOpenCallApplicationsInputSchema, rawInput);
  const memberships = await deps.repos.authz.listOrgMembershipsByHumanId({
    humanId: input.actorHumanId,
    roles: [...ORG_EDIT_ROLES],
  });
  const rows = await deps.repos.eventApplications.listOpenCallSubmissionsByHuman({
    humanId: input.actorHumanId,
    // Re-checked here: the role filter is a port hint, the rule lives in core.
    orgIds: memberships.filter((m) => ORG_EDIT_ROLES.includes(m.role)).map((m) => m.orgId),
    limit: input.limit,
  });
  return listMyOpenCallApplicationsOutputSchema.parse(
    rows.map((r) => ({
      submissionId: r.submissionId,
      publicId: r.publicId,
      anchor: r.anchor.kind,
      title: r.title,
      status: r.status,
      appliedAs: r.applyingAsOrgId
        ? { kind: "org", orgName: r.applyingAsOrgName }
        : { kind: "self", orgName: null },
      createdAt: r.createdAt,
      callPath: `/call/${r.publicId}`,
      statusPath: `/call/${r.publicId}/application`,
    })),
  );
}
