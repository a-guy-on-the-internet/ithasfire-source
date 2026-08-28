import fp from "fastify-plugin";
import fastifyCors from "@fastify/cors";
import type { FastifyPluginAsync } from "fastify";

/**
 * Parses `CORS_ALLOWED_ORIGINS` (comma-separated) into an allowlist.
 * Falls back to common Next.js dev origins for local development.
 *
 * In production set the env var to the exact origins that need access:
 *   CORS_ALLOWED_ORIGINS=https://ithasfire.com,https://www.ithasfire.com
 */
const LOCAL_DEV_WEB_ORIGINS = [3000, 3001, 3002, 3003, 3004, 3005].flatMap(
  (port) => [`http://localhost:${port}`, `http://127.0.0.1:${port}`],
);

function getAllowedOrigins(): string[] {
  const raw = process.env.CORS_ALLOWED_ORIGINS;
  if (raw) {
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (process.env.NODE_ENV === "production") {
    return [];
  }
  // Sensible local-dev defaults: Next often falls through to :3001+ when
  // another dev server is already bound to :3000.
  return LOCAL_DEV_WEB_ORIGINS;
}

const plugin: FastifyPluginAsync = async (app) => {
  // Web (Next) runs on :3000 and calls the API on :3001. tRPC uses fetch with
  // credentials enabled so auth cookies/session headers can flow.
  //
  // IMPORTANT: When credentials=true, CORS cannot respond with `*`.
  // We use an explicit allowlist to prevent credential-theft via malicious origins.
  const allowedOrigins = getAllowedOrigins();

  await app.register(
    fastifyCors as unknown as never,
    {
      origin: allowedOrigins,
      credentials: true,
    } as never,
  );
};

export default fp(plugin as unknown as never) as unknown as never;
