import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { prisma } from "@th/db";

/**
 * Adds E2E-only debug endpoints that help us diagnose Better Auth / Prisma issues.
 *
 * Guardrails:
 * - Never available in production.
 * - Requires x-e2e-reset-secret header.
 */
const plugin: FastifyPluginAsync = async (app) => {
  const assertE2eAuthorized = (request: any, reply: any) => {
    if (process.env.NODE_ENV === "production") {
      reply.status(404).send({ ok: false });
      return false;
    }

    const expected = process.env.E2E_RESET_SECRET;
    const provided = request.headers["x-e2e-reset-secret"];
    if (!expected || typeof provided !== "string" || provided !== expected) {
      reply.status(401).send({ ok: false, error: "unauthorized" });
      return false;
    }

    return true;
  };

  app.get("/e2e/debug/auth-user-schema", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    // Introspect the runtime DB schema and compare it to the Prisma client model.
    // This helps confirm whether the runtime DB is missing a column Prisma expects.
    const table = "auth_user";
    // IMPORTANT: Prisma's PostgreSQL connector supports selecting a schema via
    // `?schema=...` in DATABASE_URL. For accurate debugging, we must query the
    // same schema Prisma is pointed at.
    const schema = (() => {
      const url = process.env.DATABASE_URL;
      if (!url) return "public";
      try {
        return new URL(url).searchParams.get("schema") ?? "public";
      } catch {
        return "public";
      }
    })();

    type ColumnRow = { column_name: string };

    const rows = await prisma.$queryRaw<ColumnRow[]>`
			select column_name
			from information_schema.columns
			where table_schema = ${schema}
				and table_name = ${table}
			order by ordinal_position asc;
		`;

    const columns = rows.map((r) => r.column_name);

    // Prisma model fields are camelCase; the DB is snake_case.
    // We'll report both so it's easy to spot mismatches.
    const prismaFields = Object.keys(prisma.authUser.fields);

    return reply.send({
      ok: true,
      schema,
      table,
      columns,
      prismaFields,
    });
  });

  app.get("/e2e/debug/repro/auth-user-findfirst", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    // Reproduce the failing call directly, without going through Better Auth.
    // If this fails, it's a pure Prisma/DB mismatch.
    // If this succeeds, Better Auth is likely passing a bad `select/include/orderBy`.
    try {
      const user = await prisma.authUser.findFirst({
        where: { email: "does-not-exist-e2e@invalid.local" },
      });
      return reply.send({ ok: true, user });
    } catch (err) {
      const message = err instanceof Error ? err.message : JSON.stringify(err);
      return reply
        .status(500)
        .send({ ok: false, error: "findfirst_failed", message });
    }
  });

  app.get("/e2e/debug/prisma-runtime", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const rawUrl = process.env.DATABASE_URL;
    let safeUrl: string | null = null;
    let schema: string | null = null;
    if (rawUrl) {
      try {
        const u = new URL(rawUrl);
        schema = u.searchParams.get("schema");
        if (u.password) u.password = "***";
        if (u.username) u.username = "***";
        safeUrl = u.toString();
      } catch {
        safeUrl = "(invalid DATABASE_URL)";
      }
    }

    return reply.send({
      ok: true,
      nodeEnv: process.env.NODE_ENV ?? null,
      databaseUrl: safeUrl,
      schema,
    });
  });
};

export default fp(plugin as unknown as never) as unknown as never;
