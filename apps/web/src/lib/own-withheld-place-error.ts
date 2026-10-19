import { getAppErrorCode } from "./app-error";

/**
 * `EVENT_ADDRESS_IS_OWN_WITHHELD_PLACE` (place-address-withholding N2): the
 * freeform address an event was saved with is a venue the saver manages that
 * hides its address. Saving it as a typed address would publish a second,
 * independently-drawn circle around the same house, so the save refuses and
 * names the venue in `meta` — which the builder turns into a one-click
 * "Use <venue>" (switch the location to My Places with that venue).
 *
 * The API's errorFormatter surfaces a domain error's `meta` on
 * `error.data.meta` (same channel as `quota-error.ts`). Only ever a venue the
 * saver manages, so naming it discloses nothing they can't already see.
 */
export type OwnWithheldPlaceMeta = { placeId: string; placeName: string };

export function extractOwnWithheldPlaceMeta(
  error: unknown,
): OwnWithheldPlaceMeta | null {
  if (getAppErrorCode(error) !== "EVENT_ADDRESS_IS_OWN_WITHHELD_PLACE") {
    return null;
  }
  const meta = (error as { data?: { meta?: unknown } }).data?.meta;
  if (!meta || typeof meta !== "object") return null;
  const { placeId, placeName } = meta as Record<string, unknown>;
  if (typeof placeId !== "string" || placeId.length === 0) return null;
  if (typeof placeName !== "string" || placeName.trim().length === 0) {
    return null;
  }
  return { placeId, placeName: placeName.trim() };
}
