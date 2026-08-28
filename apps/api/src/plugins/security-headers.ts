import fp from "fastify-plugin";
import helmet from "@fastify/helmet";
import type { FastifyPluginAsync } from "fastify";

/**
 * Registers @fastify/helmet to set standard security headers on every response:
 *
 *  - X-Content-Type-Options: nosniff
 *  - X-Frame-Options: DENY
 *  - Strict-Transport-Security (HSTS)
 *  - X-DNS-Prefetch-Control
 *  - X-Download-Options
 *  - X-Permitted-Cross-Domain-Policies
 *  - Referrer-Policy
 *
 * CSP is disabled because this is a JSON API; the Next.js web app manages its
 * own Content-Security-Policy via middleware.
 */
const plugin: FastifyPluginAsync = async (app) => {
  await app.register(helmet, {
    // This is a JSON API -- CSP is managed by the web frontend (Next.js).
    contentSecurityPolicy: false,
    // Cross-origin resources are fetched by the browser via CORS, not frames.
    crossOriginEmbedderPolicy: false,
  });
};

export default fp(plugin);
