import { DEFAULT_TTL_SECONDS } from "./rate-limit-storage";

/**
 * Better Auth rate-limit numbers, extracted from `better-auth.ts` so the
 * invariants below can actually be TESTED (`test/auth-rate-limit-rules.test.ts`)
 * instead of only asserted in a comment. Importing `better-auth.ts` boots the
 * whole auth stack — env, DB, Redis — so its config object is not reachable
 * from a unit test; this module is.
 *
 * Nothing here is behaviour on its own: `better-auth.ts` spreads these into
 * `betterAuth({ rateLimit: … })`, which is the only consumer.
 */

/** A single rule, or `false` to exempt the path entirely. */
export type AuthRateLimitRule = { window: number; max: number } | false;

/**
 * Global floor applied to every `/api/auth/*` endpoint not overridden in
 * `AUTH_RATE_LIMIT_CUSTOM_RULES`.
 */
export const AUTH_RATE_LIMIT_GLOBAL = { window: 60, max: 100 } as const;

/**
 * TTL INVARIANT: every window here — the global floor above, the rules below,
 * AND rules shipped by Better Auth plugins or future upgrades — must stay <=
 * `DEFAULT_TTL_SECONDS` (120s) in `rate-limit-storage.ts`. The customStorage
 * hook never receives the window, so it expires Redis keys on a fixed TTL; a
 * longer window silently under-limits (key expires mid-window, counter
 * restarts). Re-exported so the test can pin both sides of the comparison.
 */
export const AUTH_RATE_LIMIT_MAX_WINDOW_SECONDS = DEFAULT_TTL_SECONDS;

/**
 * Per-path overrides. Noticeably stricter than the global floor for the
 * brute-force-relevant sign-in / OTP-verification / 2FA surfaces.
 *
 * Every path string was confirmed against the installed plugin source
 * (grepped `createAuthEndpoint("/...")` literals in `better-auth` /
 * `@better-auth/passkey` dist) rather than guessed — an unconfirmed path would
 * silently no-op and leave that endpoint on the global floor only.
 */
export const AUTH_RATE_LIMIT_CUSTOM_RULES = {
  // ── Password / username sign-in: classic credential brute force ──
  "/sign-in/email": { window: 60, max: 5 },
  "/sign-in/username": { window: 60, max: 5 },

  // ── OTP-based sign-in and verification: small guess space (6 digits)
  "/sign-in/email-otp": { window: 60, max: 5 },
  "/email-otp/verify-email": { window: 60, max: 5 },
  // Resend/send endpoints: not brute-forceable, but capped to stop
  // email/SMS-bombing a victim address/number.
  "/email-otp/send-verification-otp": { window: 60, max: 3 },
  "/sign-in/phone-number": { window: 60, max: 5 },
  "/phone-number/verify": { window: 60, max: 5 },
  "/phone-number/send-otp": { window: 60, max: 3 },

  // ── Two-factor verification: small guess space, highest-value target
  "/two-factor/verify-totp": { window: 60, max: 5 },
  "/two-factor/verify-otp": { window: 60, max: 5 },
  "/two-factor/verify-backup-code": { window: 60, max: 5 },

  // ── Magic link / passkey verification: high-entropy token or WebAuthn
  // signature, not realistically brute-forceable, but still capped tighter
  // than the global floor against scripted abuse.
  "/magic-link/verify": { window: 60, max: 10 },
  "/passkey/verify-authentication": { window: 60, max: 10 },

  // ── Polled on virtually every page load — never rate-limit this or
  // legitimate sessions get randomly logged out under normal traffic.
  "/get-session": false,

  // ── JWT mint for server-to-server calls. NEEDS HEADROOM, and not for the
  // reason the other entries here exist.
  //
  // Every caller of this endpoint on the SSR/edge path is the WEB SERVICE, not
  // a browser: `web/src/middleware/staff-route-gate.ts` mints one token per
  // gated `/moderate` or `/platform` navigation, and `web/src/server/
  // trpc-client.ts` mints one per signed-in SSR render. Better Auth keys the
  // limiter on client IP (see the `getIp` precedence note in better-auth.ts),
  // and those requests carry no `cf-connecting-ip` — they never transit
  // Cloudflare — so they all collapse onto ONE key: the web service's Cloud
  // Run egress IP, SHARED BY EVERY SIGNED-IN USER.
  //
  // On the global 100/60s floor that is a silent, staff-wide lockout waiting
  // to happen: exhausting the key makes the mint return a non-2xx, the edge
  // gate fails closed, and real ADMINs get bounced to /access-denied with
  // nothing obviously wrong. PlatformShell alone prefetches ~25 sidebar links,
  // so a handful of staff can burn the floor inside a minute — before counting
  // ordinary signed-in SSR traffic on the same key.
  //
  // Raising it is safe because this is not a brute-force surface: minting
  // requires an already-valid Better Auth session cookie, so the endpoint hands
  // a derived credential to someone already authenticated. It converts no
  // guesses into access. 300/60s = 3x the global floor: enough headroom for the
  // shared-egress-IP aggregation above, still finite so a compromised session
  // can't use it as an unbounded amplifier. Prefer raising this number over
  // setting `false` if it is ever hit — `false` removes the ceiling entirely.
  //
  // `window` stays at 60 to respect the TTL INVARIANT above.
  //
  // DELIBERATELY EXCLUDED from AUTH_GUESS_SPACE_PATHS below (i.e. NOT enforced
  // atomically): the atomic pre-limiter turns a cap that concurrency currently
  // lets leak into a HARD ceiling. On a key shared by every staff member (the
  // web service's egress IP) that would re-create the exact silent
  // ADMIN-lockout this 300 was raised to fix. `/token` is not a guess-space
  // surface anyway — minting requires an already-valid session.
  //
  // WHAT WAS ACTUALLY MEASURED (and what wasn't): against the live dev API,
  // keyed via `cf-connecting-ip`, SEQUENTIAL requests showed the first 429 at
  // request #101 with this rule removed (the global floor) and 150/150 x 200
  // with it in place. Both runs were sequential ON PURPOSE — they measure THIS
  // NUMBER, not the effective ceiling. Better Auth's limiter is a non-atomic
  // read-modify-write (`get` → `set(count+1)`, `api/rate-limiter/index.mjs`),
  // so concurrent requests lose increments: 150 mints at 6-way concurrency
  // produced ZERO 429s here, and 24 concurrent bad-password sign-ins all
  // passed a 5/60s cap. Under concurrency every cap in this file is a FLOOR,
  // not a ceiling. Don't read these numbers as enforced limits under load.
  "/token": { window: 60, max: 300 },
} as const satisfies Record<string, AuthRateLimitRule>;

/**
 * The subset of {@link AUTH_RATE_LIMIT_CUSTOM_RULES} keys that carry a real
 * rule (i.e. everything except the `false` exemptions). Used to make
 * {@link AUTH_GUESS_SPACE_PATHS} a COMPILE error if it ever names a path that
 * has no rule — or one that has been exempted — rather than silently
 * degrading that endpoint to "atomically limited by nothing".
 */
type RuleBackedAuthPath = {
  [K in keyof typeof AUTH_RATE_LIMIT_CUSTOM_RULES]: (typeof AUTH_RATE_LIMIT_CUSTOM_RULES)[K] extends false
    ? never
    : K;
}[keyof typeof AUTH_RATE_LIMIT_CUSTOM_RULES];

/**
 * ── GUESS-SPACE SURFACES ────────────────────────────────────────────────
 *
 * The endpoints where the cap above IS the security control, not just abuse
 * hygiene: every one of them converts a *guess* (password, 6-digit OTP,
 * backup code) or a *send* into progress for an attacker.
 *
 * These — and ONLY these — are additionally enforced by the ATOMIC
 * pre-limiter in `plugins/auth-rate-limit.ts`, because Better Auth's own
 * limiter is a non-atomic read-modify-write (`get(key)` → compute →
 * `set(key, count+1)`; see `api/rate-limiter/index.mjs`). All concurrent
 * requests read the same count, so under concurrency EVERY number in this
 * file is a floor rather than a ceiling. Measured on the live dev API against
 * `/sign-in/email` (5/60s), one pinned `cf-connecting-ip`:
 *
 *   12 SEQUENTIAL  → 401 401 401 401 401 429 429 429 429 429 429 429
 *   24 CONCURRENT  → 24x 401, ZERO 429s
 *
 * This list is the SINGLE SOURCE OF TRUTH shared by both limiters: the atomic
 * pre-limiter reads its window/max straight out of the table above via
 * {@link resolveGuessSpaceRule}, so the two can never drift to different
 * numbers. Better Auth's limiter stays enabled and unchanged as a backstop —
 * the effective limit is the min of the two FOR THE CANONICAL PATH ONLY.
 * Better Auth keys its limiter with `normalizePathname` (a `startsWith`
 * basePath strip) while its router strips with `split` + rou3, so any
 * non-canonical form of these paths misses `customRules` entirely and falls to
 * the 100/60s global floor. The atomic pre-limiter is the ONLY layer applying
 * these numbers to those forms.
 *
 * NOT here, on purpose (asserted in `test/auth-rate-limit-rules.test.ts`):
 *  - `/get-session` — exempt entirely; polled on virtually every page load.
 *  - `/token` — see the long note on its rule above. Server-to-server mint
 *    from ONE shared egress IP; making 300 a hard ceiling risks re-creating
 *    the staff-wide lockout that number exists to prevent.
 *  - the global floor — a hard atomic 100/60s across every auth endpoint is
 *    a self-inflicted outage waiting for the first busy page.
 */
export const AUTH_GUESS_SPACE_PATHS = [
  // Credential brute force.
  "/sign-in/email",
  "/sign-in/username",
  "/sign-in/phone-number",
  // OTP verification — 6-digit guess space.
  "/sign-in/email-otp",
  "/email-otp/verify-email",
  "/phone-number/verify",
  // Two-factor verification — small guess space, highest-value target.
  "/two-factor/verify-totp",
  "/two-factor/verify-otp",
  "/two-factor/verify-backup-code",
  // High-entropy tokens/signatures: not realistically guessable, but capped
  // against scripted abuse of the verify path.
  "/magic-link/verify",
  "/passkey/verify-authentication",
  // Anti-bombing: not brute-forceable, but an uncapped send endpoint is a
  // free email/SMS cannon pointed at a victim address/number.
  "/email-otp/send-verification-otp",
  "/phone-number/send-otp",
] as const satisfies readonly RuleBackedAuthPath[];

export type AuthGuessSpacePath = (typeof AUTH_GUESS_SPACE_PATHS)[number];

/** Membership test for {@link AUTH_GUESS_SPACE_PATHS} (O(1), path-exact). */
export const AUTH_GUESS_SPACE_PATH_SET: ReadonlySet<string> = new Set(
  AUTH_GUESS_SPACE_PATHS,
);

/**
 * Every guess-space path classified as a GUESS surface or a SEND surface.
 *
 * A TOTAL record, deliberately — not a `Set` of the send paths. A set only
 * catches a typo; it cannot catch an OMISSION, and omission is the actual
 * failure mode: add a new send-style endpoint to `AUTH_GUESS_SPACE_PATHS`,
 * forget to list it here, and it silently inherits the 12x guess multiplier.
 * That is precisely how raising the shared multiplier 4 → 12 widened the
 * anti-bombing ceiling without anyone noticing. `satisfies
 * Record<AuthGuessSpacePath, …>` makes adding a path a COMPILE error until it
 * is classified.
 *
 * "send" endpoints exist for a different reason than every other cap here: a
 * send is NOT a guess. An attacker learns nothing by calling one; the harm is
 * entirely on the victim's side — an inbox or a phone full of codes they did
 * not ask for (plus a real per-message cost to us). They therefore get
 * {@link AUTH_ACCOUNT_BUCKET_MULTIPLIER_SEND}, not
 * {@link AUTH_ACCOUNT_BUCKET_MULTIPLIER}.
 */
const AUTH_PATH_KIND = {
  "/sign-in/email": "guess",
  "/sign-in/username": "guess",
  "/sign-in/phone-number": "guess",
  "/sign-in/email-otp": "guess",
  "/email-otp/verify-email": "guess",
  "/phone-number/verify": "guess",
  "/two-factor/verify-totp": "guess",
  "/two-factor/verify-otp": "guess",
  "/two-factor/verify-backup-code": "guess",
  "/magic-link/verify": "guess",
  "/passkey/verify-authentication": "guess",
  "/email-otp/send-verification-otp": "send",
  "/phone-number/send-otp": "send",
} as const satisfies Record<AuthGuessSpacePath, "guess" | "send">;

/**
 * How much more generous the PER-ACCOUNT bucket is than the PER-IP bucket
 * (so `/sign-in/email` is 5/60s per IP and 60/60s per account).
 *
 * DOES NOT APPLY to {@link AUTH_SEND_PATHS} — see
 * {@link AUTH_ACCOUNT_BUCKET_MULTIPLIER_SEND}.
 *
 * ## The trade-off, honestly
 *
 * Per-account limiting is an attacker-induced-lockout DoS vector, and the
 * cost to the attacker is LOW: anyone who knows a victim's email address can
 * deny that victim sign-in for the length of the window by sending
 * `accountCap` requests per minute. No credentials, no account, no botnet —
 * just the email address. This was not reasoned about, it was DEMONSTRATED on
 * the live dev API: after driving one account's bucket past its cap, a
 * sign-in with the CORRECT password from a FRESH IP came back 429.
 *
 * Two things bound that cost, and neither is "the cap is small":
 *
 *  1. The evaluator consumes the IP bucket FIRST and short-circuits, so a
 *     request that is already being 429'd never spends the victim's token.
 *     Sustaining the lockout therefore requires ceil(accountCap / ipCap)
 *     DISTINCT source IPs, not one host in a loop.
 *  2. The window is 60s and nothing latches. The victim is inconvenienced for
 *     as long as the attacker keeps paying, and recovers immediately after.
 *
 * ## Why 12 and not 4
 *
 * The account bucket's ONLY job is to make SUSTAINED single-account brute
 * force impractical — the attack per-IP limiting misses completely, because
 * an attacker with a botnet or a proxy pool never trips a per-IP cap at all.
 * It is not supposed to double as a lockout button, so it should be sized at
 * the loosest value that still ends the attack.
 *
 * At 12x, one account absorbs at most 60 guesses/minute across the entire
 * internet — against an unbounded number before this layer existed. That is
 * ~86k/day, which is nothing against any non-terrible password, and it is the
 * cheapest number that keeps ordinary humans and shared-NAT offices far away
 * from the ceiling. Dropping to 4x (20/min) bought a marginally tighter
 * brute-force bound and made targeted lockout three times cheaper — the wrong
 * side of the trade for a control whose failure mode is "legitimate user
 * cannot sign in".
 *
 * If this needs tuning, RAISE it. Never lower it below the IP cap: the
 * account bucket would become the binding constraint on ordinary traffic and
 * the lockout would get cheaper than the brute force it exists to stop.
 */
export const AUTH_ACCOUNT_BUCKET_MULTIPLIER = 12;

/**
 * Account-bucket multiplier for {@link AUTH_SEND_PATHS}.
 *
 * The 12x above is justified ENTIRELY by guess-space reasoning: "one account
 * absorbs at most 60 guesses/minute, which is nothing against a non-terrible
 * password". That argument does not transfer to a send endpoint, because a
 * send is not a guess — 12x there buys ZERO brute-force resistance and simply
 * triples (3/min → 36/min) the number of emails/SMS an IP-rotating attacker
 * can aim at one victim's inbox. That is the entire harm model of the
 * endpoint, made worse by a change that had nothing to do with it.
 *
 * 3x keeps the per-account send ceiling at 9/minute: still headroom for a
 * legitimate "resend the code" retry from a couple of devices/networks, still
 * far below anything that reads as bombing, and it preserves the property the
 * `max: 3` rule was written for.
 *
 * The lockout-DoS argument for a generous multiplier is much weaker here too:
 * being unable to request a THIRD verification code in the same minute is a
 * minor inconvenience, not "cannot sign in".
 */
export const AUTH_ACCOUNT_BUCKET_MULTIPLIER_SEND = 3;

/**
 * The rule the atomic pre-limiter should enforce for `path`, or `null` when
 * the path is not a guess-space surface (i.e. leave it to Better Auth's own
 * limiter). `path` is the Better-Auth-normalized path — basePath stripped,
 * no query string, no trailing slash — e.g. `/sign-in/email`.
 */
export function resolveGuessSpaceRule(
  path: string,
): { window: number; max: number } | null {
  if (!AUTH_GUESS_SPACE_PATH_SET.has(path)) return null;
  const rule = (
    AUTH_RATE_LIMIT_CUSTOM_RULES as Record<
      string,
      AuthRateLimitRule | undefined
    >
  )[path];
  // Unreachable while RuleBackedAuthPath holds at compile time; kept as a
  // runtime belt so a future edit can only ever DISABLE the extra layer,
  // never crash the auth request path.
  if (!rule) return null;
  return { window: rule.window, max: rule.max };
}

/**
 * The PER-ACCOUNT cap for `path`, or `null` when the path is not guess-space.
 *
 * Split from `resolveGuessSpaceRule` so the send-vs-guess distinction lives in
 * ONE place next to the numbers it applies, rather than as an `if` in the
 * evaluator that the next multiplier change would miss (which is exactly how
 * the 4→12 bump silently tripled the send ceiling).
 */
export function resolveAccountCap(
  path: string,
): { window: number; max: number } | null {
  const rule = resolveGuessSpaceRule(path);
  if (!rule) return null;
  const kind = (AUTH_PATH_KIND as Record<string, "guess" | "send" | undefined>)[
    path
  ];
  const multiplier =
    kind === "send"
      ? AUTH_ACCOUNT_BUCKET_MULTIPLIER_SEND
      : AUTH_ACCOUNT_BUCKET_MULTIPLIER;
  return { window: rule.window, max: rule.max * multiplier };
}

/**
 * Both caps for `path` in ONE lookup, or `null` when it is not guess-space.
 *
 * Exists so the evaluator cannot end up with a non-null assertion whose safety
 * depends on two separate calls staying in the same order — a reorder there
 * would be a runtime crash on the auth request path, which is the one place
 * this module must never throw.
 */
export function resolveAuthLimits(path: string): {
  ip: { window: number; max: number };
  account: { window: number; max: number };
} | null {
  const ip = resolveGuessSpaceRule(path);
  if (!ip) return null;
  const account = resolveAccountCap(path);
  if (!account) return null;
  return { ip, account };
}
