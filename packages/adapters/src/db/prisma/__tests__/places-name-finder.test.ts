import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import {
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";
import {
  PLACE_NAME_CORPUS,
  sqlNormalizedPlaceName,
} from "@th/test-utils/fakes/place-name-finder";

import {
  findActiveExactPlaceIdsByNormalizedName,
  makePlacesRepo,
} from "../places";

// ---------------------------------------------------------------------------
// Integration coverage for the community-place duplicate guard's SQL:
// `findActiveExactPlaceIdsByNormalizedName` (the name normal form, the
// ACTIVE + EXACT filter, the exclusion and the limit) and `lockPlaceName`
// (a real transaction-scoped advisory lock). Neither can be exercised by a
// mocked Prisma client. Standalone DDL mirrors only the "Place" columns the
// query touches; `normalize()` needs Postgres 13+ on a UTF8 database.
// ---------------------------------------------------------------------------

const TABLE_SQL = `
CREATE TYPE "PlaceStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'ARCHIVED');
CREATE TYPE "EventLocationMode" AS ENUM ('EXACT', 'OBSCURED');

CREATE TABLE "Place" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "status" "PlaceStatus" NOT NULL DEFAULT 'ACTIVE',
  "location_mode" "EventLocationMode" NOT NULL DEFAULT 'EXACT',

  CONSTRAINT "Place_pkey" PRIMARY KEY ("id")
);
`;

describe("PlacesRepo name finder + name lock (integration)", () => {
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
    await pool?.query(`TRUNCATE "Place"`);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pgContainer?.stop();
  });

  async function insert(
    id: string,
    name: string,
    opts: { status?: string; mode?: string } = {},
  ) {
    await pool!.query(
      `INSERT INTO "Place" ("id", "name", "status", "location_mode") VALUES ($1, $2, $3, $4)`,
      [id, name, opts.status ?? "ACTIVE", opts.mode ?? "EXACT"],
    );
  }

  const find = (normalizedName: string, extra: { excludePlaceId?: string; limit?: number } = {}) =>
    findActiveExactPlaceIdsByNormalizedName(prisma!, { normalizedName, ...extra });

  test("matches regardless of case, spacing runs, no-break / em spaces and Unicode form", async () => {
    await insert("a", "Corner Bar South");
    await insert("b", "  corner   BAR\tsouth ");
    await insert("c", "Corner Bar South");
    await insert("d", "Corner Bar South Annex");
    await insert("e", "Corner Bar");

    expect(await find("corner bar south")).toEqual(["a", "b", "c"]);
  });

  test("composed and decomposed accents are one name (NFKC)", async () => {
    await insert("a", "Café Lola"); // é precomposed
    await insert("b", "Café Lola"); // e + combining acute

    expect(await find(sqlNormalizedPlaceName("Café Lola"))).toEqual([
      "a",
      "b",
    ]);
  });

  test("a non-ASCII capital lower-cases in SQL: \"CAF\u00c9 LOLA\" is \"caf\u00e9 lola\" (needs a UTF8 LC_CTYPE, not C)", async () => {
    await insert("upper", "CAF\u00c9 LOLA");
    await insert("lower", "caf\u00e9 lola");

    expect(await find("caf\u00e9 lola")).toEqual(["lower", "upper"]);
  });

  test("the JS normal form agrees with the SQL one on the shared corpus", async () => {
    for (const name of PLACE_NAME_CORPUS) {
      const { rows } = await pool!.query<{ n: string }>(
        `SELECT lower(btrim(regexp_replace(normalize($1::text, NFKC), '[[:space:]]+', ' ', 'g'))) AS n`,
        [name],
      );
      expect({ name, n: rows[0]!.n }).toEqual({
        name,
        n: sqlNormalizedPlaceName(name),
      });
    }
  });

  test("only ACTIVE places that publish their address", async () => {
    await insert("active", "Corner Bar South");
    await insert("archived", "Corner Bar South", { status: "ARCHIVED" });
    await insert("suspended", "Corner Bar South", { status: "SUSPENDED" });
    await insert("withheld", "Corner Bar South", { mode: "OBSCURED" });

    expect(await find("corner bar south")).toEqual(["active"]);
  });

  test("excludePlaceId drops that row; limit bounds the result", async () => {
    for (const id of ["a", "b", "c", "d"]) await insert(id, "Corner Bar South");

    expect(await find("corner bar south", { excludePlaceId: "b" })).toEqual([
      "a",
      "c",
      "d",
    ]);
    expect(await find("corner bar south", { limit: 2 })).toEqual(["a", "b"]);
  });

  test("a wildcard-looking name is matched literally (no LIKE)", async () => {
    await insert("a", "100% Bar_Room");
    await insert("b", "100x BarxRoom");

    expect(await find("100% bar_room")).toEqual(["a"]);
  });

  test("lockPlaceName holds a transaction advisory lock until commit", async () => {
    const key = "place_name:corner bar south";
    const tryLock = async () => {
      const client = await pool!.connect();
      try {
        await client.query("BEGIN");
        const { rows } = await client.query<{ got: boolean }>(
          "SELECT pg_try_advisory_xact_lock(hashtext($1)) AS got",
          [key],
        );
        await client.query("ROLLBACK");
        return rows[0]!.got;
      } finally {
        client.release();
      }
    };

    let heldInside: boolean | undefined;
    await prisma!.$transaction(async (tx) => {
      await makePlacesRepo(tx as never).lockPlaceName("corner bar south");
      heldInside = !(await tryLock());
    });

    expect(heldInside).toBe(true);
    expect(await tryLock()).toBe(true);
  });
});
