import { prisma } from "../../packages/db/src/index";

/**
 * Dev helper: list columns for the Better Auth tables in the current DB.
 *
 * Run (optional):
 *   pnpm tsx scripts/dev/inspect-auth-user-columns.ts
 */
async function main() {
  const tables = [
    "auth_user",
    "auth_account",
    "auth_session",
    "auth_verification",
  ] as const;

  for (const table of tables) {
    // Note: information_schema always uses lower-case table names for unquoted identifiers.
    const rows = await prisma.$queryRaw<
      Array<{ column_name: string; data_type: string; is_nullable: string }>
    >`
			select column_name, data_type, is_nullable
			from information_schema.columns
			where table_schema = 'public' and table_name = ${table}
			order by ordinal_position;
		`;

    // eslint-disable-next-line no-console
    console.log(`\n== ${table} columns (${rows.length}) ==`);
    for (const r of rows) {
      // eslint-disable-next-line no-console
      console.log(
        `- ${r.column_name} :: ${r.data_type} ${r.is_nullable === "NO" ? "NOT NULL" : "NULL"}`,
      );
    }
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    await prisma.$disconnect();
    process.exitCode = 1;
  });
