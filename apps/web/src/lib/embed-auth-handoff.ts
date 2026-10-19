/**
 * Popup auth-handoff protocol between the /embed/book/[embedId] iframe and the
 * first-party /embed/auth-handoff popup
 * (spec 2026-07-13 booking-request-embed-button FR-010).
 *
 * The widget iframe is a cross-site frame of our origin, so the Better Auth
 * session cookie is a third-party cookie there and MUST NOT be relied on.
 * Instead the iframe opens a top-level popup to our origin (first-party
 * context, cookies work), which mints a short-lived bearer JWT via the
 * existing Better Auth token endpoint and posts it back:
 *
 *   iframe                              popup (same origin, top-level)
 *   ──────                              ──────────────────────────────
 *   window.open(OUR_ORIGIN/embed/auth-handoff)
 *                                       resolve session (redirect through
 *                                       /sign-in if needed) → mint JWT
 *                     ◀─ postMessage({ type: "hf:auth-token", token },
 *                                     targetOrigin = OUR ORIGIN exactly)
 *   accept ONLY when:
 *     event.origin === window.location.origin
 *     event.source === the popup we opened
 *     payload shape-validates (isEmbedAuthTokenMessage)
 *
 * The token lives in React state only — never localStorage / sessionStorage /
 * cookies / URLs — and is dropped on UNAUTHORIZED (JWTs are ~15 min).
 */

export const EMBED_AUTH_HANDOFF_PATH = "/embed/auth-handoff";

export const EMBED_AUTH_MESSAGE_TYPE = "hf:auth-token" as const;

export type EmbedAuthTokenMessage = {
  type: typeof EMBED_AUTH_MESSAGE_TYPE;
  token: string;
};

/** Strict shape validation for the handoff payload — everything else is ignored. */
export function isEmbedAuthTokenMessage(
  data: unknown,
): data is EmbedAuthTokenMessage {
  if (typeof data !== "object" || data === null) return false;
  const candidate = data as { type?: unknown; token?: unknown };
  return (
    candidate.type === EMBED_AUTH_MESSAGE_TYPE &&
    typeof candidate.token === "string" &&
    candidate.token.length > 0 &&
    // A JWT is well under this; reject absurd payloads outright.
    candidate.token.length <= 8192
  );
}
