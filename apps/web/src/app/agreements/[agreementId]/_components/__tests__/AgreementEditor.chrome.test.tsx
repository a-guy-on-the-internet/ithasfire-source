import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The editor's two frames, and the standalone page's redirect.
 *
 *  - `standalone` (the default) paints its own chrome — back-to-list link,
 *    eyebrow, status badge, title — exactly as before the `chrome` prop
 *    existed. The act's page.
 *  - `admin` paints NONE of it (the admin page carries identity), and the
 *    "not yours" CTA points at the booking inbox, not `/agreements`.
 *  - On `standalone`, an EDITOR-side viewer whose owner entities carry the
 *    editor party is replaced onto the admin route, and sees a spinner —
 *    never the standalone chrome — while that is decided. The act, and an
 *    editor with no matching entity, render in place.
 *
 * The negotiation sections are stubbed; each has its own suite.
 */

const mocks = vi.hoisted(() => ({
  getUseQuery: vi.fn(),
  replace: vi.fn(),
  owners: {
    ownersWithSlugs: undefined as unknown,
    data: undefined as unknown,
    isError: false,
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace, push: vi.fn() }),
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({ bookingAgreements: { get: { invalidate: vi.fn() } } }),
    bookingAgreements: {
      get: {
        useQuery: (input: unknown, opts: unknown) =>
          mocks.getUseQuery(input, opts),
      },
    },
    places: {
      getPlacePublic: { useQuery: () => ({ data: undefined }) },
    },
  },
}));

vi.mock("@/hooks/useEventOwnerEntities", () => ({
  useEventOwnerEntities: () => mocks.owners,
}));
// The bill and "The deal" (A3) have their own tests; this file is chrome.
vi.mock("@/components/deals", () => ({
  BillSection: () => null,
  DealEditor: () => null,
  ResaleClause: () => null,
  billSuggestionsOf: () => [],
}));

vi.mock("tamagui", () => {
  const Stack = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  return { XStack: Stack, YStack: Stack };
});

vi.mock("lucide-react", () => {
  const icon = () => <span aria-hidden="true" />;
  return { ArrowLeft: icon, FileLock2: icon, ShieldAlert: icon };
});

vi.mock("@th/ui", () => ({
  useTranslations: () => (key: string) => key,
  useNotify: () => ({
    toast: { success: vi.fn(), danger: vi.fn(), warning: vi.fn() },
  }),
  Spinner: () => <span data-testid="spinner" />,
  Badge: ({ children }: { children?: ReactNode }) => (
    <span data-testid="badge">{children}</span>
  ),
  Button: ({ children }: { children?: ReactNode }) => (
    <button>{children}</button>
  ),
  Text: ({ children, variant }: { children?: ReactNode; variant?: string }) =>
    variant === "h2" ? <h2>{children}</h2> : <span>{children}</span>,
  NextLinkAnchor: ({
    href,
    children,
  }: {
    href: string;
    children?: ReactNode;
  }) => <a href={href}>{children}</a>,
}));

vi.mock("../NegotiationBar", () => ({
  NegotiationBar: () => <div data-testid="negotiation-bar" />,
}));
vi.mock("../AgreementHeaderCard", () => ({
  AgreementHeaderCard: () => <div data-testid="header-card" />,
}));
vi.mock("../PayoutLinesSection", () => ({
  PayoutLinesSection: () => <div data-testid="payout-lines" />,
}));
vi.mock("../FinalizeDialog", () => ({
  FinalizeDialog: () => null,
}));

import { AgreementEditor } from "../AgreementEditor";

const AGREEMENT_ID = "0d3c0b6e-1111-4c1a-9a1e-000000000001";

const ORG_OWNER = {
  kind: "org",
  orgId: "org-1",
  orgName: "Greek Theatre",
  orgSlug: "greek",
  role: "ADMIN",
  avatarUrl: null,
  adminSlug: "greek",
};
const HUMAN_OWNER = {
  kind: "human",
  humanId: "hum-1",
  humanName: "Alice",
  humanUsername: "alice",
  avatarUrl: null,
  adminSlug: "@alice",
};

function loaded(overrides: Record<string, unknown> = {}) {
  return {
    isLoading: false,
    error: null,
    refetch: vi.fn(),
    data: {
      agreement: {
        id: AGREEMENT_ID,
        title: "Booking — Greek Theatre",
        status: "DRAFT",
        placeId: null,
        eventId: null,
        proposerType: "organization",
        proposerId: "org-1",
        counterpartyType: "human",
        counterpartyId: "act-9",
      },
      lines: [],
      bookingRequest: null,
      pitchProvenance: null,
      event: null,
      actorSide: "proposer",
      viewerSide: "editor",
      viewerCanEditTerms: true,
      mayEdit: true,
      ...overrides,
    },
  };
}

function ownersLoaded(list: unknown[]) {
  mocks.owners.ownersWithSlugs = list.length ? list : undefined;
  mocks.owners.data = { owners: list };
  mocks.owners.isError = false;
}

beforeEach(() => {
  mocks.getUseQuery.mockReset();
  mocks.replace.mockReset();
  mocks.owners.ownersWithSlugs = undefined;
  mocks.owners.data = undefined;
  mocks.owners.isError = false;
});

describe("AgreementEditor — standalone chrome (the act's page)", () => {
  it("paints back-to-list, eyebrow, badge and title, and never redirects", () => {
    mocks.getUseQuery.mockReturnValue(
      loaded({
        actorSide: "counterparty",
        viewerSide: "act",
        viewerCanEditTerms: false,
        mayEdit: false,
      }),
    );
    ownersLoaded([HUMAN_OWNER]);
    const { container } = render(
      <AgreementEditor agreementId={AGREEMENT_ID} />,
    );

    expect(
      container.querySelector('a[href="/account/settings/booking-requests"]'),
    ).not.toBeNull();
    expect(screen.getByText("admin.baEditorEyebrow")).toBeInTheDocument();
    expect(screen.getByTestId("badge")).toHaveTextContent(
      "admin.baStatusDraft",
    );
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
      "Booking — Greek Theatre",
    );
    expect(screen.getByTestId("negotiation-bar")).toBeInTheDocument();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("renders in place for a HUMAN party of a request-less agreement (viewerSide null)", () => {
    mocks.getUseQuery.mockReturnValue(
      loaded({
        viewerSide: null,
        actorSide: "counterparty",
        agreement: {
          id: AGREEMENT_ID,
          title: "Booking — Greek Theatre",
          status: "DRAFT",
          placeId: null,
          eventId: null,
          proposerType: "organization",
          proposerId: "org-1",
          counterpartyType: "human",
          counterpartyId: "hum-1",
        },
      }),
    );
    ownersLoaded([HUMAN_OWNER]);
    render(<AgreementEditor agreementId={AGREEMENT_ID} />);

    expect(screen.getByRole("heading", { level: 2 })).toBeInTheDocument();
    expect(mocks.replace).not.toHaveBeenCalled();
  });
});

describe("AgreementEditor — the standalone redirect for the editor party", () => {
  it("shows a spinner, not the chrome, while the owner entities are unknown", () => {
    mocks.getUseQuery.mockReturnValue(loaded());
    render(<AgreementEditor agreementId={AGREEMENT_ID} />);

    expect(screen.getByTestId("spinner")).toBeInTheDocument();
    expect(screen.queryByRole("heading")).toBeNull();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("replaces onto the admin route once the editor party matches an owner entity", () => {
    mocks.getUseQuery.mockReturnValue(loaded());
    ownersLoaded([HUMAN_OWNER, ORG_OWNER]);
    render(<AgreementEditor agreementId={AGREEMENT_ID} />);

    expect(mocks.replace).toHaveBeenCalledWith(
      `/admin/greek/bookings/agreement/${AGREEMENT_ID}`,
    );
    // Still a spinner — the standalone chrome never flashes before the move.
    expect(screen.getByTestId("spinner")).toBeInTheDocument();
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("moves an ORGANIZATION acting as the performer into its own admin", () => {
    mocks.getUseQuery.mockReturnValue(
      loaded({
        viewerSide: "act",
        actorSide: "counterparty",
        viewerCanEditTerms: false,
        mayEdit: false,
        agreement: {
          id: AGREEMENT_ID,
          title: "Booking — Greek Theatre",
          status: "PROPOSED",
          placeId: null,
          eventId: null,
          proposerType: "human",
          proposerId: "venue-owner",
          counterpartyType: "organization",
          counterpartyId: "org-1",
        },
      }),
    );
    ownersLoaded([HUMAN_OWNER, ORG_OWNER]);
    render(<AgreementEditor agreementId={AGREEMENT_ID} />);

    expect(mocks.replace).toHaveBeenCalledWith(
      `/admin/greek/bookings/agreement/${AGREEMENT_ID}`,
    );
    expect(screen.getByTestId("spinner")).toBeInTheDocument();
  });

  it("stays put when the editor has no matching entity (place grant, no membership)", () => {
    mocks.getUseQuery.mockReturnValue(loaded());
    ownersLoaded([HUMAN_OWNER]);
    render(<AgreementEditor agreementId={AGREEMENT_ID} />);

    expect(mocks.replace).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { level: 2 })).toBeInTheDocument();
  });

  it("stays put, rather than spinning forever, when the owners read failed", () => {
    mocks.getUseQuery.mockReturnValue(loaded());
    mocks.owners.isError = true;
    render(<AgreementEditor agreementId={AGREEMENT_ID} />);

    expect(mocks.replace).not.toHaveBeenCalled();
    expect(screen.queryByTestId("spinner")).toBeNull();
    expect(screen.getByRole("heading", { level: 2 })).toBeInTheDocument();
  });
});

describe("AgreementEditor — admin chrome", () => {
  it("paints no back link, eyebrow, badge or title (the admin page carries them)", () => {
    mocks.getUseQuery.mockReturnValue(loaded());
    ownersLoaded([HUMAN_OWNER, ORG_OWNER]);
    const { container } = render(
      <AgreementEditor
        agreementId={AGREEMENT_ID}
        chrome="admin"
        adminSlug="greek"
      />,
    );

    expect(container.querySelector("a")).toBeNull();
    expect(screen.queryByText("admin.baEditorEyebrow")).toBeNull();
    expect(screen.queryByTestId("badge")).toBeNull();
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.getByTestId("negotiation-bar")).toBeInTheDocument();
    expect(screen.getByTestId("header-card")).toBeInTheDocument();
    expect(screen.getByTestId("payout-lines")).toBeInTheDocument();
    // The admin route IS the destination — no redirect from here.
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("points the 'not yours' CTA at the booking inbox, standalone at settings → Booking requests", () => {
    mocks.getUseQuery.mockReturnValue({
      isLoading: false,
      data: undefined,
      error: { data: { code: "FORBIDDEN" } },
      refetch: vi.fn(),
    });
    const admin = render(
      <AgreementEditor
        agreementId={AGREEMENT_ID}
        chrome="admin"
        adminSlug="greek"
      />,
    );
    expect(
      admin.container.querySelector('a[href="/admin/greek/bookings"]'),
    ).not.toBeNull();
    expect(screen.getByText("admin.baAdminBackToBookings")).toBeInTheDocument();
    admin.unmount();

    const standalone = render(<AgreementEditor agreementId={AGREEMENT_ID} />);
    expect(
      standalone.container.querySelector(
        'a[href="/account/settings/booking-requests"]',
      ),
    ).not.toBeNull();
    expect(screen.getByText("admin.baBackToList")).toBeInTheDocument();
  });
});
