"use client";

import { DateStub, Link, type DateStubParts } from "@th/ui";

/**
 * The page head for a COMMUNITY listing with no poster.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * Measured on a 390x844 phone against a seeded community listing: the page ran
 * 3,151px and the event's own prose started at 2,188px — 69% of the way down.
 * The head alone spent 259px on a `DateStub` graphic reading "SUN 13 SEP" and
 * nothing else (it is `aria-hidden`, so to a screen reader it spent nothing at
 * all), and only THEN reached the `<h1>` at 424px, followed by a meta row
 * restating the same date and the same city.
 *
 * So the stub is promoted from decoration to the head itself: the date panel
 * keeps its frame, and the space beside it — which was empty — carries the
 * title and the venue line. The separate `<h1>` + attribution + meta stack that
 * used to sit under the artwork is REMOVED for this branch, because every fact
 * it held is printed here exactly once.
 *
 * This completes the reasoning of the 2026-09-12 ruling from the other end.
 * That change stripped the title from the stub because it duplicated the `<h1>`
 * below ("Comedy Night at Larry's" / "COMEDY NIGHT AT LARRY'S" / "Nashville,
 * TN" / "NASHVILLE, TN" — four lines, two facts). The duplication is resolved
 * the same way either time; this branch just keeps the other copy.
 *
 * A listing WITH a moderator-uploaded poster does not use this component at
 * all — it keeps the immersive `HeroBackdrop` hero exactly as it is today.
 *
 * ── WHY THE DATE PANEL IS COMPOSED, NOT `DateStub layout="split"` ───────────
 * The split artifact is a CARD composition: its title is a `<span>` at a fixed
 * ramp with a three-line `-webkit-line-clamp`. A page head cannot truncate its
 * own `<h1>`, and the `<h1>` has to be a real one. So the DATE COLUMN is the
 * real `DateStub` (`layout="column"` — the artifact torn, single-sourced with
 * the browse cards and the OG PNG) and the body beside it is written here, with
 * semantic markup and type that wraps instead of clamping.
 *
 * ── ACCESSIBILITY ───────────────────────────────────────────────────────────
 * `DateStub` hides its date column from assistive tech on every surface, and
 * rightly: "SUN", "13", "SEP" as three separate fragments is worse than useless
 * spoken aloud. On a card that costs nothing, because the card prints the date
 * as real text somewhere else. Here it is NOT free — this head is the only
 * place the date appears — so the panel is wrapped in a `role="img"` whose
 * `aria-label` is the whole date, read in the venue's zone. The graphic is then
 * announced once, as a date, in prose.
 *
 * The start TIME is deliberately not in that label: it renders above the title
 * as real text after a visible "Starts" key, so the two facts are announced
 * once each and the key is spoken from the same text that is seen — there is
 * no hidden duplicate. Exactly one `<h1>` exists on the page and it is the
 * event title; nothing in this subtree is `aria-hidden` except the date
 * graphic itself.
 *
 * ── STYLING LIVES IN `event-content.css` ────────────────────────────────────
 * Plain elements + classes rather than Tamagui stacks, because the head
 * REFLOWS: below 560px the date panel becomes a band above the title instead of
 * a column beside it, and a Tamagui `flexDirection` prop compiles to an atomic
 * class a stylesheet rule can only beat with `!important`. Colours come through
 * `var(--token, <stub hex>)` — the sanctioned raw-CSS form, with the Stub value
 * as the SSR/first-paint fallback.
 */
export type CommunityListingHeadProps = {
  title: string;
  /** DOW / DD / MO, already derived in the venue's zone. `null` reads TBA. */
  dateParts: DateStubParts | null;
  /**
   * The accessible name of the date panel — the whole date, venue-local, in
   * prose ("Sunday, September 13, 2026"). Never includes the time: the time is
   * real text above the title.
   */
  dateLabel: string;
  /** Venue-local start time ("8:30 PM"). Omitted when the date is unknown. */
  timeLabel?: string | null;
  /**
   * The key printed before `timeLabel` ("Starts") — translated by the caller,
   * like every other string here. Visible since the owner's 2026-10-17
   * ruling: a bare "8:30 PM" above the title read as a fact without a name,
   * where the fact block lower down already says STARTS / ENDS out loud.
   *
   * Still load-bearing for screen readers: `dateLabel` is the DATE only
   * (excluding the time there is what stops it being announced twice), so
   * without this a screen reader emits a bare "8:30 PM" between the date image
   * and the heading. Read in sequence that survives; reached out of sequence —
   * heading navigation, a rotor list — an orphan time means nothing.
   */
  startsLabel?: string | null;
  /** Platform venue display name, when the event sits at one. */
  venueName?: string | null;
  /** City/region, or the area label for an obscured listing. */
  placeLabel?: string | null;
  /** `EntityPage.slug` — when present the venue name links to `/places/{slug}`. */
  placeSlug?: string;
  /**
   * "Confirmed by venue" (venue-confirmation spec), already translated.
   *
   * Rendered whenever the caller passes it. The mark used to live in the
   * hero's "At {venue}" badge, which this head replaces — dropping it here
   * would have re-gated a venue's vouch on which layout the page happened to
   * pick, and `event-content-types.ts` says never to re-gate that flag.
   */
  confirmedByVenueLabel?: string | null;
  testId?: string;
};

/** The artifact's own separator between venue and place. */
const SEPARATOR = " · ";

export function CommunityListingHead({
  title,
  dateParts,
  dateLabel,
  timeLabel,
  startsLabel,
  venueName,
  placeLabel,
  placeSlug,
  confirmedByVenueLabel,
  testId = "community-listing-head",
}: CommunityListingHeadProps) {
  const venue = (venueName ?? "").trim();
  const place = (placeLabel ?? "").trim();

  return (
    <div className="community-head" data-testid={testId}>
      {/*
        The date, as a graphic with a spoken name. `role="img"` collapses the
        three tracked fragments inside into the one thing they mean; the stub's
        own `aria-hidden` underneath is then a harmless no-op.
      */}
      <div
        className="community-head__date"
        role="img"
        aria-label={dateLabel}
        data-testid="community-head-date"
      >
        <DateStub
          layout="column"
          date={dateParts}
          /*
           * `lg`, not the hero's `xl`. `xl`'s 220px numeral is sized to own a
           * full-bleed 16:9 frame; here the panel is a ~30% column beside real
           * text, and at a 320px viewport that column is 96px wide — two digits
           * at the `xl` ramp render ~161px and smear. `lg`'s 62px numeral
           * measures ~74px for two digits, which clears the narrowest panel
           * this head ever gets.
           */
          size="lg"
          testId="event-hero-date-stub"
        />
      </div>

      <div className="community-head__body">
        {timeLabel ? (
          /* The label idiom (IBM Plex Mono, tracked uppercase) — the one fact
             the date graphic deliberately does not carry. Key and value, the
             same pairing as the fact block: the key is visible (owner
             2026-10-17) and muted, the time takes the ink. The literal space
             between them is what a screen reader hears and where a narrow
             column wraps; see `startsLabel` for why the key is not
             decoration. */
          <span
            className="community-head__time"
            data-testid="community-head-time"
          >
            {startsLabel ? (
              <>
                <span className="community-head__time-key">
                  {startsLabel}
                </span>{" "}
              </>
            ) : null}
            <span className="community-head__time-value">{timeLabel}</span>
          </span>
        ) : null}

        <h1
          className="community-head__title"
          data-testid="community-head-title"
        >
          {title}
        </h1>

        {venue || place ? (
          <p
            className="community-head__venue"
            data-testid="community-head-venue"
          >
            {venue ? (
              placeSlug ? (
                <Link
                  href={`/places/${placeSlug}`}
                  className="community-head__venue-link"
                >
                  {venue}
                </Link>
              ) : (
                venue
              )
            ) : null}
            {venue && place ? SEPARATOR : null}
            {place}
            {confirmedByVenueLabel ? (
              <span
                className="community-head__confirmed"
                data-testid="event-venue-confirmed"
              >
                {confirmedByVenueLabel}
              </span>
            ) : null}
          </p>
        ) : null}
      </div>
    </div>
  );
}

CommunityListingHead.displayName = "CommunityListingHead";
