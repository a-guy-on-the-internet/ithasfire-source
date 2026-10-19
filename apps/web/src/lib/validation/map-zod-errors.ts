import type { z } from "zod";
import { lookupOwn } from "../lookup-own";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Per-field error record: keys are field names, values are user-facing strings. */
export type FieldErrors<T extends string = string> = Partial<Record<T, string>>;

/**
 * A translate function compatible with `useTranslations()` from `@th/ui`.
 * We only ever call `t(key)` (no interpolation params), so a single-arg
 * signature is sufficient. The broader overload keeps the type compatible
 * with the actual return type of `useTranslations()`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TFn = (key: string, values?: any) => unknown;

// ─────────────────────────────────────────────────────────────────────────────
// Default Zod-message → i18n-key mapping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps the custom Zod `.message` strings defined in our schemas to
 * i18n keys consumed by `useTranslations()`.
 *
 * Convention:
 *  - Schemas use short snake_case tokens as messages (`"invalid_email"`, `"required"`).
 *  - This map turns them into the matching UI copy via `t(key)`.
 *
 * If a message is not found here, the adapter falls back to displaying the
 * raw Zod message as-is (still useful during development).
 */
const DEFAULT_MESSAGE_MAP: Record<string, string> = {
  // generic
  required: "common.required",
  // email / phone
  invalid_email: "admin.validationInvalidEmail",
  email_too_long: "admin.validationInvalidEmail",
  invalid_phone: "admin.validationInvalidPhone",
  phone_too_long: "admin.validationInvalidPhone",
  contact_required: "admin.validationContactRequired",
  // auth
  password_mismatch: "auth.scPasswordsMismatch",
  // org
  org_name_too_short: "admin.createOrgNameTooShort",
};

// ─────────────────────────────────────────────────────────────────────────────
// Adapter
// ─────────────────────────────────────────────────────────────────────────────

export interface MapZodErrorsOptions<F extends string> {
  /** The Zod error to map. */
  error: z.ZodError;
  /**
   * Translation function — typically the return value of `useTranslations()`.
   * If omitted the adapter returns the raw Zod message strings (handy for tests).
   */
  t?: TFn;
  /**
   * Extra message→i18n-key overrides that are merged on top of the defaults.
   * This lets individual forms add domain-specific mappings without touching
   * the shared map.
   */
  messageMap?: Record<string, string>;
  /**
   * Restrict output keys to a known set of field names. Useful for typing
   * the result when you know the schema shape. Purely a TS convenience —
   * at runtime all path[0] strings are included.
   */
  _fields?: readonly F[];
}

/**
 * Transforms a `ZodError` into a flat `FieldErrors` record mapping each
 * field name (first path segment) to a single user-facing string.
 *
 * Only the **first** issue per field is kept — this mirrors how most UIs
 * show at most one error per input at a time.
 *
 * ```ts
 * const result = loginSchema.safeParse(draft);
 * if (!result.success) {
 *   const errors = mapZodErrors({ error: result.error, t });
 *   // errors: { email?: string; password?: string }
 * }
 * ```
 */
export function mapZodErrors<F extends string = string>({
  error,
  t,
  messageMap,
}: MapZodErrorsOptions<F>): FieldErrors<F> {
  const merged = messageMap
    ? { ...DEFAULT_MESSAGE_MAP, ...messageMap }
    : DEFAULT_MESSAGE_MAP;

  const out: FieldErrors<F> = {};

  for (const issue of error.issues) {
    const field = (issue.path[0] ?? "") as F;
    if (!field) continue;

    // Keep only the first issue per field.
    if (out[field] !== undefined) continue;

    const i18nKey = lookupOwn(merged, issue.message);
    if (i18nKey && t) {
      out[field] = String(t(i18nKey));
    } else {
      // Fallback: use the raw message (still helpful during dev / for unmapped codes).
      out[field] = issue.message;
    }
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience: validate + map in one call
// ─────────────────────────────────────────────────────────────────────────────

export interface ValidateFormOptions<T, F extends string> {
  schema: z.ZodType<T>;
  data: unknown;
  t?: TFn;
  messageMap?: Record<string, string>;
  _fields?: readonly F[];
}

/**
 * One-shot helper: `safeParse` + `mapZodErrors`.
 *
 * Returns `{ success: true, data }` or `{ success: false, fieldErrors }`.
 */
export function validateForm<T, F extends string = string>({
  schema,
  data,
  t,
  messageMap,
}: ValidateFormOptions<T, F>):
  | { success: true; data: T; fieldErrors?: undefined }
  | { success: false; data?: undefined; fieldErrors: FieldErrors<F> } {
  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    fieldErrors: mapZodErrors<F>({ error: result.error, t, messageMap }),
  };
}
