import type { EmbedRecord, EmbedsRepo } from "@th/ports/repos/embeds";
import type { PrismaClientOrTx } from "./types";

const EMBED_SELECT = {
  id: true,
  subjectType: true,
  subjectId: true,
  domain: true,
  status: true,
  requireAuth: true,
  linkOut: true,
  defaultView: true,
  viewToggle: true,
  createdBy: true,
  createdAt: true,
} as const;

type EmbedSelectResult = {
  id: string;
  subjectType: string;
  subjectId: string;
  domain: string;
  status: string;
  requireAuth: boolean;
  linkOut: boolean;
  defaultView: string;
  viewToggle: boolean;
  createdBy: string | null;
  createdAt: Date;
};

const mapEmbed = (record: EmbedSelectResult): EmbedRecord => ({
  id: record.id,
  subjectType: record.subjectType,
  subjectId: record.subjectId,
  domain: record.domain,
  status: record.status,
  requireAuth: record.requireAuth,
  linkOut: record.linkOut,
  defaultView: record.defaultView,
  viewToggle: record.viewToggle,
  createdBy: record.createdBy,
  createdAt: record.createdAt,
});

export function makeEmbedsRepo(p: PrismaClientOrTx): EmbedsRepo {
  return {
    upsert: async ({
      subjectType,
      subjectId,
      domain,
      createdBy,
      requireAuth,
      linkOut,
      defaultView,
      viewToggle,
    }) => {
      const record = await p.embed.upsert({
        where: {
          subjectType_subjectId_domain: { subjectType, subjectId, domain },
        },
        create: {
          subjectType,
          subjectId,
          domain,
          createdBy,
          status: "ACTIVE",
          requireAuth: requireAuth ?? false,
          linkOut: linkOut ?? false,
          // Mirrors the column defaults on purpose: a create that omits these
          // must land on today's behaviour (grid, no switcher).
          defaultView: defaultView ?? "list",
          viewToggle: viewToggle ?? false,
        },
        update: {
          status: "ACTIVE",
          createdBy,
          ...(requireAuth !== undefined ? { requireAuth } : {}),
          ...(linkOut !== undefined ? { linkOut } : {}),
          // Omitted ⇒ preserve stored (same discipline as linkOut).
          ...(defaultView !== undefined ? { defaultView } : {}),
          ...(viewToggle !== undefined ? { viewToggle } : {}),
        },
        select: EMBED_SELECT,
      });
      return mapEmbed(record);
    },

    listBySubject: async ({ subjectType, subjectId }) => {
      const records = await p.embed.findMany({
        where: { subjectType, subjectId },
        select: EMBED_SELECT,
        orderBy: { createdAt: "desc" },
      });
      return records.map(mapEmbed);
    },

    getById: async (id) => {
      const record = await p.embed.findUnique({
        where: { id },
        select: EMBED_SELECT,
      });
      return record ? mapEmbed(record) : null;
    },

    getActiveBySubjectAndDomain: async ({ subjectType, subjectId, domain }) => {
      const record = await p.embed.findUnique({
        where: {
          subjectType_subjectId_domain: { subjectType, subjectId, domain },
        },
        select: EMBED_SELECT,
      });
      if (!record || record.status !== "ACTIVE") return null;
      return mapEmbed(record);
    },

    revoke: async (id) => {
      const record = await p.embed.update({
        where: { id },
        data: { status: "REVOKED" },
        select: EMBED_SELECT,
      });
      return mapEmbed(record);
    },
  };
}
