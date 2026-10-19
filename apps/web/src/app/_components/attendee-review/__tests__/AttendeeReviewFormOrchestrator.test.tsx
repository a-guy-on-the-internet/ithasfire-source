import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AttendeeReviewFormOrchestrator } from "../AttendeeReviewFormOrchestrator";

// ── Shared submit-mutation spy (hoisted so the vi.mock factory can close over it)
const h = vi.hoisted(() => ({
  mutate: vi.fn(),
  opts: undefined as { onSuccess?: (r: unknown) => void } | undefined,
}));

vi.mock("@/trpc", () => ({
  trpc: {
    attendeeReviews: {
      submit: {
        useMutation: (opts: { onSuccess?: (r: unknown) => void }) => {
          h.opts = opts;
          return { mutate: h.mutate, isPending: false };
        },
      },
    },
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

vi.mock("next/link", () => ({
  default: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

vi.mock("lucide-react", () => ({
  ArrowRight: () => null,
  ArrowLeft: () => null,
  Check: () => null,
  SkipForward: () => null,
}));

const CONTINUE = "attendeeReview.nav.continueAria";
const SUBMIT = "attendeeReview.nav.submitAria";
const SKIP = "attendeeReview.nav.skipAria";

function rate(id: string, n: number) {
  fireEvent.click(screen.getByTestId(`attendee-${id}-block-${n}`));
}

beforeEach(() => {
  h.mutate.mockReset();
  h.opts = undefined;
  // Force reduced-motion so screen transitions are synchronous (no rAF/timers).
  window.matchMedia = vi.fn().mockImplementation(() => ({
    matches: true,
    media: "(prefers-reduced-motion: reduce)",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
});

describe("AttendeeReviewFormOrchestrator", () => {
  it("opens on the overall question", () => {
    render(<AttendeeReviewFormOrchestrator eventId="evt-1" />);
    expect(
      screen.getByText("attendeeReview.form.overall.q"),
    ).toBeInTheDocument();
  });

  it("blocks advancing past the required overall question until rated", () => {
    render(<AttendeeReviewFormOrchestrator eventId="evt-1" />);
    fireEvent.click(screen.getByLabelText(CONTINUE));
    expect(
      screen.getByText("attendeeReview.validation.pickRating"),
    ).toBeInTheDocument();
    // Still on the overall screen.
    expect(
      screen.getByText("attendeeReview.form.overall.q"),
    ).toBeInTheDocument();
  });

  it("progresses core → optional screens with Continue", () => {
    render(<AttendeeReviewFormOrchestrator eventId="evt-1" />);
    rate("overall", 4);
    fireEvent.click(screen.getByLabelText(CONTINUE));
    expect(screen.getByText("attendeeReview.form.sound.q")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(CONTINUE));
    expect(
      screen.getByText("attendeeReview.form.organization.q"),
    ).toBeInTheDocument();
  });

  it("selects a rating with the number keys and advances on Enter", () => {
    render(<AttendeeReviewFormOrchestrator eventId="evt-1" />);
    const group = screen.getByRole("radiogroup", {
      name: "attendeeReview.form.overall.q",
    });
    fireEvent.keyDown(group, { key: "3" });
    fireEvent.keyDown(window, { key: "Enter" });
    expect(screen.getByText("attendeeReview.form.sound.q")).toBeInTheDocument();
  });

  it("skips the rest and submits from an optional screen", () => {
    render(<AttendeeReviewFormOrchestrator eventId="evt-1" />);
    rate("overall", 5);
    fireEvent.click(screen.getByLabelText(CONTINUE)); // → sound
    fireEvent.click(screen.getByLabelText(CONTINUE)); // → organization
    fireEvent.click(screen.getByLabelText(CONTINUE)); // → venue comfort (optional)
    fireEvent.click(screen.getByLabelText(SKIP));
    expect(h.mutate).toHaveBeenCalledTimes(1);
    expect(h.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "evt-1", overallRating: 5 }),
    );
  });

  it("submits the full payload and shows the completion screen", () => {
    render(
      <AttendeeReviewFormOrchestrator eventId="evt-1" eventSlug="slug-1" />,
    );
    rate("overall", 5);
    fireEvent.click(screen.getByLabelText(CONTINUE)); // → sound
    rate("sound", 4);
    fireEvent.click(screen.getByLabelText(CONTINUE)); // → organization
    rate("organization", 3);
    fireEvent.click(screen.getByLabelText(CONTINUE)); // → venue comfort
    rate("venueComfort", 2);
    fireEvent.click(screen.getByLabelText(CONTINUE)); // → value
    rate("value", 1);
    fireEvent.click(screen.getByLabelText(CONTINUE)); // → text
    fireEvent.change(screen.getByTestId("attendee-text-textarea"), {
      target: { value: "great room" },
    });
    fireEvent.click(screen.getByLabelText(SUBMIT));

    expect(h.mutate).toHaveBeenCalledWith({
      eventId: "evt-1",
      overallRating: 5,
      soundQuality: 4,
      organization: 3,
      venueComfort: 2,
      valueForMoney: 1,
      text: "great room",
    });

    // Simulate the server acknowledging the write → warm completion screen.
    act(() => {
      h.opts?.onSuccess?.({ reviewId: "r1" });
    });
    expect(
      screen.getByText("attendeeReview.success.title"),
    ).toBeInTheDocument();
  });
});
