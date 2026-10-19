/**
 * Pure state derivation for the "I'm going" toggle (community-managed-
 * event-listings FR-004) — extracted so the loading/pending/signed-out
 * branching is unit-testable without mocking tRPC or the auth client.
 */

export type RsvpButtonStateInput = {
  /**
   * False on the SERVER render and on the FIRST client render; true from the
   * commit after hydration. While it is false the two session inputs below are
   * ignored in favour of the only values a server render can ever have.
   *
   * `authClient.useSession()` is a client store that never fetches during SSR
   * (`better-auth/client/query` early-returns on `isServer()`), so its atom is
   * `{ data: null, isPending: true }` in every server render, for everyone.
   * The client store, on the other hand, may ALREADY have resolved by the time
   * this island hydrates — and then the first client render took a different
   * branch than the HTML it was hydrating into. That was a live bug on
   * `/events/<single-date community listing>`: SSR wrote no `aria-disabled`,
   * the first client render wanted `aria-disabled="true"`, `aria-busy="true"`
   * and `opacity: 0.55`, and React does not patch attributes up ("This won't be
   * patched up") — so the page logged a hydration error AND kept whichever
   * attributes the server happened to write.
   *
   * Gating here rather than on the OUTPUT keeps one derivation with one set of
   * rules: the pre-hydration answer is not a fourth special-cased state, it is
   * this same function asked the question the server was asked.
   */
  hydrated: boolean;
  isSignedIn: boolean;
  /** `useSession().isPending` — the client session is still resolving. */
  sessionPending: boolean;
  /** `community.myRsvpForEvent` result, when it has arrived. */
  queryRsvped: boolean | undefined;
  /** Server-rendered `viewerRsvped` seed from the event payload. */
  initialRsvped: boolean | undefined;
  /** rsvp / cancelRsvp mutation in flight. */
  mutationPending: boolean;
};

export type RsvpButtonState = {
  /** The viewer's own state — the ONLY state this button ever reflects. */
  going: boolean;
  /**
   * True while we cannot yet know the viewer's state (session or query
   * resolving without a server seed). The button renders but is inert so
   * its dimensions never shift.
   */
  resolving: boolean;
  /** Block presses (resolving or a mutation already in flight). */
  disabled: boolean;
};

export function deriveRsvpButtonState({
  hydrated,
  isSignedIn: clientSignedIn,
  sessionPending: clientSessionPending,
  queryRsvped,
  initialRsvped,
  mutationPending,
}: RsvpButtonStateInput): RsvpButtonState {
  // Before hydration, answer as the server necessarily did — see `hydrated`.
  // Only these two inputs can differ across the boundary: `initialRsvped` is a
  // prop, and both `queryRsvped` (a fresh react-query cache, seeded from that
  // same prop or empty) and `mutationPending` (a fresh mutation cache, always
  // 0) are identical on a first client render by construction.
  const isSignedIn = hydrated && clientSignedIn;
  const sessionPending = hydrated ? clientSessionPending : true;

  // `isSignedIn` (derived from `useSession().data?.user`) is false BOTH for a
  // truly anonymous visitor AND briefly for a signed-in viewer whose client
  // session is still catching up after SSR. Anonymous clickability must NEVER
  // depend on session-resolution timing — a slow/settling `isPending` made the
  // button feel and act dead, which was the original S1 dead-end. Instead use
  // the SSR seed as the "was signed-in at request time" signal: get-event-seo
  // sets `viewerRsvped` (→ `initialRsvped`) ONLY when a viewer human id is
  // present, so it is `undefined` for anon.
  if (!isSignedIn) {
    if (initialRsvped !== undefined && sessionPending) {
      // SSR saw this viewer signed-in and the client session is still
      // resolving. Stay briefly inert so a fast press can't open the sign-in
      // overlay for a (very likely) authenticated user. Bounded: the moment
      // `isPending` settles we either become signed-in or fall through below.
      return {
        going: initialRsvped,
        resolving: true,
        disabled: true,
      };
    }
    // Signed-out for real: either truly anonymous (no SSR seed) or the session
    // settled to null after an SSR seed (expired/revoked between render and
    // hydration, stale client-nav payload). Either way the CTA must stay
    // PRESSABLE so a click opens the sign-in overlay — mirror SaveButton.
    return {
      going: false,
      resolving: false,
      disabled: false,
    };
  }

  const going = queryRsvped ?? initialRsvped ?? false;
  const resolving = queryRsvped === undefined && initialRsvped === undefined;

  return {
    going,
    resolving,
    disabled: resolving || mutationPending,
  };
}
