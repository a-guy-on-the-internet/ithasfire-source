// ─────────────────────────────────────────────────────────────────────────────
// WHAT KEEP WILL DO, on the act's side (booking-the-night N19 / FR-014).
//
// Keep is a commit now. `answerBookingHoldChallenge` decides it with
// `resolveKeepPlan` (answer-booking-hold-challenge.ts), and the act's own read
// (`bookingHolds.listForRequest`, viewer "act") carries the same answer per
// challenged hold as `keepWill` / `kept`:
//   · book_now      terms for this night are with the act: Keep agrees them
//                   and books the night. The server REQUIRES
//                   `expectedKeepWill: "book_now"` here and refuses a plain
//                   keep (TERMS_CHANGED_SINCE_VIEWED, fail closed);
//   · ask_for_terms no terms yet: Keep records the keep, asks the place for
//                   terms, and pushes the deadline to at least 48h;
//   · null          terms for the night are already agreed: nothing to keep
//                   (TERMS_AGREED_FOR_THIS_NIGHT);
//   · kept: true    already kept this challenge, waiting for terms; a second
//                   keep is a no-op — unless the terms have since arrived
//                   (keepWill book_now), when Keep agrees them and books.
// The panel sends back exactly the `keepWill` it displayed, so a tap meant as
// "ask for terms" can never book a night.
// ─────────────────────────────────────────────────────────────────────────────

export type KeepWill = "book_now" | "ask_for_terms";

/** One challenged hold's facts from the act-side read, by hold id. */
export type ActChallengeFacts = { keepWill: KeepWill | null; kept: boolean };

export type ActKeepView =
  /** The read has not answered yet: Keep waits (it may need expectedKeepWill). */
  | { kind: "loading" }
  /** The read failed or does not list this hold: Keep waits, offer a re-check. */
  | { kind: "unknown" }
  | { kind: "book_now" }
  | { kind: "ask_for_terms" }
  /** Kept already; waiting for the place's terms. No Keep button. */
  | { kind: "kept" }
  /** Terms for the night are agreed. No Keep button. */
  | { kind: "agreed" };

export function actKeepView(args: {
  holdId: string;
  status: "loading" | "error" | "success";
  facts: ReadonlyMap<string, ActChallengeFacts> | null;
}): ActKeepView {
  if (args.status === "loading") return { kind: "loading" };
  const facts = args.status === "success" ? args.facts?.get(args.holdId) : undefined;
  if (!facts) return { kind: "unknown" };
  // Order matters (resolveActChallengeView, keep-will.ts): agreed terms
  // first — nothing to keep. Then terms that ARRIVED after an
  // ask-for-terms keep (kept: true, keepWill: book_now): Keep now books
  // (answer-booking-hold-challenge.ts, the book_now branch), so offer it.
  if (facts.keepWill === null) return { kind: "agreed" };
  if (facts.keepWill === "book_now") return { kind: "book_now" };
  if (facts.kept) return { kind: "kept" };
  return { kind: facts.keepWill };
}

/** The `answer` input for a Keep the panel displayed as `view`. */
export function keepAnswerInput(
  holdId: string,
  view: ActKeepView,
): { holdId: string; answer: "keep"; expectedKeepWill: KeepWill } | null {
  if (view.kind !== "book_now" && view.kind !== "ask_for_terms") return null;
  return { holdId, answer: "keep", expectedKeepWill: view.kind };
}

/**
 * Refusals that mean "what Keep does changed since you looked": refetch and
 * show the new choice, never retry.
 */
const KEEP_CHANGED_CODES = new Set([
  "TERMS_CHANGED_SINCE_VIEWED",
  "TERMS_AGREED_FOR_THIS_NIGHT",
]);

export function isKeepChangedError(err: unknown): boolean {
  const appCode = (err as { data?: { appCode?: string } | null } | null)?.data?.appCode;
  return appCode !== undefined && KEEP_CHANGED_CODES.has(appCode);
}
