import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { SAVED_SNIPPETS_MAX_PER_KIND } from "@th/types/repos/saved-snippets";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { lockListAndCopyStarters } from "./_shared/copy-starters";
import {
  resolveSavedSnippetOwner,
  savedSnippetOwnerInputSchema,
} from "./_shared/saved-snippet-owner";
import {
  savedSnippetBodySchema,
  savedSnippetKindInputSchema,
  savedSnippetLabelSchema,
  savedSnippetOutputSchema,
  starterLocaleInputSchema,
  toSavedSnippetOutput,
} from "./_shared/saved-snippet-schemas";

// ─────────────────────────────────────────────────────────────────────────────
// Managing saved reasons (booking-the-night FR-013): "Reasons you often give"
// in booking settings. Every mutation resolves the owner for WRITE first
// (see saved-snippet-owner.ts), then runs in ONE transaction with its audit
// row. The owner pair goes into every repo call's WHERE, so a snippet id from
// another owner reads as absent.
//
// THE LIST LOCK. create and reorder take `lockList` before anything else in
// their transaction (port doc). create goes through
// `lockListAndCopyStarters`: a list's first use copies the platform starters,
// whether that use is a read or a create, so the starters always come first
// and the 30-per-list cap is counted under the lock, on the list it writes.
// update and delete change neither membership-against-the-cap nor order, so
// they do not lock.
// ─────────────────────────────────────────────────────────────────────────────

export type ManageSavedSnippetsDeps = {
  repos: Pick<
    Repos,
    | "tx"
    | "savedSnippets"
    | "authz"
    | "places"
    | "placeBookingGrants"
    | "humanDelegates"
    | "calendars"
    | "humans"
    | "audit"
  >;
  clock: ClockPort;
  logger?: LoggerPort;
};

const AUDIT_ENTITY = "saved_snippet";

/** The adapter's (and fake's) stale-order refusal, from `SavedSnippetsRepo.reorder`. */
function isOrderChangedConflict(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "conflict" &&
    (err as { message?: unknown }).message === "saved_snippet_order_changed"
  );
}

// ── create ───────────────────────────────────────────────────────────────────

export const createSavedSnippetInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    owner: savedSnippetOwnerInputSchema,
    kind: savedSnippetKindInputSchema,
    label: savedSnippetLabelSchema,
    body: savedSnippetBodySchema,
    /** Starter language if this create is the list's first use. */
    locale: starterLocaleInputSchema,
  })
  .strict();

export const createSavedSnippetOutputSchema = z
  .object({ snippet: savedSnippetOutputSchema })
  .strict();

export type CreateSavedSnippetInput = z.input<typeof createSavedSnippetInputSchema>;
export type CreateSavedSnippetOutput = z.infer<typeof createSavedSnippetOutputSchema>;

/** Append a reason to the end of the list. SAVED_SNIPPET_LIMIT_REACHED at 30. */
export async function createSavedSnippet(
  deps: ManageSavedSnippetsDeps,
  rawInput: unknown,
): Promise<CreateSavedSnippetOutput> {
  const input = parseInput(createSavedSnippetInputSchema, rawInput);
  const now = deps.clock.now();
  const owner = await resolveSavedSnippetOwner(deps.repos, {
    actorHumanId: input.actorHumanId,
    owner: input.owner,
    access: "write",
    now,
  });
  const key = { ...owner, kind: input.kind };

  const snippet = await deps.repos.tx(async (tx) => {
    await lockListAndCopyStarters(tx, {
      key,
      actorHumanId: input.actorHumanId,
      requestedLocale: input.locale ?? null,
      now,
    });
    // Counted under the lock: the list counted is the list written.
    const list = await tx.savedSnippets.listByOwner(key);
    if (list.length >= SAVED_SNIPPETS_MAX_PER_KIND) {
      throw fail("SAVED_SNIPPET_LIMIT_REACHED", {
        meta: { max: SAVED_SNIPPETS_MAX_PER_KIND },
      });
    }
    const sortOrder = list.reduce((max, row) => Math.max(max, row.sortOrder), -1) + 1;
    const created = await tx.savedSnippets.create({
      ...key,
      label: input.label,
      body: input.body,
      sortOrder,
      isStarter: false,
    });
    await tx.audit.log({
      entity: AUDIT_ENTITY,
      entityId: created.id,
      action: "saved_snippet.created",
      data: {
        actorHumanId: input.actorHumanId,
        ownerType: key.ownerType,
        ownerId: key.ownerId,
        kind: key.kind,
        label: created.label,
      },
      at: now,
    });
    return created;
  });

  return createSavedSnippetOutputSchema.parse({
    snippet: toSavedSnippetOutput(snippet),
  });
}

// ── update ───────────────────────────────────────────────────────────────────

export const updateSavedSnippetInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    owner: savedSnippetOwnerInputSchema,
    snippetId: z.uuid(),
    label: savedSnippetLabelSchema.optional(),
    body: savedSnippetBodySchema.optional(),
  })
  .strict();

export const updateSavedSnippetOutputSchema = createSavedSnippetOutputSchema;

export type UpdateSavedSnippetInput = z.input<typeof updateSavedSnippetInputSchema>;
export type UpdateSavedSnippetOutput = z.infer<typeof updateSavedSnippetOutputSchema>;

/** Edit a reason's label and/or body. A starter stays a starter (`isStarter`). */
export async function updateSavedSnippet(
  deps: ManageSavedSnippetsDeps,
  rawInput: unknown,
): Promise<UpdateSavedSnippetOutput> {
  const input = parseInput(updateSavedSnippetInputSchema, rawInput);
  // Checked here, not as a schema refine, so the transport can `.omit()` the
  // actor from the plain object schema.
  if (input.label === undefined && input.body === undefined) {
    throw fail("INVALID_INPUT", { message: "nothing_to_update" });
  }
  const now = deps.clock.now();
  const owner = await resolveSavedSnippetOwner(deps.repos, {
    actorHumanId: input.actorHumanId,
    owner: input.owner,
    access: "write",
    now,
  });

  const snippet = await deps.repos.tx(async (tx) => {
    const updated = await tx.savedSnippets.update({
      ...owner,
      id: input.snippetId,
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
    });
    if (!updated) {
      throw fail("SAVED_SNIPPET_NOT_FOUND", {
        meta: { snippetId: input.snippetId },
      });
    }
    await tx.audit.log({
      entity: AUDIT_ENTITY,
      entityId: updated.id,
      action: "saved_snippet.updated",
      data: {
        actorHumanId: input.actorHumanId,
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
        kind: updated.kind,
        label: updated.label,
        changed: [
          ...(input.label !== undefined ? ["label"] : []),
          ...(input.body !== undefined ? ["body"] : []),
        ],
      },
      at: now,
    });
    return updated;
  });

  return updateSavedSnippetOutputSchema.parse({
    snippet: toSavedSnippetOutput(snippet),
  });
}

// ── delete ───────────────────────────────────────────────────────────────────

export const deleteSavedSnippetInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    owner: savedSnippetOwnerInputSchema,
    snippetId: z.uuid(),
  })
  .strict();

export const deleteSavedSnippetOutputSchema = z
  .object({ snippetId: z.uuid(), deleted: z.boolean() })
  .strict();

export type DeleteSavedSnippetInput = z.input<typeof deleteSavedSnippetInputSchema>;
export type DeleteSavedSnippetOutput = z.infer<typeof deleteSavedSnippetOutputSchema>;

/**
 * Remove a reason, starters included. Idempotent: an id that is gone (or
 * another owner's) is `deleted: false`. Deleting every reason leaves an empty
 * list — the starters are never copied again.
 */
export async function deleteSavedSnippet(
  deps: ManageSavedSnippetsDeps,
  rawInput: unknown,
): Promise<DeleteSavedSnippetOutput> {
  const input = parseInput(deleteSavedSnippetInputSchema, rawInput);
  const now = deps.clock.now();
  const owner = await resolveSavedSnippetOwner(deps.repos, {
    actorHumanId: input.actorHumanId,
    owner: input.owner,
    access: "write",
    now,
  });

  const deleted = await deps.repos.tx(async (tx) => {
    const removed = await tx.savedSnippets.delete({ ...owner, id: input.snippetId });
    if (removed) {
      await tx.audit.log({
        entity: AUDIT_ENTITY,
        entityId: input.snippetId,
        action: "saved_snippet.deleted",
        data: {
          actorHumanId: input.actorHumanId,
          ownerType: owner.ownerType,
          ownerId: owner.ownerId,
        },
        at: now,
      });
    }
    return removed;
  });

  return deleteSavedSnippetOutputSchema.parse({
    snippetId: input.snippetId,
    deleted,
  });
}

// ── reorder ──────────────────────────────────────────────────────────────────

export const reorderSavedSnippetsInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    owner: savedSnippetOwnerInputSchema,
    kind: savedSnippetKindInputSchema,
    /** Exactly the list's ids, in the new order. */
    orderedIds: z.array(z.uuid()).max(SAVED_SNIPPETS_MAX_PER_KIND),
  })
  .strict();

export const reorderSavedSnippetsOutputSchema = z
  .object({ snippets: z.array(savedSnippetOutputSchema) })
  .strict();

export type ReorderSavedSnippetsInput = z.input<typeof reorderSavedSnippetsInputSchema>;
export type ReorderSavedSnippetsOutput = z.infer<typeof reorderSavedSnippetsOutputSchema>;

/**
 * Replace the list's order. `orderedIds` must name exactly the list as it is
 * now; anything else (a reason added or removed since the client read it, a
 * foreign id, a duplicate) writes nothing and is SAVED_SNIPPET_ORDER_CHANGED.
 */
export async function reorderSavedSnippets(
  deps: ManageSavedSnippetsDeps,
  rawInput: unknown,
): Promise<ReorderSavedSnippetsOutput> {
  const input = parseInput(reorderSavedSnippetsInputSchema, rawInput);
  const now = deps.clock.now();
  const owner = await resolveSavedSnippetOwner(deps.repos, {
    actorHumanId: input.actorHumanId,
    owner: input.owner,
    access: "write",
    now,
  });
  const key = { ...owner, kind: input.kind };

  const snippets = await deps.repos.tx(async (tx) => {
    await tx.savedSnippets.lockList(key);
    let reordered;
    try {
      reordered = await tx.savedSnippets.reorder({
        ...key,
        orderedIds: input.orderedIds,
      });
    } catch (err) {
      if (isOrderChangedConflict(err)) {
        throw fail("SAVED_SNIPPET_ORDER_CHANGED");
      }
      throw err;
    }
    await tx.audit.log({
      entity: AUDIT_ENTITY,
      entityId: null,
      action: "saved_snippets.reordered",
      data: {
        actorHumanId: input.actorHumanId,
        ownerType: key.ownerType,
        ownerId: key.ownerId,
        kind: key.kind,
        orderedIds: input.orderedIds,
      },
      at: now,
    });
    return reordered;
  });

  return reorderSavedSnippetsOutputSchema.parse({
    snippets: snippets.map(toSavedSnippetOutput),
  });
}
