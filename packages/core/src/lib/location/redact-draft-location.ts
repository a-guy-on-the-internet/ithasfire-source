import { z } from "zod";

import type { OrgRole } from "@th/ports/repos/authz";

import { ORG_EDIT_ROLES } from "../rbac";
import { publicEventAddressText } from "./public-coordinate";

/**
 * A FREEFORM ADDRESS ON A TEMPLATE OR SERIES, AS A NON-EDITOR SEES IT
 * (place-address-withholding N4, 2026-09-25).
 *
 * Event templates and series carry a default location, and a freeform one
 * is a street address with its true coordinates — for a DIY show, usually
 * somebody's home. Their list reads admit every org role but SCANNER
 * ("view"), so a VIEWER or FINANCE member read the street and the pin that
 * the same org's event surfaces already redact for them (M4).
 *
 * Below the EDIT roles the freeform location becomes
 * `{ kind: "freeform", label }`: no street, no coordinates. `label` is the
 * coarse "locality, region" — the same derivation the public event
 * projection prints (`projectPublicEventLocation` → `publicEventAddressText`
 * under OBSCURED) — or null when the stored location carries neither (today's
 * template / series freeform shape stores only the street and the point).
 * Place / saved-location / none references are ids, not addresses, and pass
 * through unchanged.
 */

/** The redacted freeform shape, for output schemas. */
export const redactedFreeformDraftLocationSchema = z
  .object({
    kind: z.literal("freeform"),
    label: z.string().nullable(),
  })
  .strict();

export type RedactedFreeformDraftLocation = z.infer<
  typeof redactedFreeformDraftLocationSchema
>;

/** Whether an org role may see a draft's freeform street and coordinates. */
export function roleSeesDraftFreeformAddress(role: OrgRole): boolean {
  return ORG_EDIT_ROLES.includes(role);
}

/**
 * The location as a non-editor may read it. Non-freeform locations (and an
 * absent one) come back unchanged.
 */
export function redactDraftFreeformLocation<
  L extends { kind: string } | null | undefined,
>(location: L): L | RedactedFreeformDraftLocation {
  if (!location || location.kind !== "freeform") return location;
  const coarse = location as {
    locality?: string | null;
    region?: string | null;
  };
  return {
    kind: "freeform",
    label: publicEventAddressText({
      locationMode: "OBSCURED",
      addressText: null,
      locality: coarse.locality ?? null,
      region: coarse.region ?? null,
    }),
  };
}
