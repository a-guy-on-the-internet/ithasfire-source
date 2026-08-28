import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { hashPassword } from "better-auth/crypto";
import {
  bearer,
  customSession,
  emailOTP,
  jwt,
  magicLink,
  oAuthProxy,
  phoneNumber,
  twoFactor,
  username,
} from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { OAuth2Client } from "google-auth-library";
import { createRemoteJWKSet, jwtVerify } from "jose";

import { prisma } from "@th/db";
import { provisionHumanForAuthUser } from "@th/core/use-cases/humans/provision-human-for-auth-user";
import { recordSmsOptIn } from "@th/core/use-cases/comms/record-sms-opt-in";
import { createSystemClock } from "@th/adapters/infra/clock";
import { createPrismaEmailDeliverabilityAdapter } from "@th/adapters/db/prisma-email-deliverability-adapter";
import { logAndAlert } from "@th/adapters/infra/discord-alerts";
import { createPinoLoggerAdapter } from "@th/adapters/infra/logger";
import { createPrismaRepos } from "@th/adapters/db/prisma-repos";
import { withGuardedRepos } from "@th/adapters/decorators/with-dependency-guard";
import { CLIENT_IP_HEADER_PRECEDENCE } from "@th/trpc/client-ip";

import { env } from "../lib/env";
import { fireDiscordAlert } from "../lib/dep";
import { Sentry } from "../instrument";
import { createAuthDeps } from "./deps";
import { clearEmailDeliveryStatusAfterVerification } from "./email-delivery-verification";
import { summarizeAuthMailerDiagnostics } from "./mailer-diagnostics";
import {
  logAuthUserSignedUp,
  logAuthVerificationEmailSent,
} from "./observability";
import { createPhoneOtpSender, createTwoFactorOtpSender } from "./otp-senders";
import {
  deleteUnprovisionedAuthUserWhere,
  handleProvisioningWithRollback,
  provisionGuardConfig,
  resolveHumanIdWithSelfHeal,
} from "./provision-recovery";
import { createBetterAuthRateLimitStorage } from "./rate-limit-storage";
import {
  AUTH_RATE_LIMIT_CUSTOM_RULES,
  AUTH_RATE_LIMIT_GLOBAL,
} from "./rate-limit-rules";
import { resolveCookieDomain } from "./cookie-domain";
import {
  HOST_ONLY_CLEAR_COOKIE_ATTRIBUTES,
  hostOnlySessionCookiesToClearForResponse,
} from "./host-only-session-cookie";
import { handleShadowUpgrade } from "./shadow-upgrade";

function parseTrustedOrigins(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function resolveTrustedOrigins(): string[] {
  const envOrigins = parseTrustedOrigins(env.BETTER_AUTH_TRUSTED_ORIGINS);
  // Always include Apple ID for Sign in with Apple flows
  const appleIdOrigin = "https://appleid.apple.com";
  // Native app deep-link schemes used by Expo clients (consumer + scanner).
  // These must be trusted so `callbackURL: "ithasfire-scanner://..."` passes
  // Better Auth's originCheckMiddleware.
  const nativeSchemes = ["ithasfire://", "ithasfire-scanner://"];

  // The oAuthProxy plugin rewrites callbackURL to an absolute URL on the API's
  // own origin (e.g. http://localhost:3001/api/auth/oauth-proxy-callback?...).
  // That URL must itself be trusted, otherwise originCheckMiddleware rejects it
  // with INVALID_CALLBACK_URL before the proxy flow can complete.
  const apiOrigin = (() => {
    try {
      return new URL(env.BETTER_AUTH_BASE_URL ?? env.APP_BASE_URL).origin;
    } catch {
      return null;
    }
  })();

  if (envOrigins.length > 0) {
    const base = envOrigins.includes(appleIdOrigin)
      ? envOrigins
      : [...envOrigins, appleIdOrigin];
    // Always include the API's own origin so oAuthProxy callbacks are trusted.
    const withApi =
      apiOrigin && !base.includes(apiOrigin) ? [...base, apiOrigin] : base;
    return [...withApi, ...nativeSchemes.filter((s) => !withApi.includes(s))];
  }

  if (process.env.NODE_ENV === "production") {
    const prodBase = apiOrigin ? [appleIdOrigin, apiOrigin] : [appleIdOrigin];
    return [...prodBase, ...nativeSchemes];
  }

  return [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:3100",
    "http://127.0.0.1:3100",
    // Include the API origin so oAuthProxy's rewritten callbackURL passes
    // origin validation (the proxy replaces callbackURL with an absolute URL
    // pointing back to this server's /api/auth/oauth-proxy-callback endpoint).
    ...(apiOrigin
      ? [apiOrigin]
      : ["http://localhost:3001", "http://127.0.0.1:3001"]),
    appleIdOrigin,
    // Native app deep-link schemes used by Expo clients. Better Auth validates
    // callbackURL against this list, so the scanner's magic-link flow needs
    // its scheme trusted (mobile consumer app likewise).
    "ithasfire://",
    "ithasfire-scanner://",
  ];
}

function summarizeResetUrlForLog(value: string): {
  origin: string | null;
  path: string | null;
} {
  try {
    const parsed = new URL(value);
    return {
      origin: parsed.origin,
      path: parsed.pathname,
    };
  } catch {
    return {
      origin: null,
      path: null,
    };
  }
}

function maskEmail(value: string | null | undefined): string | null {
  if (!value) return null;

  const [localPart, domain] = value.split("@");
  if (!localPart || !domain) {
    return value.length <= 2
      ? `${value[0] ?? "*"}*`
      : `${value[0]}***${value[value.length - 1]}`;
  }

  const maskedLocal =
    localPart.length <= 2
      ? `${localPart[0] ?? "*"}*`
      : `${localPart[0]}***${localPart[localPart.length - 1]}`;
  const [domainLabel, ...domainSuffix] = domain.split(".");
  const maskedDomainLabel = !domainLabel
    ? "***"
    : domainLabel.length <= 2
      ? `${domainLabel[0] ?? "*"}*`
      : `${domainLabel[0]}***${domainLabel[domainLabel.length - 1]}`;

  return `${maskedLocal}@${maskedDomainLabel}${domainSuffix.length > 0 ? `.${domainSuffix.join(".")}` : ""}`;
}

function summarizeErrorForLog(error: unknown): {
  name: string;
  code: string | null;
  status: number | null;
} {
  const record =
    typeof error === "object" && error !== null
      ? (error as {
          name?: unknown;
          code?: unknown;
          status?: unknown;
          statusCode?: unknown;
        })
      : null;

  const rawStatus = record?.status ?? record?.statusCode;

  return {
    name: error instanceof Error ? error.name : "UnknownError",
    code: typeof record?.code === "string" ? record.code : null,
    status: typeof rawStatus === "number" ? rawStatus : null,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildMagicLinkEmailHtml(params: {
  productName: string;
  url: string;
}): string {
  const safeProductName = escapeHtml(params.productName);
  const safeUrl = escapeHtml(params.url);

  return `
		<div style="font-family:Arial,sans-serif;color:#111827;line-height:1.5;max-width:560px;margin:0 auto;padding:24px;">
			<p style="font-size:14px;color:#4b5563;margin:0 0 12px;">${safeProductName} scanner sign-in</p>
			<h1 style="font-size:24px;margin:0 0 16px;">Open the scanner app</h1>
			<p style="margin:0 0 16px;">Use the button below on the same phone where you installed the scanner app.</p>
			<p style="margin:0 0 24px;">
				<a href="${safeUrl}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:600;">Sign in to scanner</a>
			</p>
			<p style="font-size:14px;color:#4b5563;margin:0;">If the button does not work, open this link directly:</p>
			<p style="font-size:14px;word-break:break-all;margin:8px 0 0;">${safeUrl}</p>
		</div>
	`;
}

const resolveGoogleClientIds = (): string[] => {
  return [
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_WEB_CLIENT_ID,
    env.GOOGLE_IOS_CLIENT_ID,
    env.GOOGLE_ANDROID_CLIENT_ID,
  ].filter((value): value is string => Boolean(value));
};

const googleClientIds = resolveGoogleClientIds();
const googleOAuthClient =
  googleClientIds.length > 0 ? new OAuth2Client() : null;

const verifyGoogleIdToken = async (idToken: string): Promise<boolean> => {
  if (!googleOAuthClient || googleClientIds.length === 0) {
    throw new Error("Google OAuth client IDs are not configured");
  }

  const ticket = await googleOAuthClient.verifyIdToken({
    idToken,
    audience: googleClientIds,
  });
  const payload = ticket.getPayload();
  if (!payload?.sub) {
    throw new Error("Google ID token missing subject");
  }
  return true;
};

const appleIssuer = "https://appleid.apple.com";
const appleAudiences = [
  env.APPLE_CLIENT_ID,
  env.APPLE_APP_BUNDLE_IDENTIFIER,
].filter((value): value is string => Boolean(value));
const appleJwks = createRemoteJWKSet(new URL(`${appleIssuer}/auth/keys`));

const verifyAppleIdToken = async (idToken: string): Promise<boolean> => {
  if (appleAudiences.length === 0) {
    throw new Error("Apple OAuth audiences are not configured");
  }

  const { payload } = await jwtVerify(idToken, appleJwks, {
    issuer: appleIssuer,
    audience: appleAudiences,
  });
  if (!payload.sub) {
    throw new Error("Apple ID token missing subject");
  }
  return true;
};

// ── Cross-subdomain session cookie ──────────────────────────────────────────
// Prod: web origin (`ithasfire.com`) and api origin (`api.ithasfire.com`) are
// different hosts, so the default host-only session cookie set by the API is
// invisible to the web app. Scope it to the shared parent domain
// (`.ithasfire.com`) so both origins can read it.
//
// The domain is an EXPLICIT, per-environment env var (`SESSION_COOKIE_DOMAIN`),
// NOT derived from the web/api URLs: dev + prod both live under the single
// registrable domain `ithasfire.com`, so any URL-suffix derivation yields the
// SAME `.ithasfire.com` for both and collides across environments (cookie
// clobber + prod token leaking to dev services). It is therefore set ONLY on
// prod (see infra/terraform prod.tfvars) and left UNSET on dev, which keeps
// dev host-only and isolated. `resolveCookieDomain` validates + host-binds the
// operator value; an unset/invalid value yields null → we OMIT
// crossSubDomainCookies and keep the default host-only cookie.
const crossSubDomainCookieDomain = resolveCookieDomain(
  env.SESSION_COOKIE_DOMAIN,
  env.BETTER_AUTH_BASE_URL ?? env.APP_BASE_URL,
);

// Surface a misconfiguration loudly-but-safely: if an operator SET
// SESSION_COOKIE_DOMAIN but it failed validation (bad shape, public suffix, or
// not a parent of the api host), the cookie silently falls back to host-only —
// which would break cross-subdomain sessions. Log at ERROR (not warn) once at
// boot so it's captured by Sentry's pinoIntegration — warn is not captured (see
// CLAUDE.md error-reporting convention) and a fat-fingered prod env var would
// otherwise silently degrade auth to host-only. Never throw: a bad value must
// not take auth down.
if (env.SESSION_COOKIE_DOMAIN && !crossSubDomainCookieDomain) {
  createPinoLoggerAdapter().error("auth_session_cookie_domain_invalid", {
    reason:
      "SESSION_COOKIE_DOMAIN is set but failed validation (must be a leading-dot registrable domain that the api host lives under); falling back to a host-only session cookie",
  });
}

export const auth = betterAuth({
  // Better Auth defaults to /api/auth for basePath.
  baseURL: env.BETTER_AUTH_BASE_URL ?? env.APP_BASE_URL,
  secret: env.BETTER_AUTH_SECRET ?? undefined,
  trustedOrigins: resolveTrustedOrigins(),

  // ── Rate limiting (2026-07-05 security-audit follow-up: defense in depth)
  // ─────────────────────────────────────────────────────────────────────
  // Better Auth's built-in limiter disables itself by default outside
  // production; set `enabled: true` explicitly so behaviour is identical and
  // predictable across dev/prod. `window`/`max` are the global floor applied
  // to every `/api/auth/*` endpoint that isn't overridden below.
  //
  // Counters live in Redis via `customStorage` (see `rate-limit-storage.ts`),
  // the same Redis that backs the tRPC-side `RateLimitPort`, so limits are
  // enforced **cross-instance**: the `api` Cloud Run service scales
  // min_instances=0/max_instances=10 (see infra/terraform/variables.tf), and
  // with the previous per-process `storage: "memory"` each instance saw only
  // its own slice of a caller's attempts (~10x effective cap, reset on cold
  // starts). `customStorage` is used instead of
  // `storage: "secondary-storage"` because the latter requires a root-level
  // `secondaryStorage` option that Better Auth ALSO uses for session
  // caching — a side effect we don't want; `customStorage` hooks only the
  // rate limiter (when set, `storage` is ignored entirely).
  //
  // The storage FAILS OPEN on Redis errors (log + allow) — Better Auth does
  // not catch storage errors itself, so a throwing store would 500 every
  // auth request; see the wrapper for the guard.ts-mirroring rationale.
  // There is no Cloud Armor / GCLB / Cloudflare rate-limit rule in front of
  // this API (confirmed via infra/terraform — public ingress, Cloudflare Pro
  // edge DDoS mitigation only, no WAF/rate-limit rules configured), so this
  // is the only rate limiting layer standing in front of these endpoints
  // today — and it's unenforced for exactly as long as Redis is down.
  //
  // The numbers themselves — the global floor and the per-path
  // `customRules` — live in `rate-limit-rules.ts`, extracted so
  // `test/auth-rate-limit-rules.test.ts` can enforce the TTL INVARIANT (and
  // the reasoning for each cap) instead of leaving it to a comment nobody
  // re-reads. Importing THIS module from a test would boot the whole auth
  // stack; that one is free to import.
  rateLimit: {
    enabled: true,
    window: AUTH_RATE_LIMIT_GLOBAL.window,
    max: AUTH_RATE_LIMIT_GLOBAL.max,
    // TTL INVARIANT: every window in this block — the global floor above,
    // the customRules below, AND rules shipped by Better Auth plugins or
    // future upgrades — must stay <= DEFAULT_TTL_SECONDS (120s) in
    // `rate-limit-storage.ts`. The customStorage hook never receives the
    // window, so it expires Redis keys on a fixed TTL; a longer window
    // silently under-limits (key expires mid-window, counter restarts).
    customStorage: createBetterAuthRateLimitStorage({
      // Best-effort Sentry reporter for the fail-open branches in
      // rate-limit-storage.ts (get/set/init) — a Redis outage here silently
      // disables ALL auth rate limiting, so it must not go unreported. Always
      // fail-safe; a throwing/no-op capture never changes the fail-open
      // behaviour it wraps.
      reportError: Sentry.captureException,
    }),
    customRules: AUTH_RATE_LIMIT_CUSTOM_RULES,
  },

  // ── Client-IP resolution for the rate limiter ────────────────────────
  // Better Auth's default is `["x-forwarded-for"]`, leftmost entry — fully
  // client-forgeable behind Cloudflare → Cloud Run (proxies APPEND to XFF,
  // so the leftmost entry is client-supplied): an attacker rotating forged
  // IPs shards the rate-limit key and bypasses the limits above. Use the
  // platform-wide precedence instead (`CLIENT_IP_HEADER_PRECEDENCE`,
  // packages/transport/trpc/src/client-ip.ts — the tRPC limiter's single
  // source of truth): `cf-connecting-ip` is set by Cloudflare and
  // unforgeable WHILE traffic transits Cloudflare; `x-forwarded-for` stays
  // as the last fallback so direct-to-run.app traffic is still keyed at all
  // (when getIp resolves nothing, Better Auth SKIPS rate limiting entirely
  // in production).
  //
  // Hop-trust caveat (same as the `trustProxy` note in app.ts): the Cloud
  // Run origin has public ingress and no GCLB, so a request bypassing
  // Cloudflare can forge `cf-connecting-ip` too — accepted soft-cap risk
  // today; re-verify this precedence when a GCLB is introduced.
  //
  // Verified against the installed better-auth 1.6.9 dist
  // (utils/get-request-ip.mjs): headers are tried IN ORDER; per header the
  // leftmost comma-separated entry must pass `isValidIP`, else the whole
  // header is skipped and the next one is tried.
  advanced: {
    ipAddress: {
      ipAddressHeaders: [...CLIENT_IP_HEADER_PRECEDENCE],
    },
    // Only broaden the session cookie to a shared parent domain when
    // SESSION_COOKIE_DOMAIN is set AND validates. Both deployed prod and
    // deployed dev set it to `.ithasfire.com` (dev additionally sets a distinct
    // SESSION_COOKIE_PREFIX below so the two don't clobber). Only LOCALHOST
    // leaves it unset → this is null and we omit the key entirely, keeping
    // Better Auth's default host-only cookie (a `Domain=localhost` would break
    // local dev).
    ...(crossSubDomainCookieDomain
      ? {
          crossSubDomainCookies: {
            enabled: true,
            domain: crossSubDomainCookieDomain,
          },
        }
      : {}),
    // Dev-only: rename the cookie so dev + prod never clobber each other on the
    // SHARED `.ithasfire.com` domain. Dev enables crossSubDomainCookies (above)
    // to fix the web-dev/api-dev cross-host session read, but dev + prod share
    // the `ithasfire.com` registrable parent — a same-named `.ithasfire.com`
    // cookie would collide across envs. SESSION_COOKIE_PREFIX (e.g.
    // `better-auth-dev`) gives dev a distinct name. Only spread when SET, so
    // prod (unset) keeps Better Auth's default `better-auth` prefix untouched —
    // a prefix change on prod would rename+invalidate every live session cookie.
    ...(env.SESSION_COOKIE_PREFIX
      ? { cookiePrefix: env.SESSION_COOKIE_PREFIX }
      : {}),
  },

  // Persist Better Auth state (users/accounts/sessions/verifications) in our Prisma DB.
  database: prismaAdapter(prisma, { provider: "postgresql" }),

  // Match our existing Prisma model names.
  //
  // `changeEmail` is enabled in "unverified-only" mode (no confirmation
  // flow): an unverified buyer who typo'd their email at sign-up can fix
  // it from the verify-email card and immediately get a new OTP to the
  // corrected address. Verified users cannot change their email through
  // this path — that flow would need the full sendChangeEmailConfirmation
  // round-trip which we don't have UX for yet.
  user: {
    modelName: "AuthUser",
    changeEmail: {
      enabled: true,
      updateEmailWithoutVerification: true,
    },
  },
  account: {
    modelName: "AuthAccount",
    accountLinking: {
      enabled: true,
      updateUserInfoOnLink: true,
      // Google and Apple both verify emails before returning them, so it's
      // safe to auto-link even when the existing AuthUser has
      // emailVerified = false (shadow profiles created by ensureGuestHuman).
      // Without this, OAuth sign-in for a shadow user's email would fail
      // because Better Auth requires emailVerified = true for linking.
      trustedProviders: ["google", "apple"],
    },
  },
  session: { modelName: "AuthSession" },
  verification: { modelName: "AuthVerification" },

  // NOTE: Better Auth's experimental joins currently assumes certain relation
  // field naming conventions (e.g. selecting `authaccounts`) that don't match
  // our Prisma model field names (we use `accounts`). This caused runtime 500s
  // during sign-in/sign-up.
  //
  // Disable joins for now; we can re-enable once we align schema naming or
  // Better Auth supports configuring the relation field names.
  experimental: { joins: false },

  emailVerification: {
    afterEmailVerification: async (updatedUser) => {
      await clearEmailDeliveryStatusAfterVerification(
        {
          deliverability: createPrismaEmailDeliverabilityAdapter(prisma),
          logger: createPinoLoggerAdapter(),
        },
        updatedUser as { id?: string; email?: string | null },
      );
    },
  },

  emailAndPassword: {
    enabled: true,
    // Sign-in is NOT gated on email verification. Buyers can browse and
    // create orders while unverified — but checkout itself blocks until
    // the email is verified (see Checkout.tsx `onEmailVerificationRequired`),
    // because the ticket QR code is delivered via that email. This avoids
    // the dead-end where a buyer who skipped verification at sign-up can't
    // get back into their account at all.
    requireEmailVerification: false,

    // ── Password reset ────────────────────────────────────────────────
    // Better Auth generates a token + URL; we rewrite to the web app's
    // /reset-password page and send via our SMTP mailer.
    sendResetPassword: async ({ user, url, token }) => {
      const deps = createAuthDeps();
      const mailerDiagnostics = summarizeAuthMailerDiagnostics({
        resendApiKey: env.RESEND_API_KEY,
        defaultFromEmail: env.SMTP_DEFAULT_FROM_EMAIL,
        smtpHost: env.SMTP_HOST,
        smtpPort: env.SMTP_PORT,
        smtpSecure: env.SMTP_SECURE,
        smtpUsername: env.SMTP_USERNAME,
        smtpPassword: env.SMTP_PASSWORD,
        appHeaderValue: env.SMTP_APP_HEADER,
        plainSmtp:
          process.env.PLAYWRIGHT_E2E === "1" || env.SMTP_SECURE === false,
      });

      const webBaseUrl = (
        env.PUBLIC_WEB_URL ?? "http://localhost:3000"
      ).replace(/\/+$/, "");
      const resetUrl = `${webBaseUrl}/reset-password?token=${encodeURIComponent(token)}`;
      const rewrittenResetUrl = summarizeResetUrlForLog(resetUrl);
      const maskedRecipientEmail = maskEmail(user.email);

      if (!deps.mailer) {
        deps.logger.warn("auth_reset_password_send_skipped", {
          reason: "mailer_not_configured",
          authUserId: user.id,
          mailerConfigured: mailerDiagnostics.mailerConfigured,
          providerPath: mailerDiagnostics.providerPath,
          configPresence: mailerDiagnostics.configPresence,
          pathReadiness: mailerDiagnostics.pathReadiness,
          rewrittenResetUrl,
        });
        return;
      }

      try {
        deps.logger.info("auth_reset_password_send", {
          userId: user.id,
          maskedEmail: maskedRecipientEmail,
          mailerConfigured: mailerDiagnostics.mailerConfigured,
          providerPath: mailerDiagnostics.providerPath,
          configPresence: mailerDiagnostics.configPresence,
          pathReadiness: mailerDiagnostics.pathReadiness,
          rewrittenResetUrl,
          betterAuthResetUrl: summarizeResetUrlForLog(url),
        });
        const sendOutput = await deps.mailer.send({
          to: { to: user.email },
          template: {
            key: "auth.reset_password_link",
            variables: {
              productName: deps.productName,
              resetUrl,
              expiresMinutes: 60,
            },
          },
        });
        deps.logger.info("auth_reset_password_send_completed", {
          authUserId: user.id,
          providerPath: mailerDiagnostics.providerPath,
          sendResult: {
            success: sendOutput.result.success,
            id: sendOutput.result.id ?? null,
            message: sendOutput.result.errorMessage ?? null,
            errorCode: sendOutput.result.errorCode ?? null,
            idempotentReplay: sendOutput.result.idempotentReplay ?? false,
          },
        });
      } catch (error) {
        const safeError = summarizeErrorForLog(error);
        void logAndAlert({
          logger: deps.logger,
          level: "error",
          message: "auth_reset_password_send_failed",
          extra: {
            authUserId: user.id,
            maskedEmail: maskedRecipientEmail,
            providerPath: mailerDiagnostics.providerPath,
            configPresence: mailerDiagnostics.configPresence,
            pathReadiness: mailerDiagnostics.pathReadiness,
            rewrittenResetUrl,
            error: safeError,
          },
          alert: {
            send: fireDiscordAlert,
            payload: {
              title: "Password reset email FAILED to send",
              colour: "error",
              description:
                "Mailer delivery failed for a password reset email. Check structured logs for the auth user and provider diagnostics.",
              fields: [
                {
                  name: "Email",
                  value: maskedRecipientEmail ?? "(unavailable)",
                  inline: true,
                },
                { name: "Auth ID", value: user.id, inline: true },
                {
                  name: "Error Code",
                  value: safeError.code ?? "unknown",
                  inline: true,
                },
              ],
            },
          },
        });
      }
    },
    resetPasswordTokenExpiresIn: 3600, // 1 hour

    // ── Shadow profile upgrade ─────────────────────────────────────────
    // When a guest checkout (or future volunteer signup, comp ticket claim,
    // etc.) creates a shadow AuthUser via `ensureGuestHuman`, that user has
    // an AuthUser row (email, emailVerified=false) but NO AuthAccount. If
    // they later try to sign up with email/password, Better Auth finds the
    // existing email and fires this callback instead of creating a new user.
    //
    // See `shadow-upgrade.ts` for the full logic and unit tests.
    onExistingUserSignUp: async ({ user: rawUser }, request) => {
      const logger = createPinoLoggerAdapter();
      const user = rawUser as {
        id: string;
        email: string;
        name?: string;
        humanId?: string;
      };

      await handleShadowUpgrade(
        {
          logger,
          findCredentialAccount: (userId) =>
            prisma.authAccount.findUnique({
              where: {
                providerId_accountId: {
                  providerId: "credential",
                  accountId: userId,
                },
              },
              select: { id: true },
            }),
          hashPassword,
          createCredentialAccount: async (userId, hashedPassword) => {
            await prisma.authAccount.create({
              data: {
                providerId: "credential",
                accountId: userId,
                userId: userId,
                password: hashedPassword,
              },
            });
          },
          updateAuthUserName: async (userId, name) => {
            await prisma.authUser.update({
              where: { id: userId },
              data: { name },
            });
          },
          updateHumanName: async (humanId, name) => {
            await prisma.human.update({
              where: { id: humanId },
              data: { name },
            });
          },
          sendVerificationEmail: async (email) => {
            // Email verification is OTP-based (see emailOTP plugin). The
            // legacy link sender (auth.api.sendVerificationEmail) is not
            // configured and throws VERIFICATION_EMAIL_NOT_ENABLED.
            await auth.api.sendVerificationOTP({
              body: { email, type: "email-verification" },
            });
          },
        },
        user,
        request,
      );
    },
  },

  // Social/OAuth providers for Google and Apple Sign In.
  // Providers are only enabled if their env vars are set.
  socialProviders: {
    ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? {
          google: {
            clientId: env.GOOGLE_CLIENT_ID,
            clientSecret: env.GOOGLE_CLIENT_SECRET,
            // The redirect URI registered with Google must point to the
            // API origin so the oAuthProxy plugin can intercept the callback
            // and forward the user to the web app.
            redirectURI: `${env.BETTER_AUTH_BASE_URL ?? env.APP_BASE_URL}/api/auth/callback/google`,
            verifyIdToken: verifyGoogleIdToken,
            // Map Google profile to our AuthUser fields
            mapProfileToUser: (profile) => ({
              name:
                profile.name ??
                `${profile.given_name ?? ""} ${profile.family_name ?? ""}`.trim(),
              image: profile.picture,
            }),
          },
        }
      : {}),
    ...(env.APPLE_CLIENT_ID && env.APPLE_CLIENT_SECRET
      ? {
          apple: {
            clientId: env.APPLE_CLIENT_ID,
            clientSecret: env.APPLE_CLIENT_SECRET,
            // The redirect URI registered with Apple must point to the
            // production/canonical API origin so the oAuthProxy plugin can
            // intercept the callback and forward to the requesting web app.
            redirectURI: `${env.BETTER_AUTH_BASE_URL ?? env.APP_BASE_URL}/api/auth/callback/apple`,
            // iOS native sign-in requires bundle identifier
            ...(env.APPLE_APP_BUNDLE_IDENTIFIER
              ? { appBundleIdentifier: env.APPLE_APP_BUNDLE_IDENTIFIER }
              : {}),
            verifyIdToken: verifyAppleIdToken,
            // Apple only provides name on first auth; we capture it here
            // Apple profile structure: { sub, email, name?: { firstName, lastName } }
            mapProfileToUser: (profile: {
              name?: string | { firstName?: string; lastName?: string };
            }) => {
              let name = "";
              if (typeof profile.name === "string") {
                name = profile.name;
              } else if (profile.name && typeof profile.name === "object") {
                const first = profile.name.firstName ?? "";
                const last = profile.name.lastName ?? "";
                name = `${first} ${last}`.trim();
              }
              return {
                name: name || undefined,
                image: undefined,
              };
            },
          },
        }
      : {}),
  },

  // Hooks that used to live in the web app now run inside the API auth server.
  //
  // NOTE: These hooks are intentionally defensive. If downstream services (e.g. mailer)
  // are not configured, we log and continue so auth itself still works.
  databaseHooks: {
    user: {
      create: {
        after: async (rawUser) => {
          const authUser = rawUser as {
            id?: string;
            email?: string;
            name?: string;
            image?: string;
          };
          const authUserId = authUser?.id;
          const email = authUser?.email;
          if (!authUserId || !email) {
            return;
          }

          // Minimal deps for the provisioning use case.
          const logger = createPinoLoggerAdapter();
          const clock = createSystemClock();
          const reposBase = createPrismaRepos(prisma);
          const repos = withGuardedRepos(
            reposBase,
            logger,
            provisionGuardConfig(),
          );

          // Try to extract locale from the Google OAuth ID token.
          let locale: string | undefined;
          try {
            const account = await prisma.authAccount.findFirst({
              where: { userId: authUserId, providerId: "google" },
              select: { idToken: true },
            });
            if (account?.idToken) {
              const payload = JSON.parse(
                Buffer.from(
                  account.idToken.split(".")[1]!,
                  "base64url",
                ).toString(),
              );
              if (typeof payload.locale === "string") {
                locale = payload.locale;
              }
            }
          } catch {
            // Non-critical; proceed without locale.
          }

          // Provision the domain Human + EntityPage and link
          // AuthUser.humanId. This after-hook runs POST-commit (the auth_user
          // row is already persisted), so a provisioning failure would leave
          // an orphan with humanId = null ("email taken but unusable"). The
          // rollback handler compensates by deleting the unprovisioned row and
          // re-throwing so the signup aborts cleanly and the email frees up.
          // See `provision-recovery.ts` for the better-auth 1.6.9 after-hook
          // throw-propagation analysis and the unit tests.
          //
          // Note: `search` is not passed here — constructing a MultiSearchPort
          // would duplicate the env-aware wiring in apps/api/src/lib/dep.ts.
          // New humans are reconciled by the nightly `search.full-reindex`
          // cron, which is acceptable for the signup path (low frequency, low
          // staleness sensitivity).
          await handleProvisioningWithRollback(
            {
              logger,
              maskEmail,
              alert: fireDiscordAlert,
              deleteUnprovisionedAuthUser: async (id) => {
                // Guard on humanId = null so a row linked in a race is never
                // destroyed. account/session/passkey/2fa cascade via FK
                // onDelete: Cascade (see auth.prisma).
                const { count } = await prisma.authUser.deleteMany({
                  where: deleteUnprovisionedAuthUserWhere(id),
                });
                return count;
              },
              provision: async (provisionInput) => {
                const result = await provisionHumanForAuthUser(
                  { repos, clock, logger },
                  {
                    actorSystem: "service",
                    authUserId: provisionInput.authUserId,
                    email: provisionInput.email,
                    name: provisionInput.name,
                    // Pass OAuth image to sync to Profile.avatarUrl
                    image: provisionInput.image,
                    locale: provisionInput.locale,
                    clientKey: "better-auth:user.create",
                  },
                );
                return { humanId: result.humanId };
              },
            },
            {
              authUserId,
              email,
              name: authUser.name ?? undefined,
              image: authUser.image ?? undefined,
              locale,
            },
          );

          const maskedEmail = maskEmail(email);
          const hasDisplayName = Boolean(authUser.name?.trim());

          logAuthUserSignedUp({
            logger,
            authUserId,
            maskedEmail,
            hasDisplayName,
          });
        },
      },
      update: {
        after: async (rawUser) => {
          // Sync profile avatar whenever Better Auth updates the user record
          // (e.g. subsequent OAuth sign-ins that refresh the image URL).
          const authUser = rawUser as {
            id?: string;
            email?: string;
            name?: string;
            image?: string;
            humanId?: string;
          };
          const image = authUser?.image;
          const humanId = authUser?.humanId;
          if (!image || !humanId) return;

          const logger = createPinoLoggerAdapter();
          try {
            const reposBase = createPrismaRepos(prisma);
            const page = await reposBase.entityPages.getByOwner(
              "HUMAN",
              humanId,
            );
            if (page && page.avatarUrl !== image) {
              await reposBase.entityPages.upsert({
                ownerType: "HUMAN",
                ownerId: humanId,
                slug: page.slug,
                displayName: page.displayName,
                avatarUrl: image,
              });
              logger.info("auth_user_update_synced_avatar", { humanId, image });
            }
          } catch (error) {
            logger.warn("auth_user_update_avatar_sync_failed", {
              humanId,
              error,
            });
          }
        },
      },
    },
  },

  // Email verification now goes through the `emailOTP` plugin below.
  // It sends a 6-digit code instead of a link, avoiding scanner prefetch.

  plugins: [
    jwt(),
    // Accept session tokens via `Authorization: Bearer <token>`. Mobile
    // clients can't read Set-Cookie headers (RN fetch limitation), so the
    // scanner caches the session token from sign-in's response body and
    // sends it as a Bearer header to mint JWTs via /api/auth/token.
    bearer(),
    // Username plugin for username-based login (schema fields already exist)
    username(),
    // Replaces link verification with a 6-digit code typed into the
    // verify-email card. `sendVerificationOnSignUp` sends it immediately
    // after sign-up, so the client does not need an extra call.
    emailOTP({
      // Email codes SIGN IN existing users; they never CREATE one.
      //
      // Without this, `/sign-in/email-otp` calls `createUser({emailVerified:
      // true})` for an unrecognised address (better-auth
      // dist/plugins/email-otp/routes.mjs:404-419) — so typing any address
      // into the email-code box and entering the mailed code silently mints a
      // verified account from the SIGN-IN surface. Account creation belongs to
      // the sign-up flow, which has its own consent and copy.
      //
      // This does NOT weaken the account-existence symmetry the sign-in UI
      // relies on: with the flag set, an unknown address still gets
      // `{success:true}` from send (routes.mjs:99-103, which deletes the
      // verification and skips the mail), and verify fails with the same
      // INVALID_OTP a wrong code returns (routes.mjs:404). Unknown and known
      // remain indistinguishable to the client.
      //
      // Only `type: "sign-in"` is affected — sign-up's own verification mail
      // (`sendVerificationOnSignUp`) and the change-email flow are untouched.
      disableSignUp: true,
      sendVerificationOnSignUp: true,
      changeEmail: {
        enabled: true,
        verifyCurrentEmail: false,
      },
      expiresIn: 60 * 10,
      sendVerificationOTP: async ({ email, otp, type }) => {
        const deps = createAuthDeps();
        const maskedRecipientEmail = maskEmail(email);

        if (!deps.mailer) {
          deps.logger.warn("auth_email_otp_send_skipped", {
            reason: "mailer_not_configured",
            maskedEmail: maskedRecipientEmail,
            type,
          });
          if (type === "change-email") {
            throw new Error("Could not send verification code.");
          }
          return;
        }

        try {
          deps.logger.info("auth_email_otp_send", {
            maskedEmail: maskedRecipientEmail,
            type,
          });
          const sendOutput = await deps.mailer.send({
            to: { to: email },
            subject: `Your ${deps.productName} verification code`,
            template: {
              key: "auth.verification_code",
              variables: {
                code: otp,
                expiresMinutes: 10,
                productName: deps.productName,
              },
            },
            tags: ["auth", "verification", `email-otp-${type}`],
          });

          if (!sendOutput.result.success) {
            deps.logger.warn("auth_email_otp_send_unsuccessful", {
              maskedEmail: maskedRecipientEmail,
              type,
              errorCode: sendOutput.result.errorCode ?? null,
              errorMessage: sendOutput.result.errorMessage ?? null,
            });
            if (type === "change-email") {
              throw new Error("Could not send verification code.");
            }
            return;
          }

          logAuthVerificationEmailSent({
            logger: deps.logger,
            authUserId: null,
            maskedEmail: maskedRecipientEmail,
          });
        } catch (error) {
          deps.logger.warn("auth_email_otp_send_failed", {
            maskedEmail: maskedRecipientEmail,
            type,
            error,
          });
          if (type === "change-email") {
            throw new Error("Could not send verification code.");
          }
        }
      },
    }),
    // WebAuthn / passkey support. The plugin's auto-derivation reads
    // `baseURL` (= the API origin) which is the WRONG relying party for
    // us — passkeys are bound to the WEB origin. Pin it explicitly so
    // credentials created on ithasfire.com work everywhere.
    passkey({
      rpName: env.PRODUCT_NAME,
      rpID: (() => {
        try {
          return new URL(env.PUBLIC_WEB_URL).hostname;
        } catch {
          return "localhost";
        }
      })(),
      origin: env.PUBLIC_WEB_URL,
    }),
    magicLink({
      expiresIn: 60 * 15,
      sendMagicLink: async ({ email, url }) => {
        const deps = createAuthDeps();
        const maskedRecipientEmail = maskEmail(email);

        if (!deps.mailer) {
          deps.logger.warn("auth_magic_link_send_skipped", {
            reason: "mailer_not_configured",
            maskedEmail: maskedRecipientEmail,
          });
          return;
        }

        try {
          deps.logger.info("auth_magic_link_send", {
            maskedEmail: maskedRecipientEmail,
          });

          await deps.mailer.send({
            to: { to: email },
            subject: `Sign in to ${deps.productName} scanner`,
            text: [
              `Sign in to ${deps.productName} scanner.`,
              "Open this link on the same phone where the scanner app is installed:",
              url,
            ].join("\n\n"),
            html: buildMagicLinkEmailHtml({
              productName: deps.productName,
              url,
            }),
          });

          deps.logger.info("auth_magic_link_send_completed", {
            maskedEmail: maskedRecipientEmail,
          });
        } catch (error) {
          deps.logger.warn("auth_magic_link_send_failed", {
            maskedEmail: maskedRecipientEmail,
            error: summarizeErrorForLog(error),
          });
        }
      },
    }),
    // OAuth proxy enables cross-origin OAuth callbacks. The web app (port 3000 /
    // production web domain) and the API (port 3001 / production API domain) live
    // on different origins. Without this plugin Apple Sign In (which uses
    // response_mode=form_post) cannot redirect the user back to the web app
    // after the callback POST hits the API.
    oAuthProxy({
      // In production, PUBLIC_WEB_URL is the canonical web origin.
      // In dev, it defaults to http://localhost:3000.
      productionURL: env.PUBLIC_WEB_URL,
      currentURL: env.BETTER_AUTH_BASE_URL ?? env.APP_BASE_URL,
    }),
    phoneNumber({
      sendOTP: async ({ phoneNumber: phoneNumberValue, code }) => {
        const deps = createAuthDeps();
        const sender = createPhoneOtpSender({
          sms: deps.sms ?? undefined,
          mailer: deps.mailer!,
          logger: deps.logger,
          productName: deps.productName,
        });
        await sender({ phoneNumber: phoneNumberValue, code });
      },
      // Durable SMS consent (sms-opt-out-sns FR-003): completing phone OTP
      // verification is the user's affirmative opt-in, so mirror it into the
      // phone-consent ledger. Best-effort — verification must never fail
      // because the ledger write did (recordSmsOptIn is idempotent, and a
      // later STOP reply still wins via the send-side consent gate).
      callbackOnVerification: async ({ phoneNumber: verifiedPhoneNumber }) => {
        const logger = createPinoLoggerAdapter().child({
          hook: "phoneNumber.callbackOnVerification",
        });
        try {
          const repos = withGuardedRepos(createPrismaRepos(prisma), logger);
          await recordSmsOptIn(
            { repos, clock: createSystemClock(), logger },
            {
              phoneNumber: verifiedPhoneNumber,
              source: "phone_verification",
            },
          );
        } catch (error) {
          logger.warn("phone_verification_sms_opt_in_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    }),
    // Two-factor authentication with TOTP and OTP fallback
    twoFactor({
      issuer: env.PRODUCT_NAME,
      otpOptions: {
        async sendOTP({ user, otp }, ctx) {
          const deps = createAuthDeps();
          const sender = createTwoFactorOtpSender({
            sms: deps.sms ?? undefined,
            mailer: deps.mailer!,
            logger: deps.logger,
            productName: deps.productName,
          });
          await sender({ user: user as any, otp }, ctx);
        },
      },
      // Map our Prisma column names (snake_case mapped via @map) to Better Auth's expectations
      schema: {
        twoFactor: {
          modelName: "AuthTwoFactor",
        },
        user: {
          fields: {
            twoFactorEnabled: "twoFactorEnabled",
          },
        },
      },
    }),
    customSession(async ({ user, session }) => {
      const authUser = user as unknown as {
        id?: string;
        email?: string | null;
        name?: string | null;
        humanId?: string;
        twoFactorEnabled?: boolean;
        emailDeliveryStatus?: "BOUNCED" | "COMPLAINED" | null;
        emailDeliveryStatusAt?: Date | string | null;
        emailDeliveryStatusRef?: string | null;
      };

      // Self-heal: if this user has no linked Human (orphaned by an old
      // provisioning failure, or an edge case the rollback missed), re-run
      // the idempotent provisioning use case and use the resulting humanId.
      // Cheap — only runs while humanId is null; NEVER throws out of here.
      let humanId: string | null = authUser.humanId ?? null;
      if (!humanId && authUser.id) {
        const logger = createPinoLoggerAdapter();
        const reposBase = createPrismaRepos(prisma);
        const repos = withGuardedRepos(
          reposBase,
          logger,
          provisionGuardConfig(),
        );
        humanId = await resolveHumanIdWithSelfHeal(
          {
            logger,
            provision: async (provisionInput) => {
              const result = await provisionHumanForAuthUser(
                { repos, clock: createSystemClock(), logger },
                {
                  actorSystem: "service",
                  authUserId: provisionInput.authUserId,
                  email: provisionInput.email,
                  name: provisionInput.name,
                  clientKey: "better-auth:customSession.self-heal",
                },
              );
              return { humanId: result.humanId };
            },
          },
          {
            id: authUser.id,
            email: authUser.email ?? null,
            name: authUser.name ?? null,
            humanId: authUser.humanId ?? null,
          },
        );
      }

      return {
        user: {
          ...user,
          humanId,
          twoFactorEnabled: authUser.twoFactorEnabled ?? false,
          emailDeliveryStatus: authUser.emailDeliveryStatus ?? null,
          emailDeliveryStatusAt: authUser.emailDeliveryStatusAt ?? null,
          emailDeliveryStatusRef: authUser.emailDeliveryStatusRef ?? null,
        },
        session,
      };
    }),
  ],

  // When the magic-link verify endpoint redirects to a non-HTTP scheme (e.g.
  // `ithasfire-scanner://auth-callback` for the mobile dev client), append
  // the freshly minted session token as a `?token=` query param. Browsers
  // strip HTTP headers (including the `set-auth-token` header better-auth
  // sets on the 302) when handing off to a deep-link target, so the app on
  // the other side has no way to recover the session. The query param is
  // the only channel that survives the browser→app jump.
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      // ── An email code must never stand in for a second factor ──────────
      //
      // The twoFactor plugin hooks sign-in by an explicit path allowlist:
      // `/sign-in/email`, `/sign-in/username`, `/sign-in/phone-number`
      // (better-auth dist/plugins/two-factor/index.mjs:192). `/sign-in/
      // email-otp` is NOT in it, so for an account with `twoFactorEnabled`
      // the OTP route returns a FULL session and the TOTP challenge is never
      // raised. Whoever controls the inbox controls the account — which is
      // exactly what enabling 2FA was meant to prevent, and it defeats the
      // staff gate too, since `checkStaffAccess` tests whether a second
      // factor is ENROLLED, not whether this session passed one.
      //
      // Refuse instead of trying to chain into the challenge: the people this
      // route exists for (guest-checkout buyers reaching /my-tickets) never
      // have 2FA, and anyone who does has a working primary method already.
      // Revisit only by wiring OTP into the real 2FA flow — never by deleting
      // this and assuming the plugin covers it.
      if (ctx.path === "/sign-in/email-otp") {
        const email =
          typeof (ctx.body as { email?: unknown } | undefined)?.email ===
          "string"
            ? ((ctx.body as { email: string }).email satisfies string)
            : null;
        if (email) {
          const found = (await ctx.context.internalAdapter.findUserByEmail(
            email,
          )) as { user?: { twoFactorEnabled?: boolean | null } } | null;
          if (found?.user?.twoFactorEnabled) {
            throw new APIError("BAD_REQUEST", {
              code: "TWO_FACTOR_ACCOUNT_USE_PRIMARY_SIGN_IN",
              message:
                "This account uses two-factor authentication. Sign in with your password or passkey.",
            });
          }
        }
      }
      if (ctx.path === "/email-otp/request-email-change") {
        throw new APIError("BAD_REQUEST", {
          code: "USE_ACCOUNT_EMAIL_CHANGE_REQUEST",
          message: "Use the account email change request endpoint.",
        });
      }
    }),
    after: createAuthMiddleware(async (ctx) => {
      // ── Kill the host-only shadow session cookie ──────────────────────
      // Better Auth's cookie writer re-serializes from the CURRENT config,
      // so on prod it only ever addresses the `Domain=.ithasfire.com`
      // entry. Sessions minted before SESSION_COOKIE_DOMAIN shipped are
      // carried by a host-only cookie of the SAME NAME, which RFC 6265
      // treats as a distinct jar entry — it survives everything Better Auth
      // writes and keeps the user wedged (visible to `api.ithasfire.com`,
      // invisible to the apex, so every server-side gate fails closed while
      // the client thinks it is signed in).
      //
      // The trigger is deliberately "this response already writes the
      // session-token cookie", NOT a list of paths: `/sign-in` is
      // passkey-first here, so a `/sign-out`-only (or even
      // `/sign-out` + `/sign-in/email`) gate never runs for most users and
      // the ghost survives their next sign-in. One predicate covers
      // sign-out, password sign-in, passkey verify, OAuth callback,
      // magic-link verify and 2FA verify, with nothing to keep in sync.
      //
      // `ctx.setCookie` APPENDS to this middleware's own response headers,
      // which `runAfterHooks` merges into the response with `append` for
      // `set-cookie` — Better Auth's own cookies are preserved and both
      // entries land. Proven at runtime, not inferred:
      // `test/host-only-session-cookie-wire.test.ts`.
      for (const name of hostOnlySessionCookiesToClearForResponse({
        path: ctx.path,
        responseHeaders: ctx.context.responseHeaders,
        crossSubDomainCookieDomain,
        sessionTokenName: ctx.context.authCookies.sessionToken.name,
        // Optional-chained on purpose: this hook now runs on EVERY endpoint,
        // and a throw here would 500 the request. `sessionData` is always
        // present today, but the empty name is filtered out downstream, so
        // the degraded behaviour is "emit nothing" rather than "sign-out
        // 500s".
        sessionDataName: ctx.context.authCookies.sessionData?.name ?? "",
        cookieCacheEnabled: Boolean(
          ctx.context.options.session?.cookieCache?.enabled,
        ),
      })) {
        ctx.setCookie(name, "", HOST_ONLY_CLEAR_COOKIE_ATTRIBUTES);
      }

      // ── Magic-link → deep-link token relay ────────────────────────────
      // When the magic-link verify endpoint redirects to a non-HTTP scheme
      // (e.g. `ithasfire-scanner://auth-callback` for the mobile dev
      // client), append the freshly minted session token as `?token=`.
      // Browsers strip HTTP headers when handing off to a deep-link target,
      // so the query param is the only channel that survives the
      // browser → app jump.
      if (ctx.path?.startsWith("/magic-link/verify")) {
        const headers = ctx.context.responseHeaders;
        const location = headers?.get("location");
        if (headers && location && !/^https?:/i.test(location)) {
          // `set-auth-token` is added by the bearer() plugin's after hook,
          // which hasn't run yet at this point. Parse the session token
          // out of `set-cookie` directly (same source bearer reads from).
          const setCookie = headers.get("set-cookie");
          if (setCookie) {
            const cookieName = ctx.context.authCookies.sessionToken.name;
            // `Set-Cookie` may contain multiple cookies separated by ", "
            // in non-attribute positions; a tolerant `name=value`
            // extraction suffices for the session token.
            const match = new RegExp(
              `(?:^|[,;]\\s*)${cookieName}=([^;,]+)`,
            ).exec(setCookie);
            if (match?.[1]) {
              const token = decodeURIComponent(match[1]);
              const sep = location.includes("?") ? "&" : "?";
              headers.set(
                "location",
                `${location}${sep}token=${encodeURIComponent(token)}`,
              );
            }
          }
        }
      }

      // ── Enrich EMAIL_NOT_VERIFIED with the account's email ────────────
      // Better Auth's sign-in throws `EMAIL_NOT_VERIFIED` (HTTP 403) with
      // just a code + message. The client needs the email to open the
      // verify-email panel and request a fresh OTP. Re-fetch the user
      // here and attach `email` to the error body so the client can
      // route in a single round-trip — no separate resolver endpoint.
      //
      // Safe because the sign-in endpoint ALREADY validated the password
      // before throwing this error; we're only echoing back data the
      // caller proved they have credentials for.
      if (
        ctx.path === "/sign-in/email" ||
        ctx.path === "/sign-in/username"
      ) {
        const returned = ctx.context.returned;
        if (
          returned instanceof APIError &&
          (returned.body as { code?: string } | undefined)?.code ===
            "EMAIL_NOT_VERIFIED"
        ) {
          const body = ctx.body as
            | { email?: string; username?: string }
            | undefined;
          const lookup =
            ctx.path === "/sign-in/email" && typeof body?.email === "string"
              ? prisma.authUser.findUnique({
                  where: { email: body.email.toLowerCase() },
                  select: { email: true },
                })
              : typeof body?.username === "string"
                ? prisma.authUser.findFirst({
                    where: { username: body.username.toLowerCase() },
                    select: { email: true },
                  })
                : null;
          const user = lookup ? await lookup.catch(() => null) : null;
          if (user?.email) {
            const message =
              (returned.body as { message?: string } | undefined)?.message ??
              "Email not verified";
            throw new APIError("FORBIDDEN", {
              code: "EMAIL_NOT_VERIFIED",
              message,
              email: user.email,
            });
          }
        }
      }
    }),
  },
});
