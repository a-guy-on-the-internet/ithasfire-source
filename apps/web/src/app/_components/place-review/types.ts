/**
 * Public types for the reusable place review form.
 */

export type PlaceReviewPrefill = {
  name?: string;
  email?: string;
  placeId?: string;
  placeName?: string;
  campaign?: string;
};

export type PlaceReviewFormProps = {
  prefill?: PlaceReviewPrefill;
  variant?: "page" | "embedded";
  /** Drop the form's own border/height so it fills a modal or sheet panel. */
  chromeless?: boolean;
  onSubmitted?: () => void;
};
