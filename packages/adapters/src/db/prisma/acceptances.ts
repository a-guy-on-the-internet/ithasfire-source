import type {
  AcceptanceRepo,
  AcceptanceRecordRow,
  AcceptanceDocumentType,
  AcceptanceScope,
  CreateAcceptanceRecordInput,
  FindCurrentAcceptanceInput,
} from "@th/ports/repos/acceptances";
import { Prisma } from "@prisma/client";

import type { PrismaClientOrTx } from "./types";

type PrismaAcceptanceRow = {
  id: string;
  humanId: string;
  documentType: AcceptanceDocumentType;
  documentVersion: string;
  documentTextSnapshot: string;
  scopeType: AcceptanceScope;
  scopeId: string | null;
  acceptedAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: unknown;
};

const toRow = (r: PrismaAcceptanceRow): AcceptanceRecordRow => ({
  id: r.id,
  humanId: r.humanId,
  documentType: r.documentType,
  documentVersion: r.documentVersion,
  documentTextSnapshot: r.documentTextSnapshot,
  scopeType: r.scopeType,
  scopeId: r.scopeId,
  acceptedAt: r.acceptedAt,
  ipAddress: r.ipAddress,
  userAgent: r.userAgent,
  metadata:
    r.metadata == null ? null : (r.metadata as Record<string, unknown>),
});

export function makeAcceptancesRepo(p: PrismaClientOrTx): AcceptanceRepo {
  return {
    async findCurrent(
      input: FindCurrentAcceptanceInput,
    ): Promise<AcceptanceRecordRow | null> {
      const row = await p.acceptanceRecord.findFirst({
        where: {
          humanId: input.humanId,
          documentType: input.documentType,
          documentVersion: input.documentVersion,
          scopeType: input.scopeType ?? "GLOBAL",
          scopeId: input.scopeId ?? null,
        },
        orderBy: { acceptedAt: "desc" },
      });
      return row ? toRow(row as PrismaAcceptanceRow) : null;
    },

    async create(
      input: CreateAcceptanceRecordInput,
    ): Promise<AcceptanceRecordRow> {
      // Duplicate-safe insert. The SQL-only unique index
      // "AcceptanceRecord_human_doc_version_scope_key" (NULLS NOT DISTINCT,
      // migration 20260612000000) backstops recordAcceptance's
      // find-then-create against concurrent first acceptances.
      //
      // createMany({ skipDuplicates: true }) compiles to
      // INSERT ... ON CONFLICT DO NOTHING, which never raises — unlike
      // catching a P2002 from .create(), which would leave the surrounding
      // Postgres interactive transaction aborted ("current transaction is
      // aborted") and fail an otherwise-good order-creating tx. The race
      // loser skips the insert and adopts the winner's row below.
      await p.acceptanceRecord.createMany({
        data: [
          {
            humanId: input.humanId,
            documentType: input.documentType,
            documentVersion: input.documentVersion,
            documentTextSnapshot: input.documentTextSnapshot,
            scopeType: input.scopeType,
            scopeId: input.scopeId ?? null,
            acceptedAt: input.acceptedAt,
            ipAddress: input.ipAddress ?? null,
            userAgent: input.userAgent ?? null,
            metadata:
              input.metadata == null
                ? Prisma.JsonNull
                : (input.metadata as Prisma.InputJsonValue),
          },
        ],
        skipDuplicates: true,
      });

      // Re-read the surviving row — ours, or the concurrent winner's. On
      // conflict with an uncommitted insert, ON CONFLICT waits for that tx
      // to resolve before skipping, so at READ COMMITTED this re-read always
      // sees the committed row. Ordering matches the migration's dedupe rule
      // (earliest acceptedAt, lowest id) for determinism.
      const row = await p.acceptanceRecord.findFirst({
        where: {
          humanId: input.humanId,
          documentType: input.documentType,
          documentVersion: input.documentVersion,
          scopeType: input.scopeType,
          scopeId: input.scopeId ?? null,
        },
        orderBy: [{ acceptedAt: "asc" }, { id: "asc" }],
      });
      if (!row) {
        // Unreachable: the insert either landed or skipped on a committed
        // duplicate; either way a matching row exists.
        throw new Error("acceptance_record_create_lost_row");
      }
      return toRow(row as PrismaAcceptanceRow);
    },
  };
}
