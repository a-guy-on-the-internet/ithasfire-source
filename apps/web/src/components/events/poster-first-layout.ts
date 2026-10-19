/**
 * Whether the public event page takes the POSTER-FIRST layout: the poster in
 * a sticky rail, everything else flowing beside it in one grid
 * (`.event-page-split` in event-content.css), a cream paper sheet riding up
 * over the poster on a phone and an ink price bar docked at the bottom.
 *
 * Its own module so `EventDetail` can make the SAME call for the things it
 * owns around the page (the bottom nav's centre action, the rail's Save
 * button, the notice guard) without a second, drifting copy of the rule — and
 * so a test of EventDetail can import the rule without importing EventContent.
 *
 * Who is excluded, and why each is not a viewport question:
 *   `mobile`         — the EMBED flag. An embed is a widget in someone else's
 *                      page, sized by their iframe, not by the window.
 *   `isAdminPreview` — the builder's preview panel. Same: a box, not a page.
 *   `communityLayout`— runs its own two-track body below the head.
 *   no poster        — the Date Stub is a fixed 16:9 plate, the OG image's twin.
 */
export function isPosterFirstLayout(args: {
  heroImageUrl?: string | null;
  mobile?: boolean;
  isAdminPreview?: boolean;
  communityLayout?: boolean;
}): boolean {
  return (
    Boolean(args.heroImageUrl) &&
    !args.mobile &&
    !args.isAdminPreview &&
    !args.communityLayout
  );
}
