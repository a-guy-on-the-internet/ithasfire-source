/**
 * The platform owner (scoped-api-keys spec R21 / R26; CONTEXT.md "Platform
 * owner"): the one identity that may approve their own STAFF key request,
 * after a fresh password or passkey check (FR-003).
 *
 * R26 (owner, 2026-10-12): "a human id constant per environment in core (dev
 * seed id, prod id), changed only by a reviewed commit". So the ids live
 * HERE, in code, and nowhere else: never in an env var, the database or a
 * UI, so no runtime config or admin screen can grant it. Changing an entry
 * is a code change that goes through review.
 *
 * Fail closed: an environment with no id (null), or a name not in the map,
 * has NO platform owner, and nobody may self-approve there.
 */

export type PlatformOwnerEnvironment = "development" | "production";

export const PLATFORM_OWNER_HUMAN_IDS: Readonly<
  Record<PlatformOwnerEnvironment, string | null>
> = Object.freeze({
  /**
   * Local dev and the dev deployment: the dev-login admin seeded by
   * `pnpm seed:dev` (`DEMO_IDS.devUser` in
   * apps/api/src/scripts/seed/ids.ts, admin@ithasfire.com).
   */
  development: "00000000-0000-4000-8000-00000000d005",
  /**
   * Production: NOT SET YET. The prod platform admin is created by
   * `pnpm seed:admin` with a random id, so the owner supplies it in a
   * reviewed commit. Until then production has no platform owner (fail
   * closed: no self-approval).
   */
  production: null,
});

/**
 * The platform owner's human id in `environment`, or null when there is none.
 * Unknown environment names resolve to null (fail closed).
 */
export function platformOwnerHumanId(environment: string): string | null {
  if (!Object.hasOwn(PLATFORM_OWNER_HUMAN_IDS, environment)) return null;
  return PLATFORM_OWNER_HUMAN_IDS[environment as PlatformOwnerEnvironment];
}

/** Whether `humanId` is the platform owner in `environment`. */
export function isPlatformOwner(
  humanId: string | null | undefined,
  environment: string,
): boolean {
  if (!humanId) return false;
  const ownerId = platformOwnerHumanId(environment);
  return ownerId !== null && ownerId === humanId;
}

/**
 * Which {@link PlatformOwnerEnvironment} this process runs in, read from
 * `SENTRY_ENVIRONMENT` ONLY. Pass the composition root's `process.env`.
 *
 * THIS VARIABLE NOW GATES SELF-APPROVAL: it picks whose human id is the
 * platform owner. Set by Terraform per workspace (`local.sentry_environment`
 * in infra/terraform/main.tf: "production" on prod, "development" on dev,
 * "staging" on stage) and locally by scripts/dev/sentry-setup.sh.
 *
 * Fail closed: unset, empty or any value other than "development" /
 * "production" (including "staging") → null → no platform owner. It never
 * falls back to NODE_ENV (both cloud deployments run NODE_ENV=production)
 * and never defaults to "development", so a prod process that lost the
 * variable cannot make the dev seed admin the owner.
 */
export function platformOwnerEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): PlatformOwnerEnvironment | null {
  const value = env.SENTRY_ENVIRONMENT?.trim();
  if (value === "development" || value === "production") return value;
  return null;
}
