/**
 * R34a (owner, 2026-10-13): switching volunteer auto-approve ON is
 * session-only for every key. An auto-approved signup is APPROVED on submit
 * with nobody reviewing it, and an approved volunteer is who the comp rewards
 * are for (R33: a leaked key must not be able to give tickets away). Today
 * the submit path itself fires no ON_APPROVAL grant (only
 * `reviewVolunteerSignup` does, volunteer-signups.ts), so this guards the
 * approval-without-review, and any grant wired to it later.
 *
 * These procedures carry other settings too, so they are not denylisted
 * whole: the gate refuses a key call whose RAW input (before Zod parsing)
 * carries one of the named fields with any value other than `false`.
 *
 * Why "anything but false" rather than "true only":
 * - `false` can only turn auto-approve OFF, which grants nothing;
 * - `true` turns it on;
 * - `null` on a role clears the role's override, so the role inherits the
 *   event's `volunteerAutoApprove`, which may be on. That is switching it on
 *   for the role, so it is refused too;
 * - an absent (or `undefined`) field leaves the setting as a session set it.
 *
 * NFR-002 (procedure-tags.test.ts) fails when a path here no longer exists or
 * stops accepting the field, so the map cannot go stale silently.
 */
export const KEY_GUARDED_INPUT_FIELDS: Readonly<
  Record<string, readonly string[]>
> = {
  // The event-level default every role without its own setting inherits.
  "events.updateSettings": ["volunteerAutoApprove"],
  // Role-level override (`role.autoApprove ?? event.volunteerAutoApprove`).
  "volunteer.roles.create": ["autoApprove"],
  "volunteer.roles.update": ["autoApprove"],
  // Generic asks (`role.autoApprove ?? ask.autoApprove`).
  "volunteer.asks.create": ["autoApprove"],
  "volunteer.asks.update": ["autoApprove"],
};

/**
 * The guarded fields a key call to `path` may not send: present in `rawInput`
 * with a value other than `false`. Empty when the call is allowed.
 */
export function keyInputViolations(path: string, rawInput: unknown): string[] {
  const fields = KEY_GUARDED_INPUT_FIELDS[path];
  if (!fields) return [];
  if (typeof rawInput !== "object" || rawInput === null) return [];
  const input = rawInput as Record<string, unknown>;
  return fields.filter(
    (field) => input[field] !== undefined && input[field] !== false,
  );
}
