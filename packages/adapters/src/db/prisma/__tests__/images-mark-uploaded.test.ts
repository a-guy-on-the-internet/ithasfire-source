import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import {
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeImagesRepo } from "../images";

// Standalone DDL: `event_images` as created by
// 20260407000000_consolidated_baseline, with the creator FK dropped
// (20260706120000) and the width/height columns added (20261007210000).
// HAND-COPIED, like the sibling image-moderation and outbox suites: green by
// construction if it drifts. When you touch the model, touch this too.
const TABLE_SQL = `
CREATE TYPE "ImageOwnerType" AS ENUM ('EVENT', 'ORG');
CREATE TABLE "event_images" (
  "id" TEXT NOT NULL,
  "ownerType" "ImageOwnerType" NOT NULL,
  "ownerId" TEXT NOT NULL,
  "eventId" TEXT,
  "key" TEXT NOT NULL,
  "publicUrl" TEXT NOT NULL,
  "contentType" TEXT,
  "sizeBytes" BIGINT,
  "width" INTEGER,
  "height" INTEGER,
  "uploadedAt" TIMESTAMP(3),
  "attached" BOOLEAN NOT NULL DEFAULT false,
  "attachedAt" TIMESTAMP(3),
  "detachedAt" TIMESTAMP(3),
  "deletedAt" TIMESTAMP(3),
  "createdByHumanId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "event_images_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "event_images_ownerId_key_key" ON "event_images"("ownerId", "key");
`;

describe("makeImagesRepo.markUploaded / softDeleteIfUnfinalized (integration)", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let prisma: PrismaClient | undefined;

  beforeAll(async () => {
    pgContainer = await startPostgresContainer();
    pool = new pg.Pool({ connectionString: pgContainer.databaseUrl });
    await pool.query(TABLE_SQL);
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  }, 300_000);

  beforeEach(async () => {
    await pool?.query(`TRUNCATE "event_images"`);
    await (prisma as PrismaClient).image.create({
      data: {
        id: "img-1",
        ownerType: "EVENT",
        ownerId: "evt-1",
        key: "events/evt-1/images/upload.jpg",
        publicUrl: "",
        contentType: "image/jpeg",
        sizeBytes: 1234n,
      },
    });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pgContainer?.stop();
  });

  const repo = () => makeImagesRepo(prisma as PrismaClient);
  const input = (key: string) => ({
    id: "img-1",
    uploadedAt: new Date("2026-10-08T12:00:00.000Z"),
    key,
    publicUrl: `https://cdn/${key}`,
    width: 640,
    height: 480,
  });

  test("moves the row to the given key and marks it uploaded", async () => {
    const row = await repo().markUploaded(input("events/evt-1/images/aaaa.jpg"));
    expect(row).toMatchObject({
      key: "events/evt-1/images/aaaa.jpg",
      publicUrl: "https://cdn/events/evt-1/images/aaaa.jpg",
      width: 640,
      height: 480,
      sizeBytes: 1234n,
    });
    expect(row?.uploadedAt).toEqual(new Date("2026-10-08T12:00:00.000Z"));
  });

  test("a second mark loses: returns null and changes nothing", async () => {
    await repo().markUploaded(input("events/evt-1/images/aaaa.jpg"));
    const second = await repo().markUploaded(input("events/evt-1/images/bbbb.jpg"));
    expect(second).toBeNull();
    const stored = await repo().getById("img-1");
    expect(stored?.key).toBe("events/evt-1/images/aaaa.jpg");
  });

  test("two CONCURRENT marks: exactly one wins", async () => {
    const [a, b] = await Promise.all([
      repo().markUploaded(input("events/evt-1/images/aaaa.jpg")),
      repo().markUploaded(input("events/evt-1/images/bbbb.jpg")),
    ]);
    expect([a, b].filter((r) => r !== null)).toHaveLength(1);
    const winner = (a ?? b)!;
    expect((await repo().getById("img-1"))?.key).toBe(winner.key);
  });

  test("a missing row is null", async () => {
    expect(await repo().markUploaded({ ...input("k"), id: "nope" })).toBeNull();
  });

  test("a retired (soft-deleted) row is never marked uploaded", async () => {
    await repo().softDelete({ imageIds: ["img-1"], deletedAt: new Date() });
    expect(await repo().markUploaded(input("events/evt-1/images/aaaa.jpg"))).toBeNull();
    expect((await repo().getById("img-1"))?.uploadedAt).toBeNull();
  });

  const deletedAt = new Date("2026-10-08T13:00:00.000Z");

  test("softDeleteIfUnfinalized retires a pending row once", async () => {
    expect(await repo().softDeleteIfUnfinalized({ id: "img-1", deletedAt })).toBe(true);
    expect((await repo().getById("img-1"))?.deletedAt).toEqual(deletedAt);
    expect(
      await repo().softDeleteIfUnfinalized({ id: "img-1", deletedAt: new Date() }),
    ).toBe(false);
    expect((await repo().getById("img-1"))?.deletedAt).toEqual(deletedAt);
  });

  test("softDeleteIfUnfinalized never touches a finalized row", async () => {
    await repo().markUploaded(input("events/evt-1/images/aaaa.jpg"));
    expect(await repo().softDeleteIfUnfinalized({ id: "img-1", deletedAt })).toBe(false);
    expect((await repo().getById("img-1"))?.deletedAt).toBeNull();
  });

  test("CONCURRENT softDeleteIfUnfinalized: exactly one wins", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        repo().softDeleteIfUnfinalized({ id: "img-1", deletedAt }),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test("softDeleteIfUnfinalized on a missing row is false", async () => {
    expect(await repo().softDeleteIfUnfinalized({ id: "nope", deletedAt })).toBe(false);
  });
});
