import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The terms strip: the agreement's binding header, rendered inside the
 * conversation about it.
 *
 * These pin the FETCH BOUNDARY and the rendered shape. The decision table
 * itself lives in `booking-terms-strip.test.ts`; what is asserted here is the
 * part a pure test cannot see — that the query is issued with the right key,
 * that a failed read still admits terms exist, and that nothing here offers to
 * edit anything.
 *
 * Only chrome is mocked (tamagui, @th/ui, trpc). Component tests mock the
 * design system away, so they are blind to overflow and legibility — the 320px
 * and contrast checks are browser work, not these.
 */

const mocks = vi.hoisted(() => ({
  getUseQuery: vi.fn(),
  refetch: vi.fn(),
}));

vi.mock("@/trpc", () => ({
  trpc: {
    bookingAgreements: {
      get: {
        useQuery: (input: unknown, opts: unknown) =>
          mocks.getUseQuery(input, opts),
      },
    },
  },
}));

vi.mock("tamagui", () => {
  const Stack = ({
    children,
    ...rest
  }: {
    children?: ReactNode;
    [key: string]: unknown;
  }) => (
    <div
      data-testid={rest["data-testid"] as string | undefined}
      data-ended={rest["data-ended"] as string | undefined}
      role={rest.role as string | undefined}
      aria-labelledby={rest["aria-labelledby"] as string | undefined}
    >
      {children}
    </div>
  );
  return { XStack: Stack, YStack: Stack, styled: () => Stack };
});

type SpanProps = {
  children?: ReactNode;
  testId?: string;
  id?: string;
  tone?: string;
  "data-testid"?: string;
};

vi.mock("@th/ui", () => ({
  Badge: ({ children, tone, ...rest }: SpanProps) => (
    <span data-testid={rest["data-testid"]} data-tone={tone}>
      {children}
    </span>
  ),
  Button: ({
    children,
    onPress,
    testID,
    disabled,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    testID?: string;
    disabled?: boolean;
  }) => (
    <button
      type="button"
      data-testid={testID}
      disabled={disabled}
      onClick={onPress}
    >
      {children}
    </button>
  ),
  NextLinkAnchor: ({
    href,
    children,
    ...rest
  }: SpanProps & { href?: string; "aria-label"?: string }) => (
    <a
      href={href}
      aria-label={rest["aria-label"]}
      data-testid={rest["data-testid"]}
    >
      {children}
    </a>
  ),
  Text: ({ children, testId, id, tone, ...rest }: SpanProps) => (
    <span
      data-testid={testId ?? rest["data-testid"]}
      id={id}
      data-tone={tone}
    >
      {children}
    </span>
  ),
  useFormatters: () => ({
    dateTime: (d: Date) => d.toISOString(),
    currency: (value: number, currency: string) => `${currency} ${value}`,
    locale: "en",
  }),
  useTranslations: () => (key: string) => key,
}));

vi.mock("lucide-react", () => ({ FileText: () => <span /> }));
// The deal's plain-words summary reads `deals.getTermsDeal`; its own logic is
// covered in `components/deals`. Here it is a slot.
vi.mock("@/components/deals", () => ({ DealSummary: () => null }));

import { BookingTermsStrip } from "../BookingTermsStrip";

const AGREEMENT_ID = "3ece7b10-ed96-4f13-b25e-867e1187b1bb";

/** The observed specimen: Sep 18 on file, seeded from the act's pitch. */
function agreementData(
  overrides: Record<string, unknown> = {},
  provenance: Record<string, boolean> | null = {
    proposedDate: true,
    proposedEndDate: true,
    guaranteeCents: true,
    description: false,
  },
  mayEdit = false,
) {
  return {
    agreement: {
      status: "ACCEPTED",
      proposedDate: new Date("2026-09-19T00:00:00.000Z"),
      proposedEndDate: new Date("2026-09-19T04:00:00.000Z"),
      guaranteeCents: 65000,
      ...overrides,
    },
    pitchProvenance: provenance,
    mayEdit,
  };
}

function resolved(data: unknown) {
  mocks.getUseQuery.mockReturnValue({
    data,
    error: null,
    isFetching: false,
    refetch: mocks.refetch,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("BookingTermsStrip", () => {
  it("issues exactly one agreement read, keyed on the agreement it was given", () => {
    resolved(agreementData());
    render(
      <BookingTermsStrip agreementId={AGREEMENT_ID} testIdBase="booking-thread" />,
    );
    expect(mocks.getUseQuery).toHaveBeenCalled();
    expect(mocks.getUseQuery.mock.calls[0]![0]).toEqual({
      agreementId: AGREEMENT_ID,
    });
    // A failed read must never interrupt the conversation with a toast.
    expect(mocks.getUseQuery.mock.calls[0]![1]).toMatchObject({
      retry: false,
      meta: { silent: true },
    });
  });

  it("shows the date, the end and the guarantee that actually bind", () => {
    resolved(agreementData());
    render(
      <BookingTermsStrip agreementId={AGREEMENT_ID} testIdBase="booking-thread" />,
    );

    // THE POINT OF THE SURFACE: Sep 18 (2026-09-19T00:00Z) is legible without
    // leaving the thread the Sep 25 conversation is happening in.
    expect(screen.getByTestId("booking-thread-terms-date").textContent).toContain(
      "2026-09-19T00:00:00.000Z",
    );
    expect(screen.getByTestId("booking-thread-terms-end").textContent).toContain(
      "2026-09-19T04:00:00.000Z",
    );
    expect(
      screen.getByTestId("booking-thread-terms-guarantee").textContent,
    ).toContain("USD 650");
  });

  it("routes to the one page where terms change, with a distinguishing name", () => {
    resolved(agreementData({ status: "DRAFT" }, null, true));
    render(
      <BookingTermsStrip
        agreementId={AGREEMENT_ID}
        nameSuffix="Neon Static"
        testIdBase="booking-thread"
      />,
    );

    const link = screen.getByTestId("booking-thread-terms-link");
    expect(link.getAttribute("href")).toBe(`/agreements/${AGREEMENT_ID}`);
    expect(link.getAttribute("aria-label")).toBe(
      "booking.termsChange — Neon Static",
    );
    // Read-only by contract: no composer, no save, nothing to type into.
    expect(document.querySelector("input")).toBeNull();
  });

  it("routes INTO the admin shell when mounted under one (the venue inbox)", () => {
    resolved(agreementData({ status: "DRAFT" }, null, true));
    render(
      <BookingTermsStrip
        agreementId={AGREEMENT_ID}
        adminSlug="acme"
        testIdBase="booking-thread"
      />,
    );

    expect(screen.getByTestId("booking-thread-terms-link").getAttribute("href")).toBe(
      `/admin/acme/bookings/agreement/${AGREEMENT_ID}`,
    );
    expect(document.querySelector("textarea")).toBeNull();
  });

  /**
   * `mayEdit` is DRAFT + edit-level access. Promising "Change terms" on an
   * agreement the destination page renders read-only would send someone to
   * hunt for a control that is not there.
   */
  it("drops the CHANGE verb when the viewer cannot actually edit", () => {
    resolved(agreementData());
    render(
      <BookingTermsStrip agreementId={AGREEMENT_ID} testIdBase="booking-thread" />,
    );
    expect(screen.getByTestId("booking-thread-terms-link").textContent).toBe(
      "booking.entryOpenAgreement",
    );
  });

  /**
   * `pitchProvenance` is the server's answer to "did the venue ever actually
   * choose this?", and on the specimen the answer for the date was no. The
   * chip marks the field; the sentence says what the mark means, because the
   * reader here is mid-conversation rather than looking at a form control.
   */
  it("marks values nobody has chosen and explains the mark once", () => {
    resolved(
      agreementData({}, {
        proposedDate: true,
        proposedEndDate: false,
        guaranteeCents: false,
        description: false,
      }),
    );
    render(
      <BookingTermsStrip agreementId={AGREEMENT_ID} testIdBase="booking-thread" />,
    );

    expect(screen.getByTestId("booking-thread-terms-date-pitch")).toBeTruthy();
    expect(screen.queryByTestId("booking-thread-terms-end-pitch")).toBeNull();
    expect(
      screen.queryByTestId("booking-thread-terms-guarantee-pitch"),
    ).toBeNull();
    expect(screen.getByTestId("booking-thread-terms-pitch-note")).toBeTruthy();
  });

  it("does not call a guarantee The deal sets the act's opening ask", () => {
    resolved({
      ...agreementData({}, {
        proposedDate: false,
        proposedEndDate: false,
        guaranteeCents: true,
        description: false,
      }),
      guaranteeFromDeal: true,
    });
    render(
      <BookingTermsStrip agreementId={AGREEMENT_ID} testIdBase="booking-thread" />,
    );
    expect(
      screen.queryByTestId("booking-thread-terms-guarantee-pitch"),
    ).toBeNull();
    expect(screen.queryByTestId("booking-thread-terms-pitch-note")).toBeNull();
  });

  it("stays quiet when nothing is attributable to the pitch", () => {
    resolved(agreementData({}, null));
    render(
      <BookingTermsStrip agreementId={AGREEMENT_ID} testIdBase="booking-thread" />,
    );
    expect(screen.queryByTestId("booking-thread-terms-date-pitch")).toBeNull();
    expect(screen.queryByTestId("booking-thread-terms-pitch-note")).toBeNull();
  });

  it("reads as history once the agreement has ended", () => {
    resolved(agreementData({ status: "DECLINED" }));
    render(
      <BookingTermsStrip agreementId={AGREEMENT_ID} testIdBase="booking-thread" />,
    );

    const strip = screen.getByTestId("booking-thread-terms");
    expect(strip.getAttribute("data-ended")).toBe("true");
    expect(screen.getByText("booking.termsHeadingEnded")).toBeTruthy();
    expect(screen.getByTestId("booking-thread-terms-ended-note")).toBeTruthy();
    // The forward-looking nudge and the change CTA both stand down.
    expect(screen.queryByTestId("booking-thread-terms-pitch-note")).toBeNull();
    expect(screen.getByTestId("booking-thread-terms-link").textContent).toBe(
      "booking.entryOpenAgreement",
    );
  });

  it("degrades to placeholders when the header holds nulls", () => {
    resolved(
      agreementData(
        { proposedDate: null, proposedEndDate: null, guaranteeCents: null },
        null,
      ),
    );
    render(
      <BookingTermsStrip agreementId={AGREEMENT_ID} testIdBase="booking-thread" />,
    );
    expect(screen.getByTestId("booking-thread-terms")).toBeTruthy();
    expect(
      screen.getByTestId("booking-thread-terms-guarantee").textContent,
    ).toContain("—");
  });

  it("renders no frame at all while the read is in flight", () => {
    mocks.getUseQuery.mockReturnValue({
      data: undefined,
      error: null,
      isFetching: true,
      refetch: mocks.refetch,
    });
    const { container } = render(
      <BookingTermsStrip agreementId={AGREEMENT_ID} testIdBase="booking-thread" />,
    );
    expect(container.innerHTML).toBe("");
  });

  /**
   * A failed read must not read as "this booking has no terms" — that is the
   * exact wrong conclusion on a surface built to stop people acting on terms
   * they have not seen.
   */
  it("admits the terms exist when the read fails, and offers a retry", () => {
    mocks.getUseQuery.mockReturnValue({
      data: undefined,
      error: new Error("boom"),
      isFetching: false,
      refetch: mocks.refetch,
    });
    render(
      <BookingTermsStrip agreementId={AGREEMENT_ID} testIdBase="booking-thread" />,
    );

    expect(screen.getByTestId("booking-thread-terms-error")).toBeTruthy();
    expect(screen.queryByTestId("booking-thread-terms")).toBeNull();
    fireEvent.click(screen.getByTestId("booking-thread-terms-retry"));
    expect(mocks.refetch).toHaveBeenCalledTimes(1);
  });
});
