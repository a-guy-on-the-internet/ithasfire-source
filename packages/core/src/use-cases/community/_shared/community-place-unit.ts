import {
  foldUnitIntoFormatted,
  unitOrNull,
} from "../../../lib/location/place-unit";
import type { PlaceWriteInput } from "../../places/upsert-place";
import type { CommunityPlaceAddress } from "./community-place";

/**
 * The community place dialog's optional "Unit or room" line is stored in
 * `Place.addrLine2` AND folded into the formatted text by the server, at one
 * known position (`lib/location/place-unit.ts`, which the web dialog imports
 * too). The server does the fold, so a unit-only edit can re-fold it into the
 * stored text without the client holding the street line or postcode.
 *
 * Legacy places whose unit was folded into `line1` and `formatted` by the
 * client (before 2026-10-14) keep that text and a NULL `addrLine2`; there is
 * no data migration. Stripping a NULL unit changes nothing, so editing such a
 * place keeps its text as it is.
 */

/**
 * A community address as the Place write takes it: the unit folded into
 * `formatted` and carried as `line2` (omitted when there is none, which
 * `normalizeAddress` turns into a NULL `addrLine2`). `address.formatted` is
 * the text WITHOUT the unit (the API contract).
 */
export function communityWriteAddress(
  address: CommunityPlaceAddress,
  unit: string | null,
): NonNullable<PlaceWriteInput["address"]> & { lat: number; lng: number } {
  const { line2: _ignored, ...rest } = address;
  const u = unitOrNull(unit);
  return {
    ...rest,
    formatted: foldUnitIntoFormatted(rest.formatted, rest.line1, u),
    ...(u ? { line2: u } : {}),
  };
}
