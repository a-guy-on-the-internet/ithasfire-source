import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { ORG_EDIT_ROLES, requireOwnerAccess } from "../../lib/rbac";
import { toPerformerOwnerType } from "./set-performer-mode";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const getPerformerBookingDefaultsInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    ownerType: z.enum(["human", "org"]),
    ownerId: z.uuid(),
  })
  .strict();

/**
 * The saved defaults, or an all-null shape when nothing is saved yet. Mirrors
 * the field list the create-booking-request form prefills from (minus `genre`,
 * which comes from Human.genreTags, never stored here).
 */
export const performerBookingDefaultsSchema = z
  .object({
    actName: z.string().nullable(),
    lineupSize: z.number().int().nullable(),
    setLengthMinutes: z.number().int().nullable(),
    techNeeds: z.string().nullable(),
    contactPhone: z.string().nullable(),
    feeType: z.enum(["GUARANTEE", "DOOR_SPLIT", "NEGOTIABLE"]).nullable(),
    feeAmountCents: z.number().int().nullable(),
    feeCurrency: z.string().nullable(),
    messageTemplate: z.string().nullable(),
    includeVerifiedStats: z.boolean().nullable(),
    linkMusic: z.string().nullable(),
    linkVideo: z.string().nullable(),
    linkSocial: z.string().nullable(),
    linkEpk: z.string().nullable(),
  })
  .strict();

export const getPerformerBookingDefaultsOutputSchema = z
  .object({
    /** True when a saved-defaults row exists for this owner. */
    hasSaved: z.boolean(),
    defaults: performerBookingDefaultsSchema,
  })
  .strict();

export type GetPerformerBookingDefaultsInput = z.infer<
  typeof getPerformerBookingDefaultsInputSchema
>;
export type GetPerformerBookingDefaultsOutput = z.infer<
  typeof getPerformerBookingDefaultsOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type GetPerformerBookingDefaultsDeps = {
  repos: Pick<Repos, "performerBookingDefaults" | "authz">;
  logger?: LoggerPort;
};

const EMPTY_DEFAULTS: z.infer<typeof performerBookingDefaultsSchema> = {
  actName: null,
  lineupSize: null,
  setLengthMinutes: null,
  techNeeds: null,
  contactPhone: null,
  feeType: null,
  feeAmountCents: null,
  feeCurrency: null,
  messageTemplate: null,
  includeVerifiedStats: null,
  linkMusic: null,
  linkVideo: null,
  linkSocial: null,
  linkEpk: null,
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read a performer's saved booking-request form defaults. Owner-access gated:
 * self for a human owner, org EDIT roles for an org owner (same gate as the
 * booking create path). Returns an all-null shape when nothing is saved yet.
 */
export async function getPerformerBookingDefaults(
  deps: GetPerformerBookingDefaultsDeps,
  rawInput: unknown,
): Promise<GetPerformerBookingDefaultsOutput> {
  const input = parseInput(getPerformerBookingDefaultsInputSchema, rawInput);

  await requireOwnerAccess({
    repos: deps.repos,
    ownerType: input.ownerType === "human" ? "HUMAN" : "ORGANIZATION",
    ownerId: input.ownerId,
    actorHumanId: input.actorHumanId,
    roles: ORG_EDIT_ROLES,
  });

  const record = await deps.repos.performerBookingDefaults.getByOwner({
    ownerType: toPerformerOwnerType(input.ownerType),
    ownerId: input.ownerId,
  });

  if (!record) {
    return getPerformerBookingDefaultsOutputSchema.parse({
      hasSaved: false,
      defaults: EMPTY_DEFAULTS,
    });
  }

  return getPerformerBookingDefaultsOutputSchema.parse({
    hasSaved: true,
    defaults: {
      actName: record.actName,
      lineupSize: record.lineupSize,
      setLengthMinutes: record.setLengthMinutes,
      techNeeds: record.techNeeds,
      contactPhone: record.contactPhone,
      feeType: record.feeType,
      feeAmountCents: record.feeAmountCents,
      feeCurrency: record.feeCurrency,
      messageTemplate: record.messageTemplate,
      includeVerifiedStats: record.includeVerifiedStats,
      linkMusic: record.linkMusic,
      linkVideo: record.linkVideo,
      linkSocial: record.linkSocial,
      linkEpk: record.linkEpk,
    },
  });
}
