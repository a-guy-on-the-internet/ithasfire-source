import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The REAL server-side input schema — imported so these tests fail if the form
// ever builds a payload the transport would reject (the null-facet 400 bug).
import { submitCommunityVenueReviewInputSchema } from "@th/core/use-cases/attendee-reviews/submit-community-venue-review";

import { CommunityVenueReviewForm } from "../CommunityVenueReviewForm";

// placeId is validated as a real UUID by the schema, so schema-conformance
// paths must render with a valid one (the shorthand ids below only exercise the
// mutate-shape assertions, which don't parse placeId).
const UUID = "d6f1a2b3-4c5d-4e6f-8a90-1b2c3d4e5f60";

// ── Shared spies/state (hoisted so the vi.mock factories can close over them) ──
// `session` is mutated per-test to flip the guest ↔ signed-in fork the component
// reads from `authClient.useSession()`.
const h = vi.hoisted(() => ({
  mutate: vi.fn(),
  opts: undefined as { onSuccess?: (r: unknown) => void } | undefined,
  session: { data: null as { user?: { id: string } } | null },
}));

vi.mock("@/trpc", () => ({
  trpc: {
    attendeeReviews: {
      submitCommunityVenueReview: {
        useMutation: (opts: { onSuccess?: (r: unknown) => void }) => {
          h.opts = opts;
          return { mutate: h.mutate, isPending: false };
        },
      },
    },
  },
}));

vi.mock("@/lib/auth/auth-client", () => ({
  authClient: {
    useSession: () => h.session,
  },
}));

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({ children }: { children?: ReactNode }) =>
    React.createElement("div", null, children);
  return {
    XStack: Stack,
    YStack: Stack,
    Stack,
    styled: () => Stack,
    useMedia: () => ({ sm: false }),
  };
});

vi.mock("@th/ui", () => ({
  useTranslations: () => (key: string) => key,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Spinner: () => <span data-testid="spinner" />,
  Button: ({
    children,
    onPress,
    disabled,
    "aria-label": ariaLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    "aria-label"?: string;
  }) => (
    <button aria-label={ariaLabel} disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
  CharCountTextarea: ({
    value,
    onChange,
    testIdBase,
  }: {
    value: string;
    onChange: (v: string) => void;
    testIdBase?: string;
  }) => (
    <textarea
      data-testid={`${testIdBase}-textarea`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

vi.mock("@th/errors", () => ({
  normalizeError: () => ({ formError: null, fieldErrors: {}, code: null }),
}));

vi.mock("@/lib/design-tokens", () => ({ ACCENT: "#FF5721" }));

vi.mock("@/lib/motion", () => ({
  DURATION: { micro: 120, fast: 180, base: 220, medium: 320, slow: 480 },
  SPRING_EASE: "ease",
  STANDARD_EASE: "ease",
}));

vi.mock("lucide-react", () => ({
  ArrowRight: () => null,
  ArrowLeft: () => null,
  Check: () => null,
  SkipForward: () => null,
}));

const CONTINUE = "attendeeReview.nav.continueAria";
const SKIP = "attendeeReview.nav.skipAria";
const PICK_RATING = "attendeeReview.validation.pickRating";
const EMAIL_ERR = "attendeeReview.community.validation.email";

function rate(id: string, n: number) {
  fireEvent.click(screen.getByTestId(`community-${id}-block-${n}`));
}
function next() {
  fireEvent.click(screen.getByLabelText(CONTINUE));
}

beforeEach(() => {
  h.mutate.mockReset();
  h.opts = undefined;
  h.session = { data: null }; // default: guest
  // Force reduced-motion so screen transitions are synchronous (no rAF/timers).
  window.matchMedia = vi.fn().mockImplementation(() => ({
    matches: true,
    media: "(prefers-reduced-motion: reduce)",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
});

describe("CommunityVenueReviewForm", () => {
  // ── Assertion 1: guest submission carries anonymous identity ───────────────
  it("sends anonymousName + anonymousEmail (and no humanId) for a guest", () => {
    h.session = { data: null };
    render(<CommunityVenueReviewForm placeId="place-1" />);

    // Guest fork prepends name + email screens.
    fireEvent.change(screen.getByTestId("community-name-input"), {
      target: { value: "  Guesty  " },
    });
    next(); // name → email
    fireEvent.change(screen.getByTestId("community-email-input"), {
      target: { value: "  Guest@Example.COM  " },
    });
    next(); // email → overall

    rate("overall", 4);
    next(); // overall → sound
    next(); // sound → organization
    next(); // organization → venueComfort (first optional)
    // Optional non-last screen exposes Skip → submits immediately.
    fireEvent.click(screen.getByLabelText(SKIP));

    expect(h.mutate).toHaveBeenCalledTimes(1);
    const payload = h.mutate.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      placeId: "place-1",
      overallRating: 4,
      anonymousName: "Guesty",
      anonymousEmail: "guest@example.com", // trimmed + lowercased
    });
    // No client-supplied humanId — identity is bound server-side.
    expect(payload).not.toHaveProperty("humanId");
  });

  // ── Assertion 2: signed-in submission omits anonymous identity ─────────────
  it("sends NEITHER anonymousName NOR anonymousEmail when signed in", () => {
    h.session = { data: { user: { id: "human-1" } } };
    render(<CommunityVenueReviewForm placeId="place-2" />);

    // Signed-in fork skips the name/email screens → overall is first.
    expect(
      screen.getByText("attendeeReview.form.overall.q"),
    ).toBeInTheDocument();

    rate("overall", 5);
    next(); // overall → sound
    next(); // sound → organization
    next(); // organization → venueComfort (first optional)
    fireEvent.click(screen.getByLabelText(SKIP));

    expect(h.mutate).toHaveBeenCalledTimes(1);
    const payload = h.mutate.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload).toMatchObject({ placeId: "place-2", overallRating: 5 });
    expect(payload).not.toHaveProperty("anonymousName");
    expect(payload).not.toHaveProperty("anonymousEmail");
  });

  // ── Assertion 3: an unrated overall blocks submit + surfaces validation ────
  it("blocks submit and shows the rating error when overall is unrated", () => {
    h.session = { data: { user: { id: "human-1" } } };
    render(<CommunityVenueReviewForm placeId="place-3" />);

    // Overall is the first (required) screen; advancing without a rating fails.
    next();

    expect(screen.getByText(PICK_RATING)).toBeInTheDocument();
    // Still parked on the overall screen; nothing submitted.
    expect(
      screen.getByText("attendeeReview.form.overall.q"),
    ).toBeInTheDocument();
    expect(h.mutate).not.toHaveBeenCalled();
  });

  // ── Assertion 4: out-of-range (unset = 0) facets are dropped ───────────────
  it("drops facet values outside 1-5 and keeps only the rated ones", () => {
    // Via the UI the only out-of-range facet value reachable is 0 (unset) —
    // RatingScale can never emit <1 or >5 — so unset facets exercise the
    // `facet(v) = 1..5 ? v : undefined` guard.
    h.session = { data: { user: { id: "human-1" } } };
    render(<CommunityVenueReviewForm placeId="place-4" />);

    rate("overall", 5);
    next(); // overall → sound
    rate("sound", 3);
    next(); // sound → organization
    next(); // organization (unset) → venueComfort (first optional)
    fireEvent.click(screen.getByLabelText(SKIP)); // venueComfort + value unset

    expect(h.mutate).toHaveBeenCalledTimes(1);
    const payload = h.mutate.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.overallRating).toBe(5);
    expect(payload.soundQuality).toBe(3);
    // Unset facets are OMITTED entirely — NOT sent as null/undefined — because
    // the server schema is `.strict()` and rejects an explicit null on the wire.
    expect(payload).not.toHaveProperty("organization");
    expect(payload).not.toHaveProperty("venueComfort");
    expect(payload).not.toHaveProperty("valueForMoney");
    expect(payload).not.toHaveProperty("text");
  });

  // ── Assertion 5: EMAIL_RE guest validation blocks an invalid email ─────────
  it("blocks a guest with an invalid email and shows the email error", () => {
    h.session = { data: null };
    render(<CommunityVenueReviewForm placeId="place-5" />);

    fireEvent.change(screen.getByTestId("community-name-input"), {
      target: { value: "Guesty" },
    });
    next(); // name → email
    fireEvent.change(screen.getByTestId("community-email-input"), {
      target: { value: "not-an-email" },
    });
    next(); // attempt email → overall (blocked by EMAIL_RE)

    expect(screen.getByText(EMAIL_ERR)).toBeInTheDocument();
    // Still on the email screen; nothing submitted.
    expect(
      screen.getByTestId("community-email-input"),
    ).toBeInTheDocument();
    expect(h.mutate).not.toHaveBeenCalled();
  });

  // ── Assertion 6: the guest payload PARSES against the real server schema ───
  it("builds a guest payload that satisfies the real submit schema", () => {
    h.session = { data: null };
    render(<CommunityVenueReviewForm placeId={UUID} />);

    fireEvent.change(screen.getByTestId("community-name-input"), {
      target: { value: "Guesty" },
    });
    next(); // name → email
    fireEvent.change(screen.getByTestId("community-email-input"), {
      target: { value: "guest@example.com" },
    });
    next(); // email → overall

    rate("overall", 4);
    next(); // overall → sound
    next(); // sound → organization
    next(); // organization → venueComfort (first optional)
    fireEvent.click(screen.getByLabelText(SKIP)); // submit with facets unset

    expect(h.mutate).toHaveBeenCalledTimes(1);
    const payload = h.mutate.mock.calls[0]![0] as Record<string, unknown>;

    // A guest carries name + email and NO humanId — exactly the shape the
    // transport hands the use case for an anonymous submitter.
    const result = submitCommunityVenueReviewInputSchema.safeParse(payload);
    expect(result.success).toBe(true);
    // And the unset facets are absent, not null (the actual 400 cause).
    expect(payload).not.toHaveProperty("soundQuality");
    expect(payload).not.toHaveProperty("organization");
  });

  // ── Assertion 7: the signed-in payload PARSES once humanId is injected ─────
  it("builds a signed-in payload that satisfies the real submit schema", () => {
    h.session = { data: { user: { id: "human-1" } } };
    render(<CommunityVenueReviewForm placeId={UUID} />);

    rate("overall", 5);
    next(); // overall → sound
    rate("sound", 4);
    next(); // sound → organization
    next(); // organization → venueComfort (first optional)
    fireEvent.click(screen.getByLabelText(SKIP));

    expect(h.mutate).toHaveBeenCalledTimes(1);
    const payload = h.mutate.mock.calls[0]![0] as Record<string, unknown>;

    // The form omits humanId (the server injects it from the session). Mirror
    // that injection here — this is the exact object the transport validates.
    const serverInput = { ...payload, humanId: UUID };
    const result = submitCommunityVenueReviewInputSchema.safeParse(serverInput);
    expect(result.success).toBe(true);
    expect(payload).not.toHaveProperty("anonymousName");
    expect(payload).not.toHaveProperty("anonymousEmail");
  });

  // ── Assertion 8: every screen is visited exactly once (counter +1 per step) ─
  it("advances exactly one screen per Continue, visiting each question once", () => {
    vi.useFakeTimers();
    try {
      h.session = { data: { user: { id: "human-1" } } };
      render(<CommunityVenueReviewForm placeId={UUID} />);

      // Signed-in flow: overall → sound → organization → venueComfort → value → text.
      const q = (id: string) => `attendeeReview.form.${id}.q`;
      const counter = () =>
        Number(screen.getByRole("progressbar").getAttribute("aria-valuenow"));
      // Flush any pending timer (a lingering auto-advance would double-step).
      const settle = () => act(() => vi.runOnlyPendingTimers());

      // Walk the whole flow. `rate` schedules a gentle auto-advance the manual
      // Continue MUST cancel; `settle` then proves nothing extra fired. Each
      // step asserts the progress counter incremented by exactly one — no skips.
      const step = (id: string, expectedCounter: number, ratedId?: string) => {
        expect(screen.getByText(q(id))).toBeInTheDocument();
        expect(counter()).toBe(expectedCounter);
        if (ratedId) rate(ratedId, 4);
        next();
        settle();
      };

      step("overall", 1, "overall"); // required rating
      step("sound", 2, "sound");
      step("organization", 3); // left unrated
      step("venueComfort", 4, "venueComfort");
      step("value", 5); // left unrated
      // Landed on the final screen exactly once — no screens were skipped.
      expect(screen.getByText(q("text"))).toBeInTheDocument();
      expect(counter()).toBe(6);
      // Never over-shot into a submit while walking the screens.
      expect(h.mutate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

afterEach(() => {
  vi.useRealTimers();
});
