// ─────────────────────────────────────────────────────────────────────────────
// Attendee weekly review-digest email renderer
// (attendee-prompt-delivery-hygiene FR-002/FR-007)
//
// Plain-text with a visible unsubscribe footer — matches today's per-show
// prompt copy (calm-honest, FR-008 of attendee-reviews) and avoids the
// ui-email dist-rebuild footgun. Copy states plainly that this is a WEEKLY
// summary, that ratings only ever publish as an aggregate, that comments reach
// the organizer unattributed, and how to unsubscribe. No reminders language, no
// incentives, no negative-review interception.
// ─────────────────────────────────────────────────────────────────────────────

export interface AttendeeReviewDigestShowLine {
  eventTitle: string;
  placeName: string | null;
  reviewUrl: string;
}

export interface RenderAttendeeReviewDigestInput {
  recipientName: string | null;
  shows: AttendeeReviewDigestShowLine[];
  unsubscribeUrl: string;
}

export interface RenderedAttendeeReviewDigest {
  subject: string;
  text: string;
}

export function renderAttendeeReviewDigestEmail(
  input: RenderAttendeeReviewDigestInput,
): RenderedAttendeeReviewDigest {
  const count = input.shows.length;
  const showWord = count === 1 ? "show" : "shows";

  const subject =
    count === 1
      ? "How was your recent show?"
      : `How were your ${count} recent shows?`;

  const greeting = input.recipientName
    ? `Hi ${input.recipientName},`
    : "Hi there,";

  const intro =
    count === 1
      ? `You went to a show recently that you haven't rated yet. If you have a ` +
        `minute, the organizer would love to hear how it went:`
      : `You went to ${count} ${showWord} recently that you haven't rated yet. ` +
        `If you have a minute, the organizers would love to hear how they went:`;

  const showLines = input.shows.map((show) => {
    const where = show.placeName ? ` at ${show.placeName}` : "";
    return `- ${show.eventTitle}${where}\n  Rate it: ${show.reviewUrl}`;
  });

  const notes = [
    "A few honest notes:",
    "- This is a weekly summary — we won't email you separately about each show.",
    "- Your ratings only ever appear as part of an aggregate score, once enough " +
      "people have reviewed — never on their own.",
    "- Any comments go straight to the organizer, without your name attached.",
  ];

  const footer = `Not interested? Unsubscribe from these weekly emails:\n${input.unsubscribeUrl}`;

  const text = [
    greeting,
    intro,
    showLines.join("\n"),
    notes.join("\n"),
    footer,
  ].join("\n\n");

  return { subject, text };
}
