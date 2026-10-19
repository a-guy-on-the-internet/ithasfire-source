import type { PosReadersRepo } from "@th/ports/repos/pos-readers";
import type { PosReaderRecord } from "@th/types/repos/pos-readers";

import type { PrismaClientOrTx } from "./types";

const SELECT_COLUMNS = `
  id,
  org_id as "orgId",
  stripe_reader_id as "stripeReaderId",
  label,
  place_id as "placeId",
  device_type as "deviceType",
  paired_by_human_id as "pairedByHumanId",
  created_at as "createdAt",
  updated_at as "updatedAt"
`;

export function makePosReadersRepo(p: PrismaClientOrTx): PosReadersRepo {
  return {
    async listByOrg({ orgId }) {
      return p.$queryRawUnsafe<PosReaderRecord[]>(
        `SELECT ${SELECT_COLUMNS}
         FROM pos_readers
         WHERE org_id = $1
         ORDER BY created_at DESC`,
        orgId,
      );
    },

    async getById({ id }) {
      const rows = await p.$queryRawUnsafe<PosReaderRecord[]>(
        `SELECT ${SELECT_COLUMNS} FROM pos_readers WHERE id = $1`,
        id,
      );
      return rows[0] ?? null;
    },

    async getByStripeReaderId({ stripeReaderId }) {
      const rows = await p.$queryRawUnsafe<PosReaderRecord[]>(
        `SELECT ${SELECT_COLUMNS} FROM pos_readers WHERE stripe_reader_id = $1`,
        stripeReaderId,
      );
      return rows[0] ?? null;
    },

    async create({
      orgId,
      stripeReaderId,
      label,
      placeId,
      deviceType,
      pairedByHumanId,
    }) {
      const rows = await p.$queryRawUnsafe<PosReaderRecord[]>(
        `INSERT INTO pos_readers
           (id, org_id, stripe_reader_id, label, place_id, device_type,
            paired_by_human_id, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, NOW(), NOW())
         RETURNING ${SELECT_COLUMNS}`,
        orgId,
        stripeReaderId,
        label,
        placeId ?? null,
        deviceType ?? null,
        pairedByHumanId,
      );
      return rows[0]!;
    },

    async update({ id, label, placeId }) {
      // COALESCE on label keeps it unchanged when the caller omits it;
      // placeId is deliberately settable to NULL (unpin from a venue), so it
      // uses an explicit "did the caller pass this key" flag instead.
      const rows = await p.$queryRawUnsafe<PosReaderRecord[]>(
        `UPDATE pos_readers
         SET label = COALESCE($2, label),
             place_id = CASE WHEN $3::boolean THEN $4 ELSE place_id END,
             updated_at = NOW()
         WHERE id = $1
         RETURNING ${SELECT_COLUMNS}`,
        id,
        label ?? null,
        placeId !== undefined,
        placeId ?? null,
      );
      return rows[0]!;
    },

    async delete({ id }) {
      await p.$queryRawUnsafe(`DELETE FROM pos_readers WHERE id = $1`, id);
    },
  };
}
