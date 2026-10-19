import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import { isAppError } from "@th/errors";

// ─────────────────────────────────────────────────────────────────────────────
// A refusal that arrives AFTER a booking committed (booking-the-night review
// rounds 4–5). The booking pre-flight (`assertBookingPreflight`) refuses
// every deterministic reason before the line moves; what can still arrive
// after the commit is a race with that read. The night is booked and its
// event did not land, so the refusal must be visible — but a domain refusal
// is user-facing, and the Sentry backstops drop those (4xx). So: logged at
// error AND reported through the guarded ReporterPort (CLAUDE.md), then
// rethrown by the caller unchanged.
//
// Reported: AppErrors and the plain typed objects the save internals throw
// (`{ code: "forbidden", message: "quota_exceeded" }`). A thrown `Error`
// (a real exception) is left to the fastify/tRPC backstop, which captures it.
// ─────────────────────────────────────────────────────────────────────────────

export function isDomainRefusal(error: unknown): boolean {
  if (isAppError(error)) return true;
  return (
    typeof error === "object" &&
    error !== null &&
    !(error instanceof Error) &&
    typeof (error as { code?: unknown }).code === "string"
  );
}

export function reportPostCommitRefusal(
  deps: { logger?: LoggerPort; reportError?: ReporterPort },
  error: unknown,
  args: {
    /** The logger message, e.g. `booking_holds.book_night.post_commit_refused`. */
    event: string;
    useCase: string;
    step: string;
    extra: Record<string, unknown>;
  },
): void {
  if (!isDomainRefusal(error)) return;
  deps.logger?.error(args.event, {
    ...args.extra,
    code: (error as { code?: unknown }).code,
    err: error,
  });
  try {
    deps.reportError?.(error, {
      tags: { useCase: args.useCase, step: args.step },
      extra: args.extra,
    });
  } catch {
    // Reporting is best-effort — never change the outcome.
  }
}
