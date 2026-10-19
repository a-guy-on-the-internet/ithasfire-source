-- Place address withholding, D1: THE SECRET LIVES IN ONE TABLE.
--
-- Until this change, linking an event to a place COPIED the place's street
-- address, postcode and true coordinates onto the Event row. For a venue that
-- withholds its address that copy bypassed every Place-side redaction: ICS,
-- random event, discovery distance, search documents and the event builder
-- all read the Event row. The write path now stores the venue's PUBLIC
-- projection instead (`packages/core/src/lib/location/place-event-location.ts`)
-- and `upsertPlace` re-projects on every privacy change. This migration
-- repairs the rows written BEFORE that, so no stored event keeps a true copy.
--
-- For every Event whose place is not EXACT — EVERY status, ARCHIVED included:
--   · locationMode          = OBSCURED
--   · locationRadiusMeters  = the event's radius floored at the venue's
--                             (`applyPlaceLocationFloor`):
--                               venue fully hidden (NULL)      → NULL
--                               event EXACT                    → venue radius
--                               event OBSCURED, NULL (hidden)  → NULL
--                               event OBSCURED, r              → max(r, venue)
--   · lat / lng / geohash6 / geohash8 = NULL — see "the centre" below
--   · addressText           = the venue's area label: its trimmed
--                             location_label, else "city, region"
--                             (`redactPlaceLocation`'s areaLabel)
--   · postalCode            = NULL
--   · locality / region / countryCode — untouched (the coarse fields the
--                             redactor publishes in every state; the copy put
--                             the place's own values there)
--   · an event that was EXACT with no reveal schedule gets DAY_BEFORE
--     (startsAt − 24h), as the save path would; if that reveal is already in
--     the past its notification cursor is stamped so the reveal job never
--     retro-announces an address its ticket holders already had. NEVER and
--     every other existing schedule are left alone.
--
-- THE CENTRE IS NOT COMPUTED HERE. A withheld venue's public circle centre is
-- produced in TypeScript by `redactPlaceLocation` (a keyed obfuscation in the
-- place-address-withholding design), which SQL cannot reproduce. Rather than
-- guess, this sets lat/lng NULL for every re-projected event — including
-- those that keep a radius — so a circle-venue's events show no map until
-- they are next saved or their venue's privacy next changes (both re-project
-- through the TS rule and restore the centre). Fail-closed on purpose.
--
-- Single statement. Idempotent: a second run matches the same rows and
-- writes the same values (the floor is idempotent, the schedule branch no
-- longer matches). No-op in any database where no place is withheld — which
-- includes production at the time of writing.
UPDATE "Event" AS e
SET
  "locationMode" = 'OBSCURED'::"EventLocationMode",
  "locationRadiusMeters" = CASE
    WHEN p."location_radius_meters" IS NULL THEN NULL
    WHEN e."locationMode" = 'EXACT'::"EventLocationMode" THEN p."location_radius_meters"
    WHEN e."locationRadiusMeters" IS NULL THEN NULL
    ELSE GREATEST(e."locationRadiusMeters", p."location_radius_meters")
  END,
  "lat" = NULL,
  "lng" = NULL,
  "geohash6" = NULL,
  "geohash8" = NULL,
  "addressText" = COALESCE(
    NULLIF(btrim(p."location_label"), ''),
    NULLIF(
      concat_ws(
        ', ',
        CASE WHEN btrim(p."city") <> '' THEN p."city" END,
        CASE WHEN btrim(p."region") <> '' THEN p."region" END
      ),
      ''
    )
  ),
  "postalCode" = NULL,
  "address_reveal_preset" = CASE
    WHEN e."locationMode" = 'EXACT'::"EventLocationMode"
      AND e."address_reveal_preset" IS NULL
      AND e."address_reveal_at" IS NULL
    THEN 'DAY_BEFORE'::"AddressRevealPreset"
    ELSE e."address_reveal_preset"
  END,
  "address_reveal_at" = CASE
    WHEN e."locationMode" = 'EXACT'::"EventLocationMode"
      AND e."address_reveal_preset" IS NULL
      AND e."address_reveal_at" IS NULL
    THEN e."startsAt" - interval '24 hours'
    ELSE e."address_reveal_at"
  END,
  "address_reveal_notified_at" = CASE
    WHEN e."locationMode" = 'EXACT'::"EventLocationMode"
      AND e."address_reveal_preset" IS NULL
      AND e."address_reveal_at" IS NULL
      AND e."address_reveal_notified_at" IS NULL
      AND e."startsAt" - interval '24 hours' <= (now() AT TIME ZONE 'UTC')
    THEN now()
    ELSE e."address_reveal_notified_at"
  END
FROM "Place" AS p
WHERE e."placeId" = p."id"
  AND p."location_mode" <> 'EXACT'::"EventLocationMode";
