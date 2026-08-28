import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";

import { safeReporter } from "@th/ports/reporter";

import { auth } from "../auth/better-auth";
import { Sentry } from "../instrument";

/**
 * Serialise the Fastify-parsed body into a format suitable for a Fetch
 * {@link Request}.
 *
 * Apple Sign In web OAuth uses `response_mode=form_post`, meaning Apple POSTs
 * the authorisation code to our callback with
 * `Content-Type: application/x-www-form-urlencoded`.  Fastify's raw-body
 * plugin (registered earlier) parses unknown content types as a Buffer.
 *
 * We must reconstruct the original body encoding so Better Auth's internal
 * parser can process it correctly:
 *
 *  - **Buffer** (raw / form-encoded) → re-encode as URLSearchParams when the
 *    request Content-Type is `application/x-www-form-urlencoded`, otherwise
 *    pass the raw bytes.
 *  - **object** (already JSON-parsed by Fastify) → JSON-stringify.
 *  - **string** → pass through as-is.
 *  - **falsy** → `undefined` (GET requests, etc.).
 */
function serializeBody(
  body: unknown,
  contentType: string | undefined,
): BodyInit | undefined {
  if (!body) return undefined;

  // Fastify's wildcard content-type parser delivers the body as a Buffer for
  // types it doesn't have an explicit parser for, including form-encoded data.
  if (Buffer.isBuffer(body)) {
    if (contentType?.includes("application/x-www-form-urlencoded")) {
      // Decode the buffer and convert to URLSearchParams so the Fetch
      // Request carries the correct Content-Type automatically.
      return new URLSearchParams(body.toString("utf-8"));
    }
    // Other binary payloads (unlikely for auth routes, but be safe).
    // Convert to Uint8Array which is accepted by BodyInit.
    return new Uint8Array(body);
  }

  if (typeof body === "string") return body;

  // Already-parsed JSON object (e.g. sign-up, sign-in bodies).
  if (typeof body === "object") return JSON.stringify(body);

  return undefined;
}

const plugin: FastifyPluginAsync = async (app) => {
  // Better Auth expects requests under `/api/auth/*` (default basePath) unless configured otherwise.
  // We adapt Fastify's request/response to Fetch Request/Response.
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    async handler(request, reply) {
      try {
        const url = new URL(request.url, `http://${request.headers.host}`);

        const headers = new Headers();
        Object.entries(request.headers).forEach(([key, value]) => {
          if (value) headers.append(key, value.toString());
        });

        const body = serializeBody(
          request.body,
          request.headers["content-type"],
        );

        const req = new Request(url.toString(), {
          method: request.method,
          headers,
          body,
        });

        const res = await auth.handler(req);

        reply.status(res.status);
        res.headers.forEach((value, key) => reply.header(key, value));
        reply.send(res.body ? await res.text() : null);
      } catch (error) {
        // This branch swallows a THROW out of Better Auth and answers with a
        // generic 500, so it is the only place the real cause is ever
        // visible. It was previously log-only, and the log did not survive:
        // a total dev sign-in outage (every `/sign-in/*` 500ing while
        // `/get-session` stayed 200) ran for THREE WEEKS with nothing in
        // Sentry and no `better_auth_handler_failed` line in Cloud Logging to
        // grep for. Report explicitly per the ReporterPort convention in
        // CLAUDE.md — never demote this back to a bare log.
        //
        // `err` (not `error`) is the key Sentry's pinoIntegration serialises
        // as an exception; the old `{ error }` shape logged an opaque object.
        app.log.error(
          { err: error, path: request.url, method: request.method },
          "better_auth_handler_failed",
        );
        safeReporter(Sentry.captureException)(error, {
          tags: { area: "better_auth_handler" },
          extra: { path: request.url, method: request.method },
        });
        reply.status(500).send({
          error: "Internal authentication error",
          code: "AUTH_FAILURE",
        });
      }
    },
  });
};

export default fp(plugin as unknown as never) as unknown as never;
