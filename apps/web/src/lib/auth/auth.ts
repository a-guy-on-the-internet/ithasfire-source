import { createAuthClient } from "better-auth/client";
import { usernameClient } from "better-auth/client/plugins";

import { webEnv } from "@/config/env";

/**
 * Web Better Auth client.
 *
 * The Better Auth *server* is hosted in `apps/api`.
 * Clients should talk directly to the API host (no Next.js proxy).
 */
export const authClient = createAuthClient({
  // Always point directly at the Fastify API server.
  // Better Auth expects an absolute base URL (and Node fetch can't use relative URLs).
  baseURL: webEnv.apiBaseUrl
    ? `${webEnv.apiBaseUrl}/api/auth`
    : "http://localhost:3001/api/auth",
  plugins: [usernameClient()],
});
