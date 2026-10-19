import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos, TxRepos } from "@th/ports/repos";
import { abandonClaim } from "../../lib/idempotency-claim";
import { parseInput } from "../../lib/io";
import { requireOrgMembership, ORG_EDIT_ROLES } from "../../lib/rbac";
import { ensureEmailVerified } from "../_helpers/ensure-email-verified";
import { fail } from "@th/errors";

const MAX_CHUNK_SIZE = 5_000;
const IDEMPOTENCY_TTL_SECONDS = 120;

const contactEntrySchema = z.object({
  contactEmail: z.string().email().optional().nullable(),
  contactPhone: z.string().min(5).optional().nullable(),
  displayName: z.string().max(200).optional().nullable(),
  tags: z.array(z.string().max(100)).max(20).optional(),
  notes: z.string().max(500).optional().nullable(),
});

export const importContactsInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  owner: z.object({
    kind: z.enum(["ORG", "HUMAN"]),
    id: z.string().uuid(),
  }),
  importId: z.string().uuid().optional(),
  targetListId: z.string().uuid().optional(),
  targetListName: z.string().min(1).max(200).optional(),
  fileName: z.string().min(1).max(500),
  fileFormat: z.enum(["CSV", "XLSX"]),
  contacts: z.array(contactEntrySchema).min(1).max(MAX_CHUNK_SIZE),
  totalRows: z.number().int().nonnegative().optional(),
  totalChunks: z.number().int().positive().optional(),
  chunkIndex: z.number().int().nonnegative(),
  isFinalChunk: z.boolean(),
  consentSource: z.string().max(500).optional(),
  clientKey: z.string().min(8),
  /** When true and importing into an existing list, delete all existing entries before inserting the first chunk. */
  clearExisting: z.boolean().optional(),
});

export const importContactsOutputSchema = z.object({
  importId: z.string().uuid(),
  inviteListId: z.string().uuid(),
  chunkIndex: z.number().int(),
  chunkImportedCount: z.number().int(),
  chunkSkippedCount: z.number().int(),
  runningImportedCount: z.number().int(),
  runningSkippedCount: z.number().int(),
  linkedToAuthUserCount: z.number().int(),
  /** Number of entries cleared before import (only on first chunk when clearExisting=true). */
  clearedCount: z.number().int().optional(),
});

export type ImportContactsInput = z.infer<typeof importContactsInputSchema>;
export type ImportContactsOutput = z.infer<typeof importContactsOutputSchema>;

export type ImportContactsDeps = {
  repos: Repos;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
  reportError?: ReporterPort;
};

interface StoredImportContactsRecord {
  payloadHash: string;
  response: ImportContactsOutput;
}

function buildIdempotencyKey(
  ownerKind: string,
  ownerId: string,
  clientKey: string,
  chunkIndex: number,
): string {
  return `comms:importContacts:${ownerKind}:${ownerId}:${clientKey}:chunk${chunkIndex}`;
}

function buildPayloadHash(input: ImportContactsInput): string {
  return `${input.owner.kind}:${input.owner.id}:${input.clientKey}:${input.chunkIndex}:${input.contacts.length}`;
}

export async function importContacts(
  deps: ImportContactsDeps,
  rawInput: unknown,
): Promise<ImportContactsOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "importContacts" });
  const input = parseInput(importContactsInputSchema, rawInput);

  const idempotencyKey = buildIdempotencyKey(
    input.owner.kind,
    input.owner.id,
    input.clientKey,
    input.chunkIndex,
  );
  const payloadHash = buildPayloadHash(input);

  // Idempotency check
  const replay =
    await deps.idempotency.get<StoredImportContactsRecord>(idempotencyKey);
  if (replay) {
    if (replay.payloadHash !== payloadHash) {
      throw fail("IDEMPOTENCY_KEY_CONFLICT");
    }
    return replay.response;
  }

  const ownerToken = crypto.randomUUID();
  const claimed = await deps.idempotency.begin(
    idempotencyKey,
    IDEMPOTENCY_TTL_SECONDS,
    ownerToken,
  );
  if (!claimed) {
    const afterWait =
      await deps.idempotency.get<StoredImportContactsRecord>(idempotencyKey);
    if (afterWait) {
      if (afterWait.payloadHash !== payloadHash) {
        throw fail("IDEMPOTENCY_KEY_CONFLICT");
      }
      return afterWait.response;
    }
    throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS");
  }

  let result: ImportContactsOutput;
  try {
    // Gates and lookups run BEFORE the transaction opens, on the
    // non-transactional repo bag. They are pure reads that need no
    // transactional consistency.

    // Email verification gate
    await ensureEmailVerified(deps.repos, input.actorHumanId);

    // Authorize actor
    await ensureActorAuthorized(deps.repos, input.actorHumanId, input.owner);

    // Batch lookup AuthUser emails to link humanId.
    //
    // A failed lookup PROPAGATES and fails the chunk. It used to be swallowed
    // inside the transaction, which was wrong in both directions:
    //   - a database failure aborts the Postgres session (a SELECT aborts it
    //     exactly as an INSERT does), so the subsequent `batchUpsertEntries`
    //     raised 25P02 and the import failed anyway — with the real cause
    //     hidden behind a `logger.warn` that Sentry never captures;
    //   - a JS-side adapter failure did NOT abort, so the chunk COMMITTED with
    //     every contact unlinked (`humanId: null`) and reported a fully
    //     successful import. Re-running hits the dedup path and never repairs
    //     it. The AuthUser linkage is not optional-quality data — it is what
    //     lets an imported contact resolve to a real account — so "success"
    //     without it is a lie the caller cannot detect.
    // The caller retries the chunk (the catch below releases the
    // claim), and no partial state is left behind because nothing has been
    // written yet.
    const emails = input.contacts
      .map((c) => c.contactEmail)
      .filter((e): e is string => !!e);
    const emailToHumanId =
      emails.length > 0
        ? await deps.repos.humans.batchLookupHumanIdsByEmail(emails)
        : new Map<string, string>();

    result = await deps.repos.tx(async (tx) => {
      const now = deps.clock.now();

      // Validate contacts: each must have at least one of email or phone
      for (const contact of input.contacts) {
        if (!contact.contactEmail && !contact.contactPhone) {
          throw fail("CONTACT_MUST_HAVE_EMAIL_OR_PHONE");
        }
      }

      const isFirstChunk = !input.importId;
      let importId: string;
      let inviteListId: string;
      let clearedCount: number | undefined;

      if (isFirstChunk) {
        // First chunk: resolve or create the target InviteList
        if (input.targetListId) {
          const existingList = await tx.inviteLists.getListById(
            input.targetListId,
          );
          if (!existingList) {
            throw fail("TARGET_LIST_NOT_FOUND");
          }
          if (
            existingList.ownerType !== mapOwnerKind(input.owner.kind) ||
            existingList.ownerId !== input.owner.id
          ) {
            throw fail("LIST_OWNER_MISMATCH");
          }
          inviteListId = existingList.id;
        } else {
          if (!input.targetListName) {
            throw fail("TARGET_LIST_NAME_REQUIRED_FOR_NEW_LIST");
          }
          const newList = await tx.inviteLists.createList({
            ownerType: mapOwnerKind(input.owner.kind),
            ownerId: input.owner.id,
            name: input.targetListName,
          });
          inviteListId = newList.id;
        }

        // Create the ContactImport ledger row
        const importRecord = await tx.contactImports.create({
          ownerType: mapOwnerKind(input.owner.kind),
          ownerId: input.owner.id,
          inviteListId,
          fileName: input.fileName,
          fileFormat: input.fileFormat,
          totalRows: input.totalRows ?? input.contacts.length,
          rejectedCount: 0,
          totalChunks: input.totalChunks ?? null,
          createdByHumanId: input.actorHumanId,
        });
        importId = importRecord.id;

        // If clearExisting is requested on an existing list, wipe its entries first
        if (input.clearExisting && input.targetListId) {
          clearedCount = await tx.inviteLists.deleteAllEntries(inviteListId);
          scopedLogger?.info("cleared_existing_entries", {
            inviteListId,
            clearedCount,
          });
        }
      } else {
        // Subsequent chunk: validate the existing import
        const existingImport = await tx.contactImports.getById(input.importId!);
        if (!existingImport) {
          throw fail("IMPORT_NOT_FOUND");
        }
        if (
          existingImport.ownerId !== input.owner.id ||
          existingImport.ownerType !== mapOwnerKind(input.owner.kind)
        ) {
          throw fail("IMPORT_OWNER_MISMATCH");
        }
        if (existingImport.completedAt) {
          throw fail("IMPORT_ALREADY_COMPLETED");
        }
        importId = existingImport.id;
        inviteListId = existingImport.inviteListId;
      }

      // Build entries for batch upsert
      const entries = input.contacts.map((contact) => ({
        contactEmail: contact.contactEmail ?? null,
        contactPhone: contact.contactPhone ?? null,
        displayName: contact.displayName ?? null,
        notes: contact.notes ?? null,
        tags: contact.tags ?? [],
        humanId: contact.contactEmail
          ? (emailToHumanId.get(contact.contactEmail) ?? null)
          : null,
        importId,
        consentSource: input.consentSource ?? null,
        consentRecordedAt: now,
      }));

      const linkedToAuthUserCount = entries.filter(
        (e) => e.humanId !== null,
      ).length;

      // Batch upsert with dedup
      const { insertedCount, skippedCount } =
        await tx.inviteLists.batchUpsertEntries({
          inviteListId,
          entries,
        });

      // Increment import ledger counts
      const updatedImport = await tx.contactImports.incrementCounts({
        importId,
        importedDelta: insertedCount,
        skippedDelta: skippedCount,
      });

      // Update list contact count
      await tx.inviteLists.updateListCounts(inviteListId);

      // If final chunk, mark import as completed and update list timestamp
      if (input.isFinalChunk) {
        await tx.contactImports.complete(importId, now);
        await tx.inviteLists.updateList({
          inviteListId,
        });
        // Update lastImportAt directly since updateList doesn't handle it
        // We use the underlying update via the list update path
      }

      // Audit log
      await tx.audit.log({
        entity: "contact_import",
        entityId: importId,
        action: input.isFinalChunk
          ? "comms.contact_import.completed"
          : "comms.contact_import.chunk_completed",
        data: {
          actorHumanId: input.actorHumanId,
          inviteListId,
          chunkIndex: input.chunkIndex,
          insertedCount,
          skippedCount,
          linkedToAuthUserCount,
          ...(clearedCount !== undefined ? { clearedCount } : {}),
        },
        at: now,
      });

      return {
        importId,
        inviteListId,
        chunkIndex: input.chunkIndex,
        chunkImportedCount: insertedCount,
        chunkSkippedCount: skippedCount,
        runningImportedCount: updatedImport.importedCount,
        runningSkippedCount: updatedImport.skippedCount,
        linkedToAuthUserCount,
        ...(clearedCount !== undefined ? { clearedCount } : {}),
      };
    });

  } catch (error) {
    // Transient failure: release the claim so the same-key retry proceeds at
    // once (see lib/idempotency-claim.ts). Commit is deliberately OUTSIDE.
    await abandonClaim(deps.idempotency, idempotencyKey, ownerToken, error, {
      useCase: "importContacts",
      logger: deps.logger,
      reportError: deps.reportError,
    });
    throw error;
  }

  await deps.idempotency.commit(
    idempotencyKey,
    { payloadHash, response: result },
    IDEMPOTENCY_TTL_SECONDS,
  );

  return result;
}

function mapOwnerKind(kind: "ORG" | "HUMAN"): "ORGANIZATION" | "HUMAN" {
  return kind === "ORG" ? "ORGANIZATION" : "HUMAN";
}

// Runs BEFORE the transaction opens (see the call site). Takes the full
// `Repos` bag, never `TxRepos`, so drifting it back inside is a compile error.
async function ensureActorAuthorized(
  repos: Repos,
  actorHumanId: string,
  owner: { kind: "ORG" | "HUMAN"; id: string },
): Promise<void> {
  if (owner.kind === "HUMAN") {
    if (owner.id !== actorHumanId) {
      throw fail("NOT_RESOURCE_OWNER");
    }
    return;
  }

  // Org: check membership role
  await requireOrgMembership({
    repos,
    orgId: owner.id,
    actorHumanId,
    roles: ORG_EDIT_ROLES,
    errorCode: "INSUFFICIENT_ROLE",
  });
}
