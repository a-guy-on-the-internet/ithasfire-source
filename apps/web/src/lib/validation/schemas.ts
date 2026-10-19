import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Reusable field-level schemas
// ─────────────────────────────────────────────────────────────────────────────

/** Email address (trimmed, max 320). Returns `undefined` when the field is empty. */
export const emailFieldSchema = z
  .string()
  .trim()
  .transform((v) => (v.length === 0 ? "" : v))
  .pipe(
    z.union([
      z.literal(""),
      z.string().email("invalid_email").max(320, "email_too_long"),
    ]),
  );

/**
 * Phone number (trimmed, 5-50 chars).
 * Returns `undefined` when the field is empty.
 */
export const phoneFieldSchema = z
  .string()
  .trim()
  .transform((v) => (v.length === 0 ? "" : v))
  .pipe(
    z.union([
      z.literal(""),
      z.string().min(5, "invalid_phone").max(50, "phone_too_long"),
    ]),
  );

// ─────────────────────────────────────────────────────────────────────────────
// Composite schemas
// ─────────────────────────────────────────────────────────────────────────────

/** At least one of email or phone must be non-empty. */
export const contactPairSchema = z
  .object({
    contactEmail: emailFieldSchema,
    contactPhone: phoneFieldSchema,
  })
  .superRefine((val, ctx) => {
    if (!val.contactEmail && !val.contactPhone) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contactEmail"],
        message: "contact_required",
      });
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contactPhone"],
        message: "contact_required",
      });
    }
  });

/** Login form: identifier (email or username) + password (both required). */
export const loginSchema = z.object({
  identifier: z.string().trim().min(1, "required"),
  password: z.string().min(1, "required"),
});

/**
 * Sign-up form, step 1 of 4 (structural validation only — password-strength
 * is evaluated separately).
 *
 * Two fields. Display name and username moved to the profile step (4 of 4),
 * and "confirm password" was dropped for good: the reveal toggle on the
 * password field makes a second box redundant, so the mismatch refinement
 * that lived here went with it.
 */
export const signUpSchema = z.object({
  email: z.string().trim().min(1, "required").email("invalid_email"),
  password: z.string().min(1, "required"),
});

/** Contact-us form. */
export const contactFormSchema = z.object({
  name: z.string().trim().min(1, "required"),
  email: z.string().trim().min(1, "required").email("invalid_email"),
  message: z.string().trim().min(1, "required"),
});

/** Create-organization dialog. */
export const createOrgSchema = z.object({
  name: z.string().trim().min(2, "org_name_too_short"),
});
