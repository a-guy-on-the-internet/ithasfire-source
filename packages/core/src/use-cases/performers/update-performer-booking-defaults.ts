import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import {
  BOOKING_SET_LENGTH_PRESETS,
  BOOKING_FEE_AMOUNT_MAX_CENTS,
  BOOKING_FEE_DEFAULT_CURRENCY,
} from "../booking-requests/constants";
import { parseInput } from "../../lib/io";
import { ORG_EDIT_ROLES, requireOwnerAccess } from "../../lib/rbac";
import { plainTextMultilineOptional } from "../../lib/sanitize-plain-text";
import { toPerformerOwnerType } from "./set-performer-mode";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * http(s)-only URL, ≤2000 chars — mirrors create-booking-request exactly.
 * `.nullable().optional()` so a field can be cleared (null) or omitted.
 */
const optionalHttpUrl = z
  .url({ protocol: /^https?$/ })
  .max(2000)
  .nullable()
  .optional();

/**
 * Pre-refine base object. The transport router derives its input from this
 * (`.omit({ actorHumanId: true })` — `.omit()` can't be applied after the
 * cross-field `.refine()` below), so the field list lives in one place. The use
 * case re-validates the full schema (refine included).
 *
 * Every value field is optional AND nullable: a save carries the full desired
 * form state, so an omitted or null field CLEARS the stored value. `genre` is
 * intentionally absent — it comes from Human.genreTags, never stored here.
 */
export const updatePerformerBookingDefaultsBaseSchema = z
  .object({
    actorHumanId: z.uuid(),
    ownerType: z.enum(["human", "org"]),
    ownerId: z.uuid(),
    actName: z.string().trim().min(1).max(120).nullable().optional(),
    lineupSize: z.number().int().min(1).max(100).nullable().optional(),
    setLengthMinutes: z
      .number()
      .int()
      .refine(
        (v) => (BOOKING_SET_LENGTH_PRESETS as readonly number[]).includes(v),
        { message: "set_length_not_a_preset" },
      )
      .nullable()
      .optional(),
    contactPhone: z
      .string()
      .trim()
      .regex(/^[+0-9 ()\-.]{5,30}$/)
      .nullable()
      .optional(),
    techNeeds: plainTextMultilineOptional(2000).nullable().optional(),
    messageTemplate: plainTextMultilineOptional(2000).nullable().optional(),
    feeType: z.enum(["GUARANTEE", "DOOR_SPLIT", "NEGOTIABLE"]).nullable().optional(),
    feeAmountCents: z
      .number()
      .int()
      .positive()
      .max(BOOKING_FEE_AMOUNT_MAX_CENTS)
      .nullable()
      .optional(),
    linkMusic: optionalHttpUrl,
    linkVideo: optionalHttpUrl,
    linkSocial: optionalHttpUrl,
    linkEpk: optionalHttpUrl,
    includeVerifiedStats: z.boolean().nullable().optional(),
  })
  .strict();

export const updatePerformerBookingDefaultsInputSchema =
  updatePerformerBookingDefaultsBaseSchema.refine(
    // A fee amount only makes sense for a concrete ask (GUARANTEE/DOOR_SPLIT) —
    // same cross-field rule as create-booking-request. NEGOTIABLE (or an
    // omitted/null feeType) must not carry an amount.
    (v) =>
      v.feeAmountCents == null ||
      v.feeType === "GUARANTEE" ||
      v.feeType === "DOOR_SPLIT",
    {
      message: "fee_amount_requires_guarantee_or_door_split",
      path: ["feeAmountCents"],
    },
  );

export const updatePerformerBookingDefaultsOutputSchema = z
  .object({
    ok: z.literal(true),
  })
  .strict();

export type UpdatePerformerBookingDefaultsInput = z.infer<
  typeof updatePerformerBookingDefaultsInputSchema
>;
export type UpdatePerformerBookingDefaultsOutput = z.infer<
  typeof updatePerformerBookingDefaultsOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type UpdatePerformerBookingDefaultsDeps = {
  repos: Pick<Repos, "tx" | "performerBookingDefaults" | "authz" | "audit">;
  clock: ClockPort;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Save (create-or-replace) a performer's booking-request form defaults
 * (performer-mode.spec, 2026-07-11). Owner-access gated: self for a human
 * owner, org EDIT roles for an org owner (same gate as the booking create
 * path). Field validation mirrors create-booking-request exactly.
 *
 * A save carries the FULL desired form state — an omitted or null field clears
 * the stored value. `feeCurrency` is derived server-side (platform base
 * snapshotted iff an amount is present), never trusted from the client, and
 * `genre` is not stored (it comes from Human.genreTags).
 */
export async function updatePerformerBookingDefaults(
  deps: UpdatePerformerBookingDefaultsDeps,
  rawInput: unknown,
): Promise<UpdatePerformerBookingDefaultsOutput> {
  const input = parseInput(updatePerformerBookingDefaultsInputSchema, rawInput);

  await requireOwnerAccess({
    repos: deps.repos,
    ownerType: input.ownerType === "human" ? "HUMAN" : "ORGANIZATION",
    ownerId: input.ownerId,
    actorHumanId: input.actorHumanId,
    roles: ORG_EDIT_ROLES,
  });

  const ownerType = toPerformerOwnerType(input.ownerType);

  const feeAmountCents = input.feeAmountCents ?? null;
  // Snapshot the fee currency only when an amount is present (mirrors
  // create-booking-request). Cleared alongside the amount otherwise.
  const feeCurrency =
    feeAmountCents !== null ? BOOKING_FEE_DEFAULT_CURRENCY : null;

  const now = deps.clock.now();

  const saved = await deps.repos.tx(async (tx) => {
    const record = await tx.performerBookingDefaults.upsert({
      ownerType,
      ownerId: input.ownerId,
      actName: input.actName ?? null,
      lineupSize: input.lineupSize ?? null,
      setLengthMinutes: input.setLengthMinutes ?? null,
      techNeeds: input.techNeeds ?? null,
      contactPhone: input.contactPhone ?? null,
      feeType: input.feeType ?? null,
      feeAmountCents,
      feeCurrency,
      messageTemplate: input.messageTemplate ?? null,
      includeVerifiedStats: input.includeVerifiedStats ?? null,
      linkMusic: input.linkMusic ?? null,
      linkVideo: input.linkVideo ?? null,
      linkSocial: input.linkSocial ?? null,
      linkEpk: input.linkEpk ?? null,
    });

    await tx.audit.log({
      entity: "performer_booking_defaults",
      entityId: record.id,
      action: "performer_booking_defaults.updated",
      data: {
        ownerType,
        ownerId: input.ownerId,
        actorHumanId: input.actorHumanId,
      },
      at: now,
    });

    return record;
  });

  deps.logger?.info("performers.booking_defaults_updated", {
    performerBookingDefaultsId: saved.id,
    ownerType,
    ownerId: input.ownerId,
    actorHumanId: input.actorHumanId,
  });

  return updatePerformerBookingDefaultsOutputSchema.parse({ ok: true });
}
