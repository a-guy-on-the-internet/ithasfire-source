import { TRPCError } from "@trpc/server";
import {
  addContactListEntry,
  addContactListEntryInputSchema,
  importContacts,
  importContactsInputSchema,
  importContactsOutputSchema,
  mergeContactLists,
  mergeContactListsInputSchema,
  mergeContactListsOutputSchema,
  updateContactListEntry,
  updateContactListEntryInputSchema,
} from "@th/core/use-cases/comms";
import { z } from "zod";
import { authedProcedure } from "../init";
import { toTrpcError } from "../utils";

const importContactsInput = importContactsInputSchema.omit({
  actorHumanId: true,
});
const mergeContactListsInput = mergeContactListsInputSchema.omit({
  actorHumanId: true,
});

const ALLOWED_ROLES = new Set(["OWNER", "ADMIN", "EDITOR"]);

const ownerSchema = z.object({
  kind: z.enum(["ORG", "HUMAN"]),
  id: z.string().uuid(),
});

const listContactImportsInput = z.object({
  owner: ownerSchema,
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).optional(),
});

const listAudiencesInput = z.object({
  owner: ownerSchema,
});

const getAudienceInput = z.object({
  listId: z.string().uuid(),
});

const createAudienceInput = z.object({
  owner: ownerSchema,
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
});

const updateAudienceInput = z.object({
  listId: z.string().uuid(),
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).nullable().optional(),
});

const deleteAudienceInput = z.object({
  listId: z.string().uuid(),
});

const listAudienceEntriesInput = z.object({
  listId: z.string().uuid(),
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).optional(),
  search: z.string().max(200).optional(),
});

const exportAudienceEntriesInput = z.object({
  listId: z.string().uuid(),
});

const deleteAudienceEntryInput = z.object({
  listId: z.string().uuid(),
  entryId: z.string().uuid(),
});

const createAudienceEntryInput = addContactListEntryInputSchema.omit({
  actorHumanId: true,
});

const updateAudienceEntryInput = updateContactListEntryInputSchema.omit({
  actorHumanId: true,
});

async function ensureOwnerAccess(
  ctx: { repos: any; actorHumanId: string | null },
  owner: { kind: "ORG" | "HUMAN"; id: string },
) {
  const actorHumanId = ctx.actorHumanId;
  if (!actorHumanId) throw new TRPCError({ code: "UNAUTHORIZED" });

  const ownerType =
    owner.kind === "ORG" ? ("ORGANIZATION" as const) : ("HUMAN" as const);

  if (ownerType === "HUMAN" && owner.id !== actorHumanId) {
    throw new TRPCError({ code: "FORBIDDEN" });
  }
  if (ownerType === "ORGANIZATION") {
    const membership = await ctx.repos.authz.getOrgMembership({
      orgId: owner.id,
      humanId: actorHumanId,
    });
    if (!membership || !ALLOWED_ROLES.has(membership.role)) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
  }

  return { ownerType, actorHumanId };
}

async function ensureListAccess(
  ctx: { repos: any; actorHumanId: string | null },
  listId: string,
) {
  const actorHumanId = ctx.actorHumanId;
  if (!actorHumanId) throw new TRPCError({ code: "UNAUTHORIZED" });

  const list = await ctx.repos.inviteLists.getListById(listId);
  if (!list)
    throw new TRPCError({ code: "NOT_FOUND", message: "list_not_found" });

  const ownerKind =
    list.ownerType === "ORGANIZATION" ? ("ORG" as const) : ("HUMAN" as const);
  await ensureOwnerAccess(ctx, { kind: ownerKind, id: list.ownerId });

  return { list, actorHumanId };
}

export const commsRouter = {
  importContacts: authedProcedure
    .input(importContactsInput)
    .output(importContactsOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof importContacts>[0];

      try {
        return await importContacts(deps, { ...input, actorHumanId });
      } catch (error) {
        throw toTrpcError(error);
      }
    }),

  mergeContactLists: authedProcedure
    .input(mergeContactListsInput)
    .output(mergeContactListsOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof mergeContactLists>[0];

      try {
        return await mergeContactLists(deps, { ...input, actorHumanId });
      } catch (error) {
        throw toTrpcError(error);
      }
    }),

  listContactImports: authedProcedure
    .input(listContactImportsInput)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      try {
        const ownerType =
          input.owner.kind === "ORG"
            ? ("ORGANIZATION" as const)
            : ("HUMAN" as const);

        // Authorization check
        if (ownerType === "HUMAN" && input.owner.id !== actorHumanId) {
          throw new TRPCError({ code: "FORBIDDEN" });
        }
        if (ownerType === "ORGANIZATION") {
          const membership = await ctx.repos.authz.getOrgMembership({
            orgId: input.owner.id,
            humanId: actorHumanId,
          });
          if (
            !membership ||
            !["OWNER", "ADMIN", "EDITOR"].includes(membership.role)
          ) {
            throw new TRPCError({ code: "FORBIDDEN" });
          }
        }

        return await ctx.repos.contactImports.listByOwner({
          ownerType,
          ownerId: input.owner.id,
          limit: input.limit,
          offset: input.offset,
        });
      } catch (error) {
        throw toTrpcError(error);
      }
    }),

  // ── Audience CRUD ──────────────────────────────────────────────────────

  listAudiences: authedProcedure
    .input(listAudiencesInput)
    .query(async ({ ctx, input }) => {
      try {
        const { ownerType } = await ensureOwnerAccess(ctx, input.owner);
        return await ctx.repos.inviteLists.listByOwner({
          ownerType,
          ownerId: input.owner.id,
        });
      } catch (error) {
        throw toTrpcError(error);
      }
    }),

  getAudience: authedProcedure
    .input(getAudienceInput)
    .query(async ({ ctx, input }) => {
      try {
        const { list } = await ensureListAccess(ctx, input.listId);
        return list;
      } catch (error) {
        throw toTrpcError(error);
      }
    }),

  createAudience: authedProcedure
    .input(createAudienceInput)
    .mutation(async ({ ctx, input }) => {
      try {
        const { ownerType } = await ensureOwnerAccess(ctx, input.owner);
        return await ctx.repos.inviteLists.createList({
          ownerType,
          ownerId: input.owner.id,
          name: input.name,
          description: input.description,
        });
      } catch (error) {
        throw toTrpcError(error);
      }
    }),

  updateAudience: authedProcedure
    .input(updateAudienceInput)
    .mutation(async ({ ctx, input }) => {
      try {
        await ensureListAccess(ctx, input.listId);
        return await ctx.repos.inviteLists.updateList({
          inviteListId: input.listId,
          name: input.name,
          description: input.description,
        });
      } catch (error) {
        throw toTrpcError(error);
      }
    }),

  deleteAudience: authedProcedure
    .input(deleteAudienceInput)
    .mutation(async ({ ctx, input }) => {
      try {
        await ensureListAccess(ctx, input.listId);
        await ctx.repos.inviteLists.deleteList(input.listId);
        return { ok: true };
      } catch (error) {
        throw toTrpcError(error);
      }
    }),

  listAudienceEntries: authedProcedure
    .input(listAudienceEntriesInput)
    .query(async ({ ctx, input }) => {
      try {
        await ensureListAccess(ctx, input.listId);
        return await ctx.repos.inviteLists.listEntries({
          inviteListId: input.listId,
          limit: input.limit,
          offset: input.offset,
          search: input.search,
        });
      } catch (error) {
        throw toTrpcError(error);
      }
    }),

  exportAudienceEntries: authedProcedure
    .input(exportAudienceEntriesInput)
    .query(async ({ ctx, input }) => {
      try {
        await ensureListAccess(ctx, input.listId);
        // Fetch all entries (up to 10 000) without search filter for full export.
        return await ctx.repos.inviteLists.listEntries({
          inviteListId: input.listId,
          limit: 10_000,
          offset: 0,
        });
      } catch (error) {
        throw toTrpcError(error);
      }
    }),

  deleteAudienceEntry: authedProcedure
    .input(deleteAudienceEntryInput)
    .mutation(async ({ ctx, input }) => {
      try {
        // Authorize the LIST, then delete only an entry that is in it
        // (security review F9: this used to delete any entry id, unchecked).
        await ensureListAccess(ctx, input.listId);
        const { deleted } = await ctx.repos.inviteLists.deleteEntry({
          entryId: input.entryId,
          inviteListId: input.listId,
        });
        if (!deleted) {
          throw new TRPCError({ code: "NOT_FOUND", message: "entry_not_found" });
        }
        await ctx.repos.inviteLists.updateListCounts(input.listId);
        return { ok: true };
      } catch (error) {
        throw toTrpcError(error);
      }
    }),

  createAudienceEntry: authedProcedure
    .input(createAudienceEntryInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) throw new TRPCError({ code: "UNAUTHORIZED" });

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
      } satisfies Parameters<typeof addContactListEntry>[0];

      try {
        // Verified-email gate + consent stamp, same bar as importContacts
        // (security review F8).
        return await addContactListEntry(deps, { ...input, actorHumanId });
      } catch (error) {
        throw toTrpcError(error);
      }
    }),

  updateAudienceEntry: authedProcedure
    .input(updateAudienceEntryInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) throw new TRPCError({ code: "UNAUTHORIZED" });

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
      } satisfies Parameters<typeof updateContactListEntry>[0];

      try {
        // Verified email, list access, list-scoped write and a consent
        // restamp on email change (security review F8/F9).
        return await updateContactListEntry(deps, { ...input, actorHumanId });
      } catch (error) {
        throw toTrpcError(error);
      }
    }),
};
