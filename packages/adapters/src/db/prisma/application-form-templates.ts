import { Prisma } from "@prisma/client";
import type {
  ApplicationFormPurpose,
  ApplicationFormTemplateRecord,
  ApplicationTemplateQuestion,
  TemplateOwnerScope,
} from "@th/types";
import type { ApplicationFormTemplatesRepo } from "@th/ports/repos/application-form-templates";
import { fail } from "@th/errors";

import type { PrismaClientOrTx } from "./types";

/**
 * Runtime guard: Prisma drops an `undefined` filter, so a missing purposes
 * list would read every template. Require a non-empty array.
 */
function requirePurposes(
  purposes: readonly ApplicationFormPurpose[] | undefined,
  method: string,
): ApplicationFormPurpose[] {
  if (!Array.isArray(purposes) || purposes.length === 0) {
    throw new Error(
      `applicationFormTemplates.${method}: purposes is required (non-empty)`,
    );
  }
  return [...purposes];
}

const ORDER_BY: Prisma.ApplicationFormTemplateOrderByWithRelationInput[] = [
  { createdAt: "desc" },
  { id: "desc" },
];

function mapTemplate(model: {
  id: string;
  ownerScope: TemplateOwnerScope;
  ownerId: string | null;
  name: string;
  description: string | null;
  purpose: ApplicationFormPurpose;
  introText: string | null;
  questions: Prisma.JsonValue;
  isPlatform: boolean;
  archivedAt: Date | null;
  createdByHumanId: string | null;
  createdAt: Date;
  updatedAt: Date;
}): ApplicationFormTemplateRecord {
  return {
    id: model.id,
    ownerScope: model.ownerScope,
    ownerId: model.ownerId,
    name: model.name,
    description: model.description,
    purpose: model.purpose,
    introText: model.introText,
    // Entries are validated by the use-case schema at write time; the column
    // only ever holds ApplicationTemplateQuestion[]. A non-array (impossible
    // through the write paths, possible from a hand-edited row) reads as an
    // empty template rather than crashing the list.
    questions: Array.isArray(model.questions)
      ? (model.questions as unknown as ApplicationTemplateQuestion[])
      : [],
    isPlatform: model.isPlatform,
    archivedAt: model.archivedAt,
    createdByHumanId: model.createdByHumanId,
    createdAt: model.createdAt,
    updatedAt: model.updatedAt,
  };
}

export function makeApplicationFormTemplatesRepo(
  p: PrismaClientOrTx,
): ApplicationFormTemplatesRepo {
  return {
    async getById(id) {
      const row = await p.applicationFormTemplate.findUnique({ where: { id } });
      return row ? mapTemplate(row) : null;
    },

    async list(ownerScope, ownerId, purposes) {
      // OWNED rows only — the platform union is `listPlatformTemplates`.
      const rows = await p.applicationFormTemplate.findMany({
        where: {
          ownerScope,
          ownerId,
          purpose: { in: requirePurposes(purposes, "list") },
          isPlatform: false,
          archivedAt: null,
        },
        orderBy: ORDER_BY,
      });
      return rows.map(mapTemplate);
    },

    async findByName(ownerScope, ownerId, name) {
      // OWNED rows only, ARCHIVED INCLUDED: `ownerId` equality never matches a
      // NULL catalogue row; `isPlatform: false` is pinned anyway so a
      // mis-shaped row (flag set WITH an ownerId) cannot surface as "yours".
      const row = await p.applicationFormTemplate.findFirst({
        where: {
          ownerScope,
          ownerId,
          isPlatform: false,
          name: { equals: name, mode: "insensitive" },
        },
      });
      return row ? mapTemplate(row) : null;
    },

    async listPlatformTemplates(purposes) {
      // `isPlatform: true` is the gate, checked on its own. `ownerId: null` is
      // asserted alongside it rather than inferred from it, so a mis-shaped
      // row (flag set WITH an ownerId) fails CLOSED — it appears in nobody's
      // catalogue instead of leaking one owner's row to every organizer.
      const rows = await p.applicationFormTemplate.findMany({
        where: {
          isPlatform: true,
          ownerId: null,
          archivedAt: null,
          purpose: { in: requirePurposes(purposes, "listPlatformTemplates") },
        },
        orderBy: [{ name: "asc" }, { id: "asc" }],
      });
      return rows.map(mapTemplate);
    },

    async create(input) {
      const row = await p.applicationFormTemplate.create({
        data: {
          ownerScope: input.ownerScope,
          ownerId: input.ownerId,
          name: input.name,
          description: input.description,
          purpose: input.purpose,
          introText: input.introText,
          questions: input.questions as unknown as Prisma.InputJsonValue,
          // `isPlatform` is deliberately not settable here, so no
          // organizer-facing path can mint a catalogue row.
          createdByHumanId: input.createdByHumanId,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
          archivedAt: null,
        } satisfies Prisma.ApplicationFormTemplateUncheckedCreateInput,
      });
      return mapTemplate(row);
    },

    async update(input) {
      // ID-scoped but OWNED-PINNED: a catalogue row's id passed here matches
      // nothing and reports TEMPLATE_NOT_FOUND rather than mutating the
      // shared starter catalogue. Presence-guarded — an absent key leaves the
      // stored value alone (`description: null` still CLEARS it).
      const result = await p.applicationFormTemplate.updateMany({
        where: { id: input.templateId, isPlatform: false },
        data: {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.description !== undefined && {
            description: input.description,
          }),
          ...(input.introText !== undefined && { introText: input.introText }),
          ...(input.questions !== undefined && {
            questions: input.questions as unknown as Prisma.InputJsonValue,
          }),
          updatedAt: input.updatedAt,
        },
      });
      if (result.count === 0) {
        throw fail("TEMPLATE_NOT_FOUND");
      }
      const fresh = await p.applicationFormTemplate.findUnique({
        where: { id: input.templateId },
      });
      if (!fresh) {
        throw fail("TEMPLATE_NOT_FOUND");
      }
      return mapTemplate(fresh);
    },

    async archive(input) {
      const result = await p.applicationFormTemplate.updateMany({
        where: { id: input.templateId, isPlatform: false },
        data: { archivedAt: input.archivedAt, updatedAt: input.archivedAt },
      });
      if (result.count === 0) {
        throw fail("TEMPLATE_NOT_FOUND");
      }
      const fresh = await p.applicationFormTemplate.findUnique({
        where: { id: input.templateId },
      });
      if (!fresh) {
        throw fail("TEMPLATE_NOT_FOUND");
      }
      return mapTemplate(fresh);
    },
  };
}
