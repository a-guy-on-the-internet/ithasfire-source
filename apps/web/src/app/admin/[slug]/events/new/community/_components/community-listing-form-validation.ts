import { toIsoInTimeZone } from "../../_components/event-builder-helpers";

/**
 * Pure client-side validation + payload assembly for the community-listing
 * create form (community-managed-event-listings spec, FR-005). Mirrors the
 * transport contract `community.createListing` — the use-case schema
 * (`createCommunityListingInputSchema`) is the real boundary; this only
 * catches the errors we can explain inline before a round-trip.
 *
 * Kept free of React so it can be unit-tested directly.
 */

export type CommunityListingGeo = {
  countryCode: string | null;
  region: string | null;
  locality: string | null;
  postalCode: string | null;
  lat: number | null;
  lng: number | null;
};

export type CommunityListingFormValues = {
  title: string;
  /** `datetime-local` strings ("YYYY-MM-DDTHH:mm"). */
  startsAtLocal: string;
  endsAtLocal: string;
  /**
   * True when the native input holds a typed-but-incomplete value (`value` is
   * "" and `validity.badInput` is set). Only picks the error message.
   */
  startsIncomplete?: boolean;
  endsIncomplete?: boolean;
  /** IANA timezone id the local datetimes are interpreted in. */
  timezone: string;
  /** Freeform address text as shown in the input. */
  addressText: string;
  /** Geocode result of the selected suggestion, or null when none selected. */
  geo: CommunityListingGeo | null;
  /**
   * A place on Ithas Fire picked in the one-box Location field. It supplies
   * the address and pin server-side, so with it none of the address fields
   * is required or sent (`createCommunityListing`'s superRefine).
   */
  placeId?: string | null;
  /** Category id, or "" for none. */
  categoryId: string;
  /** Raw age-limit input ("" = not set). */
  ageLimitRaw: string;
};

export type CommunityListingErrorKey =
  | "titleRequired"
  | "startsRequired"
  | "endsRequired"
  | "startsIncomplete"
  | "endsIncomplete"
  | "endsBeforeStarts"
  | "locationRequired"
  | "countryMissing"
  | "ageLimitInvalid";

export type CommunityListingFieldErrors = Partial<
  Record<
    "title" | "startsAt" | "endsAt" | "location" | "ageLimit",
    CommunityListingErrorKey
  >
>;

/** The address half of the payload, sent only when no place is linked. */
export type CommunityListingAddressPayload = {
  addressText: string;
  countryCode: string;
  region: string | null;
  locality: string | null;
  postalCode: string | null;
  lat: number;
  lng: number;
};

/** Matches `community.createListing`'s input (minus `content`, added by the form). */
export type CommunityListingPayload = {
  title: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  categoryId?: string;
  ageLimit?: number;
} & (
  | ({ placeId?: undefined } & CommunityListingAddressPayload)
  | { placeId: string }
);

export type CommunityListingValidationResult =
  | { ok: true; payload: CommunityListingPayload }
  | { ok: false; errors: CommunityListingFieldErrors };

const COUNTRY_CODE_RE = /^[A-Za-z]{2}$/;
const AGE_LIMIT_RE = /^\d{1,2}$/;

export function validateCommunityListingForm(
  values: CommunityListingFormValues,
): CommunityListingValidationResult {
  const errors: CommunityListingFieldErrors = {};

  const title = values.title.trim();
  if (!title) {
    errors.title = "titleRequired";
  }

  if (!values.startsAtLocal) {
    errors.startsAt = values.startsIncomplete
      ? "startsIncomplete"
      : "startsRequired";
  }
  if (!values.endsAtLocal) {
    errors.endsAt = values.endsIncomplete ? "endsIncomplete" : "endsRequired";
  } else if (
    values.startsAtLocal &&
    // Equal-length "YYYY-MM-DDTHH:mm" strings compare chronologically.
    values.endsAtLocal <= values.startsAtLocal
  ) {
    errors.endsAt = "endsBeforeStarts";
  }

  const addressText = values.addressText.trim();
  const geo = values.geo;
  const placeId = values.placeId || null;
  if (placeId) {
    // The place is the address; nothing to check here.
  } else if (!addressText || geo?.lat == null || geo.lng == null) {
    errors.location = "locationRequired";
  } else if (!geo.countryCode || !COUNTRY_CODE_RE.test(geo.countryCode)) {
    // countryCode is REQUIRED by the contract — slug generation depends on it.
    errors.location = "countryMissing";
  }

  let ageLimit: number | undefined;
  const ageRaw = values.ageLimitRaw.trim();
  if (ageRaw) {
    if (!AGE_LIMIT_RE.test(ageRaw)) {
      errors.ageLimit = "ageLimitInvalid";
    } else {
      ageLimit = Number.parseInt(ageRaw, 10);
    }
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  const base = {
    title,
    startsAt: toIsoInTimeZone(values.startsAtLocal, values.timezone),
    endsAt: toIsoInTimeZone(values.endsAtLocal, values.timezone),
    timezone: values.timezone,
    ...(values.categoryId ? { categoryId: values.categoryId } : {}),
    ...(ageLimit !== undefined ? { ageLimit } : {}),
  };

  if (placeId) {
    return { ok: true, payload: { ...base, placeId } };
  }

  // Narrowed above; assert for TS.
  const okGeo = geo as CommunityListingGeo;

  return {
    ok: true,
    payload: {
      ...base,
      addressText,
      countryCode: (okGeo.countryCode as string).toUpperCase(),
      region: okGeo.region?.trim() || null,
      locality: okGeo.locality?.trim() || null,
      postalCode: okGeo.postalCode?.trim() || null,
      lat: okGeo.lat as number,
      lng: okGeo.lng as number,
    },
  };
}
