import { randomUUID } from "node:crypto";

/**
 * Generate a short, hard-to-guess ticket code that is URL friendly.
 */
export function generateTicketCode(): string {
  return `tk_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}
