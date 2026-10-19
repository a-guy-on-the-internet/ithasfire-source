/**
 * Step-up port: has this human just proved it is them, with a password or a
 * passkey, within a short window? (scoped-api-keys spec FR-003, R21: the
 * platform owner approves their own STAFF key request only "after a fresh
 * password or passkey check within the last 5 minutes".)
 *
 * No such mechanism existed when this port was introduced (2026-10-13):
 * `humans.verifyPassword` checks a password with no freshness window and has
 * no passkey path. The adapter (built with the platform page, plan steps 5 /
 * 9) decides what a `proof` is, e.g. a short-lived token the web mints after a
 * password or passkey prompt; core only asks whether it is valid, fresh and
 * bound to `humanId`.
 *
 * Fail closed: any doubt (unknown, expired, replayed, bound to someone else)
 * answers `{ verified: false }`.
 */
export interface StepUpPort {
  verifyFresh(input: {
    humanId: string;
    /**
     * What the proof is spent on. The adapter binds a proof to one purpose
     * and one subject so it cannot be replayed for another action.
     */
    purpose: "api_key_self_approval";
    /** The key request the self-approval is for (the proof's subject). */
    requestId: string;
    proof: string;
    /** How old the check may be, in seconds (FR-003: 300). */
    maxAgeSeconds: number;
  }): Promise<{ verified: boolean }>;
}
