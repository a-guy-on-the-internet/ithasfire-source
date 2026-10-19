import type { TurnstilePort } from "@th/ports/turnstile";

/**
 * No-op implementation: always passes verification.
 * Used when TURNSTILE_SECRET_KEY is not configured (local dev, tests).
 */
export class NoopTurnstileAdapter implements TurnstilePort {
  readonly enabled = false;

  async verify(_token: string, _remoteIp?: string): Promise<boolean> {
    return true;
  }
}
