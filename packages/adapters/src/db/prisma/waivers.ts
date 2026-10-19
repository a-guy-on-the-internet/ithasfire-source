import type { Prisma } from "@prisma/client";

import type {
  WaiverClausesRepo,
  WaiverTemplatesRepo,
  WaiverAcceptancesRepo,
  VolunteerWaiverAcceptancesRepo,
  WaiverClauseRecord,
  WaiverTemplateRecord,
  CreateWaiverTemplateInput,
  UpdateWaiverTemplateInput,
  ListWaiverTemplatesInput,
  WaiverAcceptanceRecord,
  CreateWaiverAcceptanceInput,
  VolunteerWaiverAcceptanceRecord,
  CreateVolunteerWaiverAcceptanceInput,
} from "@th/ports/repos/waivers";

import type { PrismaClientOrTx } from "./types";

const toJsonValue = (value: unknown): Prisma.InputJsonValue =>
  value as Prisma.InputJsonValue;

// ─────────────────────────────────────────────────────────────────────────────
// Row → Record mappers
// ─────────────────────────────────────────────────────────────────────────────

type WaiverTemplateRow = {
  id: string;
  orgId: string | null;
  humanId: string | null;
  name: string;
  body: string;
  version: number;
  isDefault: boolean;
  kind: "ATTENDEE" | "VOLUNTEER";
  source: "FREEFORM" | "ASSEMBLED" | "PLATFORM";
  assembledFromClauses: unknown;
  jurisdictionState: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function toTemplateRecord(row: WaiverTemplateRow): WaiverTemplateRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    humanId: row.humanId,
    name: row.name,
    body: row.body,
    version: row.version,
    isDefault: row.isDefault,
    kind: row.kind,
    source: row.source,
    assembledFromClauses:
      (row.assembledFromClauses as WaiverTemplateRecord["assembledFromClauses"]) ??
      null,
    jurisdictionState: row.jurisdictionState,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

type WaiverClauseRow = {
  id: string;
  slug: string;
  title: string;
  body: string;
  layer: "STRUCTURAL" | "RISK_SPECIFIC";
  sortOrder: number;
  version: number;
  voidInStates: string[];
  requiredInStates: string[];
};

function toClauseRecord(row: WaiverClauseRow): WaiverClauseRecord {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    body: row.body,
    layer: row.layer,
    sortOrder: row.sortOrder,
    version: row.version,
    voidInStates: row.voidInStates,
    requiredInStates: row.requiredInStates,
  };
}

type WaiverAcceptanceRow = {
  id: string;
  orderId: string;
  humanId: string;
  waiverTemplateId: string;
  waiverVersion: number;
  waiverBodyHash: string;
  acceptedAt: Date;
  ipAddress: string | null;
};

function toAcceptanceRecord(row: WaiverAcceptanceRow): WaiverAcceptanceRecord {
  return {
    id: row.id,
    orderId: row.orderId,
    humanId: row.humanId,
    waiverTemplateId: row.waiverTemplateId,
    waiverVersion: row.waiverVersion,
    waiverBodyHash: row.waiverBodyHash,
    acceptedAt: row.acceptedAt,
    ipAddress: row.ipAddress,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// WaiverTemplatesRepo
// ─────────────────────────────────────────────────────────────────────────────

export function makeWaiverClausesRepo(p: PrismaClientOrTx): WaiverClausesRepo {
  return {
    async listActive() {
      const rows = await p.waiverClause.findMany({
        where: { active: true },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          slug: true,
          title: true,
          body: true,
          layer: true,
          sortOrder: true,
          version: true,
          voidInStates: true,
          requiredInStates: true,
        },
      });

      return rows.map(toClauseRecord);
    },
  };
}

export function makeWaiverTemplatesRepo(
  p: PrismaClientOrTx,
): WaiverTemplatesRepo {
  return {
    async getById(id) {
      const row = await p.waiverTemplate.findUnique({ where: { id } });
      return row ? toTemplateRecord(row) : null;
    },

    async create(input: CreateWaiverTemplateInput) {
      const row = await p.waiverTemplate.create({
        data: {
          orgId: input.orgId,
          humanId: input.humanId,
          name: input.name,
          body: input.body,
          version: 1,
          isDefault: input.isDefault ?? false,
          source: input.source ?? "FREEFORM",
          assembledFromClauses:
            input.assembledFromClauses === undefined
              ? undefined
              : toJsonValue(input.assembledFromClauses),
          jurisdictionState: input.jurisdictionState ?? null,
        },
      });
      return toTemplateRecord(row);
    },

    async update(input: UpdateWaiverTemplateInput) {
      const data: Prisma.WaiverTemplateUpdateInput = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.body !== undefined) {
        data.body = input.body;
        data.version = { increment: 1 };
      }
      if (input.isDefault !== undefined) data.isDefault = input.isDefault;
      if (input.source !== undefined) data.source = input.source;
      if (input.assembledFromClauses !== undefined) {
        data.assembledFromClauses = toJsonValue(input.assembledFromClauses);
      }
      if (input.jurisdictionState !== undefined) {
        data.jurisdictionState = input.jurisdictionState;
      }

      const row = await p.waiverTemplate.update({
        where: { id: input.id },
        data,
      });
      return toTemplateRecord(row);
    },

    async list(input: ListWaiverTemplatesInput) {
      const conditions: unknown[] = [];

      if (input.orgId !== undefined && input.orgId !== null) {
        conditions.push({ orgId: input.orgId });
      }

      if (input.humanId !== undefined && input.humanId !== null) {
        conditions.push({ humanId: input.humanId });
      }

      if (input.includePlatform) {
        // Platform templates have both orgId and humanId null
        conditions.push({ orgId: null, humanId: null });
      }

      // If no conditions were added, list platform templates only
      if (conditions.length === 0) {
        conditions.push({ orgId: null, humanId: null });
      }

      const rows = await p.waiverTemplate.findMany({
        where: { OR: conditions as any },
        orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
        take: input.limit ?? 50,
        skip: input.offset ?? 0,
      });

      return rows.map(toTemplateRecord);
    },

    async clearOrgDefault(orgId: string) {
      await p.waiverTemplate.updateMany({
        where: { orgId, isDefault: true },
        data: { isDefault: false },
      });
    },

    async clearHumanDefault(humanId: string) {
      await p.waiverTemplate.updateMany({
        where: { humanId, isDefault: true },
        data: { isDefault: false },
      });
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// WaiverAcceptancesRepo
// ─────────────────────────────────────────────────────────────────────────────

export function makeWaiverAcceptancesRepo(
  p: PrismaClientOrTx,
): WaiverAcceptancesRepo {
  return {
    async create(input: CreateWaiverAcceptanceInput) {
      const row = await p.waiverAcceptance.create({
        data: {
          orderId: input.orderId,
          humanId: input.humanId,
          waiverTemplateId: input.waiverTemplateId,
          waiverVersion: input.waiverVersion,
          waiverBodyHash: input.waiverBodyHash,
          ipAddress: input.ipAddress ?? null,
        },
      });
      return toAcceptanceRecord(row);
    },

    async getByOrderAndTemplate(orderId: string, waiverTemplateId: string) {
      const row = await p.waiverAcceptance.findUnique({
        where: {
          orderId_waiverTemplateId: { orderId, waiverTemplateId },
        },
      });
      return row ? toAcceptanceRecord(row) : null;
    },

    async listByOrder(orderId: string) {
      const rows = await p.waiverAcceptance.findMany({
        where: { orderId },
        orderBy: { acceptedAt: "desc" },
      });
      return rows.map(toAcceptanceRecord);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// VolunteerWaiverAcceptancesRepo
// ─────────────────────────────────────────────────────────────────────────────

type VolunteerWaiverAcceptanceRow = {
  id: string;
  /** Null for a contact-only signup's acceptance (never "on file"). */
  humanId: string | null;
  signupId: string;
  waiverTemplateId: string;
  waiverVersion: number;
  waiverBodyHash: string;
  acceptedAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
};

function toVolunteerAcceptanceRecord(
  row: VolunteerWaiverAcceptanceRow,
): VolunteerWaiverAcceptanceRecord {
  return {
    id: row.id,
    humanId: row.humanId,
    signupId: row.signupId,
    waiverTemplateId: row.waiverTemplateId,
    waiverVersion: row.waiverVersion,
    waiverBodyHash: row.waiverBodyHash,
    acceptedAt: row.acceptedAt,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
  };
}

export function makeVolunteerWaiverAcceptancesRepo(
  p: PrismaClientOrTx,
): VolunteerWaiverAcceptancesRepo {
  return {
    async create(input: CreateVolunteerWaiverAcceptanceInput) {
      const row = await p.volunteerWaiverAcceptance.create({
        data: {
          humanId: input.humanId,
          signupId: input.signupId,
          waiverTemplateId: input.waiverTemplateId,
          waiverVersion: input.waiverVersion,
          waiverBodyHash: input.waiverBodyHash,
          ipAddress: input.ipAddress ?? null,
          userAgent: input.userAgent ?? null,
        },
      });
      return toVolunteerAcceptanceRecord(row);
    },

    async findCurrentForHuman(
      humanId: string,
      waiverTemplateId: string,
      waiverVersion: number,
    ) {
      const row = await p.volunteerWaiverAcceptance.findFirst({
        where: { humanId, waiverTemplateId, waiverVersion },
        orderBy: { acceptedAt: "desc" },
      });
      return row ? toVolunteerAcceptanceRecord(row) : null;
    },
  };
}
