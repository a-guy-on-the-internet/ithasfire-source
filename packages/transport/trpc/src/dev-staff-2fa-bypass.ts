/**
 * DEV-ONLY escape hatch for the staff second-factor requirement.
 *
 * WHY THIS EXISTS
 * A platform staff role counts only with an enrolled second factor (passkey
 * or TOTP). The authz adapter enforces that inside `hasStaffRole`, and
 * `requireStaffSecondFactor` in `guard.ts` raises the same refusal early on
 * the `/platform` and `/moderate` paths. That makes every staff surface
 * impossible to open in local dev without enrolling a real authenticator
 * against the seeded admin, which in turn makes UI work on `PlatformShell`
 * untestable in a browser.
 *
 * WHERE IT CAN BE ON
 * `resolveStaffSecondFactorBypass` is an allowlist. It returns `true` only
 * when all three hold:
 *   - Neither `K_SERVICE` nor `CLOUD_RUN_JOB` is set. Cloud Run injects
 *     `K_SERVICE` into every service revision (the same signal
 *     `shouldBlockOnDrift` in `packages/adapters/src/infra/migration-drift.ts`
 *     reads) and `CLOUD_RUN_JOB` into every job execution, so a deployed
 *     process is off whatever its `NODE_ENV` says.
 *   - `NODE_ENV` is unset, empty, or exactly `development` or `test`. Unset
 *     counts as local: the local API (`pnpm -F api dev`) and the e2e job run
 *     without one, and vitest sets `test`. Any other value (`production`,
 *     `Production`, `prod`, `staging`, `dev`, `DEVELOPMENT`, ...) is off. The
 *     deployed images set `NODE_ENV=production`, so a deployed process is
 *     refused on this condition as well as the first.
 *   - `DEV_BYPASS_STAFF_2FA` is `true` or `1`.
 * Setting the flag where it is refused is reported to stderr at module load,
 * naming the condition that failed, so the misconfiguration is visible in
 * logs rather than silently ignored.
 *
 * SCOPE
 * When enabled it makes staff accounts read as "second factor enrolled" at
 * every place that consults enrollment: the authz adapter (the composition
 * root passes this value as `staffSecondFactorBypass`; the early check in
 * `guard.ts` asks that adapter), and the two read-only access probes the
 * client shells redirect on (`platform.checkStaffAccess`,
 * `community.checkModeratorAccess`), which read it for the
 * `secondFactorEnrolled` field they return. It does NOT grant any role: a
 * non-staff actor is still rejected by each procedure's own role check,
 * exactly as before.
 *
 * Grep `staffSecondFactorBypassEnabled` to find every site it affects.
 */

type BypassEnv = {
  NODE_ENV?: string | undefined;
  DEV_BYPASS_STAFF_2FA?: string | undefined;
  K_SERVICE?: string | undefined;
  CLOUD_RUN_JOB?: string | undefined;
};

/**
 * The only `NODE_ENV` values the bypass may be on under. The empty string
 * stands for an unset (or empty) `NODE_ENV`, which counts as local.
 */
const BYPASS_NODE_ENVS: readonly string[] = ["", "development", "test"];

function bypassRequested(env: BypassEnv): boolean {
  return env.DEV_BYPASS_STAFF_2FA === "true" || env.DEV_BYPASS_STAFF_2FA === "1";
}

function onCloudRun(env: BypassEnv): boolean {
  return Boolean(env.K_SERVICE || env.CLOUD_RUN_JOB);
}

function nodeEnvAllowed(env: BypassEnv): boolean {
  return BYPASS_NODE_ENVS.includes(env.NODE_ENV ?? "");
}

/**
 * `true` only off Cloud Run, with `NODE_ENV` unset, empty, or exactly
 * `development` or `test`, and `DEV_BYPASS_STAFF_2FA=true|1`. The one place
 * the decision is made; everything else reads
 * `staffSecondFactorBypassEnabled`.
 */
export function resolveStaffSecondFactorBypass(env: BypassEnv): boolean {
  if (onCloudRun(env)) return false;
  if (!nodeEnvAllowed(env)) return false;
  return bypassRequested(env);
}

/** `resolveStaffSecondFactorBypass` over the process env, read once at load. */
export const staffSecondFactorBypassEnabled: boolean =
  resolveStaffSecondFactorBypass(process.env);

if (bypassRequested(process.env) && !staffSecondFactorBypassEnabled) {
  // Loud, but non-fatal: the bypass is already off by construction above, so
  // refusing to boot would turn a harmless stray env var into an outage.
  const failed = [
    ...(onCloudRun(process.env)
      ? ["K_SERVICE or CLOUD_RUN_JOB is set (the process is on Cloud Run)"]
      : []),
    ...(nodeEnvAllowed(process.env)
      ? []
      : [
          `NODE_ENV=${process.env.NODE_ENV} is not unset, "development" or "test"`,
        ]),
  ];
  // eslint-disable-next-line no-console
  console.error(
    `[security] DEV_BYPASS_STAFF_2FA is set and is being IGNORED: ${failed.join("; ")}. ` +
      "Staff second-factor enforcement remains ON. Remove this variable from this environment.",
  );
}

if (staffSecondFactorBypassEnabled) {
  // eslint-disable-next-line no-console
  console.warn(
    `[dev] DEV_BYPASS_STAFF_2FA is ON (NODE_ENV ${process.env.NODE_ENV ? `is "${process.env.NODE_ENV}"` : "is unset"}, K_SERVICE is unset) — staff second-factor enforcement is DISABLED for every staff role check. Never use this outside local development.`,
  );
}
