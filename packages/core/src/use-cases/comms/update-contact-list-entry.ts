import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { Repos } from "@th/ports/repos";
import type {
  InviteListEntryRecord,
  UpdateInviteListEntryInput,
} from "@th/ports/repos/events";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { plainTextOptional } from "../../lib/sanitize-plain-text";
import {
  authorizeContactListEdit,
  MANUAL_ENTRY_CONSENT_SOURCE,
  withDuplicateContactAsConflict,
} from "./add-contact-list-entry";

export const updateContactListEntryInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    listId: z.string().uuid(),
    entryId: z.string().uuid(),
    contactEmail: z.string().email().max(320).nullable().optional(),
    contactPhone: z.string().max(50).nullable().optional(),
    displayName: plainTextOptional(200).nullable().optional(),
    tags: z.array(z.string().max(100)).max(50).optional(),
    /** Recorded only when the email changes; defaults to manual entry. */
    consentSource: plainTextOptional(500).nullable().optional(),
  })
  .strict();

export type UpdateContactListEntryInput = z.infer<
  typeof updateContactListEntryInputSchema
>;
export type UpdateContactListEntryOutput = InviteListEntryRecord;

export type UpdateContactListEntryDeps = {
  repos: Repos;
  clock: ClockPort;
};

const sameEmail = (
  a: string | null | undefined,
  b: string | null | undefined,
) => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

/**
 * Edit one contact-list entry (`comms.updateAudienceEntry`).
 *
 * Same bar as adding one (`authorizeContactListEdit`: verified email, list
 * exists, editing role). Rewriting an entry's email is equivalent to adding a
 * new contact, so a changed email restamps consent (source + time) — the
 * old address's consent does not carry over to the new one (security review
 * F8/F9, round 2). The write is scoped to `{ entryId, listId }`.
 *
 * @throws `NOT_FOUND` when no such entry exists in that list.
 * @throws `CONFLICT` when the new email/phone is already on the list.
 */
export async function updateContactListEntry(
  deps: UpdateContactListEntryDeps,
  rawInput: unknown,
): Promise<UpdateContactListEntryOutput> {
  const input = parseInput(updateContactListEntryInputSchema, rawInput);

  await authorizeContactListEdit(deps.repos, input.actorHumanId, input.listId);

  const now = deps.clock.now();

  return withDuplicateContactAsConflict(() =>
    deps.repos.tx(async (tx) => {
      const existing = await tx.inviteLists.getEntry({
        entryId: input.entryId,
        inviteListId: input.listId,
      });
      if (!existing) {
        throw fail("NOT_FOUND", { meta: { entity: "contact_list_entry" } });
      }

      const patch: UpdateInviteListEntryInput = {
        entryId: input.entryId,
        inviteListId: input.listId,
      };
      // Only fields the caller sent — an omitted field is left untouched.
      if (input.contactEmail !== undefined)
        patch.contactEmail = input.contactEmail;
      if (input.contactPhone !== undefined)
        patch.contactPhone = input.contactPhone;
      if (input.displayName !== undefined) {
        patch.displayName = input.displayName || null;
      }
      if (input.tags !== undefined) patch.tags = input.tags;

      const emailChanged =
        input.contactEmail !== undefined &&
        input.contactEmail !== null &&
        !sameEmail(input.contactEmail, existing.contactEmail);
      if (emailChanged) {
        patch.consentSource =
          input.consentSource || MANUAL_ENTRY_CONSENT_SOURCE;
        patch.consentRecordedAt = now;
      }

      const updated = await tx.inviteLists.updateEntry(patch);
      if (!updated) {
        throw fail("NOT_FOUND", { meta: { entity: "contact_list_entry" } });
      }

      await tx.audit.log({
        entity: "invite_list",
        entityId: input.listId,
        action: "comms.contact_list.entry_updated",
        data: {
          actorHumanId: input.actorHumanId,
          entryId: input.entryId,
          emailChanged,
          ...(emailChanged ? { consentSource: patch.consentSource } : {}),
        },
        at: now,
      });

      return updated;
    }),
  );
}
