import { z } from "zod";

export const contactEmailSchema = z
  .string()
  .trim()
  .email("invalid_contact_email")
  .max(320)
  .nullable()
  .optional();

/**
 * Same rules as {@link contactEmailSchema}, but LOWERCASED at the boundary.
 *
 * Use this wherever the address is an identity key rather than just a reply-to:
 * event applications dedupe guests on `lower(contactEmail)` via a partial
 * unique index (spec Phase 3 / D5), so the column has to be lowercased at rest
 * or the stored value and the indexed expression disagree. Same discipline as
 * `BookingRequest.contactEmail`.
 *
 * Order matters: trim → lowercase → validate, so `" Ada@Example.COM "` both
 * validates and stores as `ada@example.com`.
 */
export const lowercasedContactEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.string().email("invalid_contact_email").max(320))
  .nullable()
  .optional();

export const contactPhoneSchema = z
  .string()
  .trim()
  .min(5)
  .max(32)
  .nullable()
  .optional();

export function hasViewerContact(value: {
  viewerHumanId?: string | null | undefined;
  contactEmail?: string | null | undefined;
  contactPhone?: string | null | undefined;
}): boolean {
  return Boolean(
    value.viewerHumanId ?? value.contactEmail ?? value.contactPhone,
  );
}
