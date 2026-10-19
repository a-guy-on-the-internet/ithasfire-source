/**
 * Field-level checks on one `jobs.manifest.json` `scheduled` entry, shared by
 * `validate-manifest.ts` (the pre-commit hook and deploy drift guard) and its
 * test. A leaf module with no imports, like `scheduler-overrides.ts`: the gate
 * must not fail because an unrelated import blew up.
 *
 * Why unknown keys fail: `generated-jobs.tf` reads each field through
 * `try(cfg.<field>, <default>)`, so a misspelt key (`"retries": false`) is not
 * an error anywhere; Terraform quietly applies the default. For `retry` the
 * default is ON, so the typo would turn retries back on for a job that was
 * marked unsafe to run twice at once.
 */

/** Every key a scheduled entry may carry. Add new fields here. */
export const SCHEDULED_ENTRY_KEYS: ReadonlySet<string> = new Set([
  "_comment",
  "description",
  "cron",
  "timezone",
  "enabled",
  "payload",
  "attemptDeadline",
  "triggerTopic",
  "schedulerOverriddenIn",
  "noHandler",
  /**
   * Cloud Scheduler retries a failed tick twice (30s, then 60s; at most 3
   * attempts per tick) unless this is `false`. A retry can run while the first
   * attempt is still executing, so set it to `false` on any job that is not
   * safe as two concurrent copies, and say why in `_comment`. Absent = true.
   */
  "retry",
]);

/** Returns one error message per problem; empty when the entry is fine. */
export function checkScheduledEntryFields(
  name: string,
  entry: unknown,
): string[] {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return [`Manifest scheduled entry "${name}" is not an object`];
  }
  const errors: string[] = [];
  for (const key of Object.keys(entry)) {
    if (!SCHEDULED_ENTRY_KEYS.has(key)) {
      errors.push(
        `Manifest scheduled entry "${name}" has unknown key "${key}"; ` +
          `Terraform would ignore it and apply the default. ` +
          `Known keys: ${[...SCHEDULED_ENTRY_KEYS].join(", ")}`,
      );
    }
  }
  const retry = (entry as { retry?: unknown }).retry;
  if (retry !== undefined && typeof retry !== "boolean") {
    errors.push(
      `Manifest scheduled entry "${name}" has retry ${JSON.stringify(retry)}; ` +
        `use true or false (or leave it out for the default, true)`,
    );
  }
  return errors;
}
