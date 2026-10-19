/**
 * Port for verifying Cloudflare Turnstile tokens (bot / abuse protection).
 *
 * Implementations:
 * - CloudflareTurnstileAdapter (production — calls siteverify API)
 * - NoopTurnstileAdapter (dev / when TURNSTILE_SECRET_KEY is not configured)
 */
export interface TurnstilePort {
  /**
   * Verify a client-side Turnstile token.
   * Returns `true` if the token is valid, `false` otherwise.
   */
  verify(token: string, remoteIp?: string): Promise<boolean>;

  /** Whether Turnstile enforcement is enabled. */
  readonly enabled: boolean;
}
