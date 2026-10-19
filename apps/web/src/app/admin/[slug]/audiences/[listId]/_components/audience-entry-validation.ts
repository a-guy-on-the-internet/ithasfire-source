import { useTranslations } from "@th/ui";
import { z } from "zod";

import type { EntryDraft, EntryFieldErrors } from "./audience-detail-types";

export const audienceEntrySchema = z
  .object({
    contactEmail: z.string().trim(),
    contactPhone: z.string().trim(),
    displayName: z.string().trim(),
    tags: z.string(),
  })
  .superRefine((val, ctx) => {
    const email = val.contactEmail;
    const phone = val.contactPhone;

    if (!email && !phone) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "contact_required",
        path: ["contactEmail"],
      });
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "contact_required",
        path: ["contactPhone"],
      });
      return;
    }

    if (email) {
      const emailResult = z.string().email().max(320).safeParse(email);
      if (!emailResult.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "invalid_email",
          path: ["contactEmail"],
        });
      }
    }

    if (phone) {
      const phoneResult = z.string().min(5).max(50).safeParse(phone);
      if (!phoneResult.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "invalid_phone",
          path: ["contactPhone"],
        });
      }
    }
  });

export function validateDraft(
  draft: EntryDraft,
  t: ReturnType<typeof useTranslations>,
): EntryFieldErrors | null {
  const result = audienceEntrySchema.safeParse(draft);
  if (result.success) return null;

  const errors: EntryFieldErrors = {};
  for (const issue of result.error.issues) {
    const field = issue.path[0] as keyof EntryFieldErrors | undefined;
    if (!field) continue;
    switch (issue.message) {
      case "contact_required":
        errors[field] = String(t("admin.validationContactRequired"));
        break;
      case "invalid_email":
        errors[field] = String(t("admin.validationInvalidEmail"));
        break;
      case "invalid_phone":
        errors[field] = String(t("admin.validationInvalidPhone"));
        break;
      default:
        errors[field] = issue.message;
    }
  }
  return Object.keys(errors).length > 0 ? errors : null;
}
