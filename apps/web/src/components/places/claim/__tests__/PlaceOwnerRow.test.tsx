/**
 * PlaceOwnerRow — the claimed-venue "Owned by {name} · Request transfer" row
 * (FR-008 / FR-009).
 *
 * Pins what the server contract makes possible: an ORG owner links to
 * /orgs/{slug}, a HUMAN owner links to /humans/{slug}, a hidden owner degrades
 * to the unnamed "Verified owner" row, and an unclaimed venue renders NOTHING.
 * Plus the transfer button's accessible name (WCAG 2.5.3 Label in Name) and
 * the dispute-dialog auth handling (signed-out → sign-in overlay in place,
 * signed-in → the shared dialog).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";

import enMessages from "@/i18n/messages/en";
import esMessages from "@/i18n/messages/es";

/**
 * Read `places.<key>` out of a real catalog. The catalog type is a recursive
 * `MessageNode`, so this narrows to string AND asserts the key still exists —
 * deleting or nesting it fails the test loudly instead of silently comparing
 * `undefined`.
 */
function placesString(
  catalog: typeof enMessages,
  key: string,
): string {
  const section = (catalog as unknown as Record<string, unknown>).places as
    | Record<string, unknown>
    | undefined;
  const value = section?.[key];
  if (typeof value !== "string") {
    throw new Error(`Expected catalog string at places.${key}`);
  }
  return value;
}

vi.mock("@th/ui", () => ({
  useTranslations:
    () =>
    (key: string, args?: Record<string, unknown>) =>
      args ? `${key}:${JSON.stringify(args)}` : key,
  // Stand-in for the design-system link adapter: a real <a> so the rendered
  // href is assertable (the real one resolves next/link at runtime).
  NextLinkAnchor: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/places/velvet-room",
}));

const sessionState = { data: null as { user: { id: string } } | null };
vi.mock("@/lib/auth/auth-client", () => ({
  authClient: { useSession: () => sessionState },
}));

const mockShowSignInOverlay = vi.fn();
vi.mock("@/components/layout/AppOverlayProvider", () => ({
  useAppOverlay: () => ({ showSignInOverlay: mockShowSignInOverlay }),
}));

type Eligibility = {
  state: string;
  owner: {
    type: "HUMAN" | "ORGANIZATION";
    displayName: string;
    pageSlug: string | null;
  } | null;
} | null;

const eligibilityState: { current: Eligibility } = { current: null };
vi.mock("@/trpc", () => ({
  trpc: {
    places: {
      getPlaceClaimEligibility: {
        useQuery: () => ({ data: eligibilityState.current, refetch: vi.fn() }),
      },
    },
  },
}));

type DisputeProps = { open: boolean; placeId: string; placeName: string };
const disputeProps: { current: DisputeProps | null } = { current: null };
vi.mock("../OwnershipDisputeDialog", () => ({
  OwnershipDisputeDialog: (props: DisputeProps) => {
    disputeProps.current = props;
    return <div data-testid="dispute-dialog" />;
  },
}));

import { PlaceOwnerRow } from "../PlaceOwnerRow";

const PLACE_ID = "11111111-1111-4111-8111-111111111111";
const props = { placeId: PLACE_ID, placeName: "The Velvet Room" };

describe("PlaceOwnerRow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionState.data = null;
    eligibilityState.current = null;
    disputeProps.current = null;
    cleanup();
  });

  it("renders nothing for an UNCLAIMED venue", () => {
    eligibilityState.current = { state: "claimable", owner: null };

    const { container } = render(<PlaceOwnerRow {...props} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing while the eligibility query is still loading", () => {
    eligibilityState.current = null;

    const { container } = render(<PlaceOwnerRow {...props} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("links an ORGANIZATION owner to /orgs/{slug}", () => {
    eligibilityState.current = {
      state: "already_claimed",
      owner: {
        type: "ORGANIZATION",
        displayName: "Bay Area Festivals",
        pageSlug: "bay-area-festivals",
      },
    };

    const { getByRole } = render(<PlaceOwnerRow {...props} />);

    const link = getByRole("link", { name: "Bay Area Festivals" });
    expect(link).toHaveAttribute("href", "/orgs/bay-area-festivals");
  });

  it("links a HUMAN owner to /humans/{slug}", () => {
    eligibilityState.current = {
      state: "already_claimed",
      owner: {
        type: "HUMAN",
        displayName: "Morgan Kowalski",
        pageSlug: "morgan-kowalski",
      },
    };

    const { getByRole } = render(<PlaceOwnerRow {...props} />);

    expect(getByRole("link", { name: "Morgan Kowalski" })).toHaveAttribute(
      "href",
      "/humans/morgan-kowalski",
    );
  });

  it("gives the transfer button an accessible name that CONTAINS the visible label (WCAG 2.5.3)", () => {
    // The aria-label disambiguates which venue, but overriding the accessible
    // name with a string that does NOT contain the visible label breaks voice
    // control ("click request transfer" matches nothing). Asserted against the
    // REAL catalogs, not the key-echo mock, so a future copy edit that drops
    // the prefix fails here.
    const visible = placesString(enMessages, "ownerRowRequestTransfer");
    const accessible = placesString(enMessages, "ownerRowRequestTransferAria");
    const esVisible = placesString(esMessages, "ownerRowRequestTransfer");
    const esAccessible = placesString(
      esMessages,
      "ownerRowRequestTransferAria",
    );

    expect(accessible).toContain(visible);
    expect(esAccessible).toContain(esVisible);
    // …and the disambiguator survives: it is a SUPERSET, not a copy.
    expect(accessible).not.toBe(visible);
    expect(accessible).toContain("{name}");
    expect(esAccessible).toContain("{name}");
  });

  it("renders the transfer control as a button whose label is the visible text", () => {
    eligibilityState.current = {
      state: "already_claimed",
      owner: {
        type: "ORGANIZATION",
        displayName: "Bay Area Festivals",
        pageSlug: "bay-area-festivals",
      },
    };

    const { getByRole } = render(<PlaceOwnerRow {...props} />);

    // The mocked `t` echoes the key + args, so the rendered accessible name is
    // the aria key; what matters structurally is that exactly one button
    // carries it and the visible text node is the plain label key.
    const button = getByRole("button");
    expect(button.getAttribute("aria-label")).toContain(
      "places.ownerRowRequestTransferAria",
    );
    expect(button.textContent).toContain("places.ownerRowRequestTransfer");
  });

  it("falls back to the unnamed label when the owner cannot be named", () => {
    eligibilityState.current = { state: "already_claimed", owner: null };

    const { getByText, getByRole } = render(<PlaceOwnerRow {...props} />);

    expect(getByText("places.ownerRowUnnamed")).toBeInTheDocument();
    // The transfer action still renders — a nameless owner is still an owner.
    expect(getByRole("button")).toBeInTheDocument();
  });

  it("signed-out: the transfer action opens the sign-in overlay in place", () => {
    eligibilityState.current = {
      state: "already_claimed",
      owner: {
        type: "ORGANIZATION",
        displayName: "Bay Area Festivals",
        pageSlug: "bay-area-festivals",
      },
    };

    const { getByRole } = render(<PlaceOwnerRow {...props} />);
    fireEvent.click(getByRole("button"));

    expect(mockShowSignInOverlay).toHaveBeenCalledWith({
      redirect: "/places/velvet-room",
    });
    // Signed out → the dispute dialog is not even mounted.
    expect(disputeProps.current).toBeNull();
  });

  it("signed-in: the transfer action opens the shared dispute dialog", () => {
    sessionState.data = { user: { id: "human-1" } };
    eligibilityState.current = {
      state: "already_claimed",
      owner: {
        type: "ORGANIZATION",
        displayName: "Bay Area Festivals",
        pageSlug: "bay-area-festivals",
      },
    };

    const { getByRole } = render(<PlaceOwnerRow {...props} />);

    expect(disputeProps.current).toMatchObject({
      placeId: PLACE_ID,
      placeName: "The Velvet Room",
      open: false,
    });

    fireEvent.click(getByRole("button"));

    expect(disputeProps.current?.open).toBe(true);
    expect(mockShowSignInOverlay).not.toHaveBeenCalled();
  });
});
