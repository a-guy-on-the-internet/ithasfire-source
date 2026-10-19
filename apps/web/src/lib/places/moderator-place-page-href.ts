/**
 * The moderator editor for an unowned place's page
 * (`app/moderate/places/[placeId]/page`, moderator-place-page D8). It lives
 * outside /admin/{slug} because a moderator holds no admin slug for a place
 * nobody owns.
 */
export function moderatorPlacePageHref(placeId: string): string {
  return `/moderate/places/${encodeURIComponent(placeId)}/page`;
}
