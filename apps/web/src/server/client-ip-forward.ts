import "server-only";

/**
 * Server-only entry point for the signed visitor-IP forward. The
 * implementation and its full rationale live in `./client-ip-forward-core`,
 * which carries no `server-only` marker so the staff route gate (middleware)
 * can import it too. Route handlers, Server Components and the SSR tRPC client
 * import from HERE.
 */
export {
  signedClientIpHeaders,
  type IncomingHeaderReader,
} from "./client-ip-forward-core";
