import type { ClockPort } from "@th/ports/clock";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type EnforceCooldownInput = {
  clock: ClockPort;
  /** The timestamp of the last action (e.g. last sent announcement). `null`/`undefined` means no prior action. */
  lastActionAt: Date | null | undefined;
  /** Minimum seconds that must elapse between actions. */
  cooldownSeconds: number;
  /**
   * A human-readable action description used in the error message.
   * @example "sending another announcement to this audience"
   */
  actionDescription: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Cooldown guard
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Enforces a time-based cooldown between repeated actions.
 *
 * @throws `{ code: "rate_limited", message }` when the cooldown period has not
 *   fully elapsed since `lastActionAt`.
 *
 * @example
 * ```ts
 * enforceCooldown({
 *   clock: deps.clock,
 *   lastActionAt: latestAnnouncement?.sentAt,
 *   cooldownSeconds: 300,
 *   actionDescription: "sending another announcement to this audience",
 * });
 * ```
 */
export function enforceCooldown(input: EnforceCooldownInput): void {
  const { clock, lastActionAt, cooldownSeconds, actionDescription } = input;

  if (!lastActionAt) return;

  const now = clock.now();
  const elapsedSeconds = (now.getTime() - lastActionAt.getTime()) / 1_000;

  if (elapsedSeconds < cooldownSeconds) {
    const remainingSeconds = Math.ceil(cooldownSeconds - elapsedSeconds);
    throw {
      code: "rate_limited",
      message: `Please wait ${remainingSeconds} seconds before ${actionDescription}`,
    } as const;
  }
}
