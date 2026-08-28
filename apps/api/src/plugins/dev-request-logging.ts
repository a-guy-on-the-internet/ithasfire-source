import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";

const isProd = process.env.NODE_ENV === "production";

const plugin: FastifyPluginAsync = async (app) => {
  // Keep prod logs quiet + structured; only add per-request logs in local/dev.
  if (isProd) {
    return;
  }

  app.addHook("onRequest", async (request) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (request as any).__thStartAt = Date.now();
  });

  app.addHook("onResponse", async (request, reply) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const startedAt = (request as any).__thStartAt as number | undefined;
    const durationMs =
      typeof startedAt === "number" ? Date.now() - startedAt : undefined;

    // fastify's request.url includes the full path + querystring.
    const url = request.url;
    const method = request.method;
    const statusCode = reply.statusCode;

    // Use the existing app logger port (pino adapter) so logs land wherever
    // the rest of the app logs go.
    app.deps.logger.info("http_request", {
      method,
      url,
      statusCode,
      durationMs,
    });
  });
};

export default fp(plugin as unknown as never) as unknown as never;
