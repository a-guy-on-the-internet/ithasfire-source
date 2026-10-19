import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { Repos } from "@th/ports/repos";
import type { InviteListEntryRecord } from "@th/ports/repos/events";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { requireOwnerAccess, ORG_EDIT_ROLES } from "../../lib/rbac";
import { plainTextOptional } from "../../lib/sanitize-plain-text";
import { ensureEmailVerified } from "../_helpers/ensure-email-verified";
import { isUniqueViolation } from "../places/_shared/claim";

/**
 * Consent source stamped when the sender adds one contact by hand and does
 * not say where consent came from. Imports leave it null in that case; a
 * single add is always a person typing an address in, so say so.
 */
export const MANUAL_ENTRY_CONSENT_SOURCE = "manual_entry";

export const addContactListEntryInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    listId: z.string().uuid(),
    contactEmail: z.string().email().max(320).nullable().optional(),
    contactPhone: z.string().max(50).nullable().optional(),
    displayName: plainTextOptional(200).nullable().optional(),
    tags: z.array(z.string().max(100)).max(50).optional(),
    consentSource: plainTextOptional(500).nullable().optional(),
  })
  .strict();

export type AddContactListEntryInput = z.infer<
  typeof addContactListEntryInputSchema
>;
export type AddContactListEntryOutput = InviteListEntryRecord;

export type AddContactListEntryDeps = {
  repos: Repos;
  clock: ClockPort;
};

/**
 * `@@unique([inviteListId, contactEmail])` / `([inviteListId, contactPhone])`:
 * the contact is already on this list. Checked OUTSIDE the transaction (an
 * in-tx P2002 aborts it) and mapped to a typed conflict instead of a 500.
 */
export async function withDuplicateContactAsConflict<T>(
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw fail("CONFLICT", {
        message: "contact_already_on_list",
        meta: { reason: "contact_already_on_list" },
        cause: err,
      });
    }
    throw err;
  }
}

/**
 * The bar for writing to a contact list, shared by add and update: a verified
 * email (as `importContacts` requires), an existing list, and an editing role
 * on the list's owner.
 */
export async function authorizeContactListEdit(
  repos: Repos,
  actorHumanId: string,
  listId: string,
): Promise<void> {
  await ensureEmailVerified(repos, actorHumanId);

  const list = await repos.inviteLists.getListById(listId);
  if (!list) {
    throw fail("TARGET_LIST_NOT_FOUND");
  }

  await requireOwnerAccess({
    repos,
    ownerType: list.ownerType as "HUMAN" | "ORGANIZATION",
    ownerId: list.ownerId,
    actorHumanId,
    roles: ORG_EDIT_ROLES,
    errorCode: "INSUFFICIENT_ROLE",
  });
}

/**
 * Add one contact to a contact list (`comms.createAudienceEntry`).
 *
 * Holds a single add to the same bar as a bulk `importContacts`: the actor
 * must have a verified email, and the entry records consent (source + time).
 * Without this, a hand-added contact list was the unverified back door to
 * `announcements.send` (security review F8, 2026-09-29).
 *
 * @throws `forbidden` / `email_verification_required` when the actor's email
 *   is unverified.
 * @throws `TARGET_LIST_NOT_FOUND` when the list does not exist.
 * @throws `INSUFFICIENT_ROLE` when the actor cannot edit the list's owner.
 * @throws `CONFLICT` when that email/phone is already on the list.
 */
export async function addContactListEntry(
  deps: AddContactListEntryDeps,
  rawInput: unknown,
): Promise<AddContactListEntryOutput> {
  const input = parseInput(addContactListEntryInputSchema, rawInput);

  await authorizeContactListEdit(deps.repos, input.actorHumanId, input.listId);

  const now = deps.clock.now();
  const consentSource = input.consentSource || MANUAL_ENTRY_CONSENT_SOURCE;

  return withDuplicateContactAsConflict(() =>
    deps.repos.tx(async (tx) => {
      const entry = await tx.inviteLists.createEntry({
        inviteListId: input.listId,
        contactEmail: input.contactEmail ?? null,
        contactPhone: input.contactPhone ?? null,
        displayName: input.displayName || null,
        tags: input.tags,
        consentSource,
        consentRecordedAt: now,
      });

      await tx.inviteLists.updateListCounts(input.listId);

      await tx.audit.log({
        entity: "invite_list",
        entityId: input.listId,
        action: "comms.contact_list.entry_added",
        data: {
          actorHumanId: input.actorHumanId,
          entryId: entry.id,
          consentSource,
        },
        at: now,
      });

      return entry;
    }),
  );
}
