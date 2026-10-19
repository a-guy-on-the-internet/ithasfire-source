/**
 * Max length of a single support message body.
 *
 * Mirrors `SUPPORT_MESSAGE_MAX` in
 * `packages/core/src/use-cases/support/schemas.ts`. Kept as a local literal so
 * the client bundle never pulls the core use-case module (which wires repos /
 * server deps) just for one number. The server remains the source of truth and
 * re-validates; this is purely an ergonomic client-side cap.
 */
export const SUPPORT_MESSAGE_MAX = 4000;
