import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

/**
 * The `embedded` contract, pinned.
 *
 * Both of these sections were born as STANDALONE surfaces that draw their own
 * bordered card — `VerificationSection` is the whole of `/verify`, and the
 * ownership regions were the whole of the place editor's settings aside. The
 * merged venue-settings page hosts them inside a `PlaceEditSection`, which is
 * itself a `borderWidth={2}` card, and a card inside a card is the one thing
 * strict Swiss forbids outright. `embedded` is how the host takes the frame
 * back — the same prop, with the same meaning, that
 * `AttendeeReviewsPublicToggle` already carries.
 *
 * WHAT THIS CANNOT SEE. The design system is mocked away, so this asserts the
 * PROPS that draw the frame, not the pixels. That is the honest limit of a
 * unit test here: the real check is loading the page.
 */

// Stacks that publish the frame-drawing props as DOM attributes. A stand-in
// that swallowed them would make "the card is dropped" unassertable — and
// would stay green if it never was.
vi.mock("tamagui", () => {
  const Stack = ({
    children,
    borderWidth,
    borderTopWidth,
    padding,
    backgroundColor,
  }: {
    children?: ReactNode;
    borderWidth?: number;
    borderTopWidth?: number;
    padding?: string;
    backgroundColor?: string;
  }) => (
    <div
      data-border-width={borderWidth}
      data-border-top-width={borderTopWidth}
      data-padding={padding}
      data-background={backgroundColor}
    >
      {children}
    </div>
  );
  return {
    YStack: Stack,
    XStack: Stack,
    useTheme: () => ({
      danger: { val: "#B93312" },
      warning: { val: "#F59E0B" },
      success: { val: "#1F7A4D" },
      info: { val: "#35589A" },
    }),
  };
});

vi.mock("@th/ui", () => ({
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Badge: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Button: ({ children }: { children?: ReactNode }) => (
    <button type="button">{children}</button>
  ),
  NextLinkAnchor: ({
    href,
    children,
  }: {
    href: string;
    children?: ReactNode;
  }) => <a href={href}>{children}</a>,
  useNotify: () => ({ toast: { success: vi.fn(), danger: vi.fn() } }),
  useTranslations: () => (key: string) => key,
}));

/** Captures what the platform queue read was asked for. */
const queueQueryOptions = vi.fn();

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      places: {
        getPlaceForEdit: { invalidate: vi.fn() },
        getPlaceDetail: { invalidate: vi.fn() },
        getPlaceTitle: { invalidate: vi.fn() },
        listHumanPlaces: { invalidate: vi.fn() },
      },
    }),
    places: {
      getPlaceDetail: {
        useQuery: () => ({ data: undefined }),
      },
      getPlatformVerificationQueue: {
        useQuery: (input: unknown, options: unknown) => {
          queueQueryOptions({ input, options });
          return { data: undefined };
        },
      },
      withdrawPlaceVerification: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
    },
  },
}));

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: () => "boom",
}));

vi.mock(
  "@/app/admin/[slug]/places/_components/VerificationRequestForm",
  () => ({
    VerificationRequestForm: () => <div data-testid="verification-form" />,
  }),
);

import { VerificationSection } from "../VerificationSection";
import { OwnershipStatusSection } from "../OwnershipStatusSection";

const PLACE_ID = "44444444-4444-4444-8444-444444444444";

const PLACE = {
  placeId: PLACE_ID,
  name: "The Basement",
  addressLine1: "123 Main St",
  city: "Nashville",
  countryCode: "US",
  verificationStatus: "UNVERIFIED" as const,
  access: { orgIds: ["org-1"], humanIds: [] },
};

const FORM_STATE = {
  name: "The Basement",
  addressLine1: "123 Main St",
  city: "Nashville",
  countryCode: "US",
};

/** Every node the stacks drew a 2px border on — i.e. every card. */
const cards = (container: HTMLElement) =>
  container.querySelectorAll('[data-border-width="2"]');

describe("VerificationSection — embedded drops the card, default keeps it", () => {
  it("draws its own bordered, padded, filled card by default", () => {
    const { container } = render(
      <VerificationSection
        place={PLACE}
        formState={FORM_STATE}
        isDirty={false}
        placeId={PLACE_ID}
      />,
    );

    const root = container.firstElementChild!;
    expect(root.getAttribute("data-border-width")).toBe("2");
    expect(root.getAttribute("data-padding")).toBe("$4");
    expect(root.getAttribute("data-background")).toBe("$surface");
  });

  it("draws NO card when embedded — the host section owns the frame", () => {
    const { container } = render(
      <VerificationSection
        place={PLACE}
        formState={FORM_STATE}
        isDirty={false}
        placeId={PLACE_ID}
        embedded
      />,
    );

    const root = container.firstElementChild!;
    expect(root.getAttribute("data-border-width")).toBeNull();
    expect(root.getAttribute("data-padding")).toBeNull();
    expect(root.getAttribute("data-background")).toBeNull();
  });

  it("renders the same content either way, minus the heading the host already carries", () => {
    const standalone = render(
      <VerificationSection
        place={PLACE}
        formState={FORM_STATE}
        isDirty={false}
        placeId={PLACE_ID}
      />,
    );
    const standaloneText = standalone.container.textContent;
    standalone.unmount();

    const { container } = render(
      <VerificationSection
        place={PLACE}
        formState={FORM_STATE}
        isDirty={false}
        placeId={PLACE_ID}
        embedded
      />,
    );

    // Embedded, the host section's own heading already reads
    // "Verification", so the section drops its inner copy (a stutter
    // otherwise). Everything else — badge, hints, actions — is identical.
    expect(standaloneText).toContain("admin.placeVerifHeading");
    expect(container.textContent).not.toContain("admin.placeVerifHeading");
    expect(container.textContent).toBe(
      standaloneText?.replace("admin.placeVerifHeading", ""),
    );
  });

  it("keeps the platform queue read GATED and silent in both variants", () => {
    // A `limit: 100` platform-wide read that exists to compute ONE ordinal.
    // Letting it fire for a venue that has no pending request — which is most
    // of them — would put a queue scan behind every visit to this section.
    for (const embedded of [false, true]) {
      queueQueryOptions.mockClear();

      const { unmount } = render(
        <VerificationSection
          place={PLACE}
          formState={FORM_STATE}
          isDirty={false}
          placeId={PLACE_ID}
          embedded={embedded}
        />,
      );

      const call = queueQueryOptions.mock.calls[0]![0] as {
        input: { statuses: string[]; limit: number };
        options: { enabled: boolean; meta: { silent: boolean } };
      };
      // UNVERIFIED, no active request ⇒ the query must not run.
      expect(call.options.enabled, `embedded=${embedded}`).toBe(false);
      expect(call.options.meta.silent, `embedded=${embedded}`).toBe(true);
      expect(call.input.limit).toBe(100);

      unmount();
    }
  });
});

describe("OwnershipStatusSection — embedded drops the panel and leads with a rule", () => {
  const OWNERS = [
    {
      kind: "ORGANIZATION" as const,
      id: "org-1",
      name: "Basement Collective",
      pageSlug: "basement-collective",
    },
  ];

  it("draws one bordered panel by default, with no rule above the first region", () => {
    const { container } = render(
      <OwnershipStatusSection
        placeId={PLACE_ID}
        owners={OWNERS}
        status="ACTIVE"
        listedInDirectory
      />,
    );

    expect(cards(container)).toHaveLength(1);
    // First region inside the panel = the ownership one; a divider above it
    // would be decoration, not separation.
    const firstRegion = container.firstElementChild!.firstElementChild!;
    expect(firstRegion.getAttribute("data-border-top-width")).toBeNull();
  });

  it("draws NO panel when embedded, and rules the first region off from what precedes it", () => {
    const { container } = render(
      <OwnershipStatusSection
        placeId={PLACE_ID}
        owners={OWNERS}
        status="ACTIVE"
        listedInDirectory
        embedded
      />,
    );

    expect(cards(container)).toHaveLength(0);
    // Embedded there IS something above (the aside's verification region), so
    // the rule separates rather than decorates.
    expect(
      container.firstElementChild!.getAttribute("data-border-top-width"),
    ).toBe("1");
  });

  it("renders the same content either way", () => {
    const standalone = render(
      <OwnershipStatusSection
        placeId={PLACE_ID}
        owners={OWNERS}
        status="ACTIVE"
        listedInDirectory
      />,
    );
    const standaloneText = standalone.container.textContent;
    standalone.unmount();

    const { container } = render(
      <OwnershipStatusSection
        placeId={PLACE_ID}
        owners={OWNERS}
        status="ACTIVE"
        listedInDirectory
        embedded
      />,
    );

    expect(container.textContent).toBe(standaloneText);
  });
});
