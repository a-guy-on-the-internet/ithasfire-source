import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The agreement editor under the admin: pins the page's COMPOSITION —
 *
 *   • the back link targets the booking the agreement came from
 *     (`?request=`), and the inbox itself when there is no request;
 *   • title + status badge + stage rail render from `bookingAgreements.get`,
 *     with the rail fed the same triple the inbox row gets (`event` wins
 *     over the bare `agreement.eventId`);
 *   • the editor is mounted in `admin` chrome with the slug for its own
 *     back-CTAs — so the page never carries two titles or two badges;
 *   • nothing identity-shaped renders before the read resolves.
 *
 * The editor and the rail are stubbed — each has its own suite.
 */

const mocks = vi.hoisted(() => ({
  getUseQuery: vi.fn(),
  editorProps: vi.fn(),
  railProps: vi.fn(),
  replace: vi.fn(),
  currentOwner: null as unknown,
  owners: undefined as unknown,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace, push: vi.fn() }),
}));

vi.mock("@/hooks/useCurrentAdminOwner", () => ({
  useCurrentAdminOwner: () => ({
    currentOwner: mocks.currentOwner,
    ownerEntities: { ownersWithSlugs: mocks.owners },
  }),
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
    [k: string]: unknown;
  }) => (
    <div data-testid={rest["data-testid"] as string | undefined}>
      {children}
    </div>
  );
  return { XStack: Stack, YStack: Stack, styled: () => Stack };
});

vi.mock("lucide-react", () => ({
  ArrowLeft: () => <span aria-hidden="true" />,
}));

vi.mock("@th/ui", () => ({
  useTranslations: () => (key: string) => key,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Badge: ({
    children,
    ...rest
  }: {
    children?: ReactNode;
    [k: string]: unknown;
  }) => (
    <span data-testid={rest["data-testid"] as string | undefined}>
      {children}
    </span>
  ),
  NextLinkAnchor: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children?: ReactNode;
    [k: string]: unknown;
  }) => (
    <a href={href} data-testid={rest["data-testid"] as string | undefined}>
      {children}
    </a>
  ),
}));

vi.mock("@/app/admin/[slug]/_components/AdminPageHeader", () => ({
  AdminPageHeader: ({
    title,
    subtitle,
    trailing,
  }: {
    title: string;
    subtitle?: string;
    trailing?: ReactNode;
  }) => (
    <header>
      <h2>{title}</h2>
      <p>{subtitle}</p>
      {trailing}
    </header>
  ),
}));

vi.mock("@/app/agreements/[agreementId]/_components/AgreementEditor", () => ({
  AgreementEditor: (props: Record<string, unknown>) => {
    mocks.editorProps(props);
    return <div data-testid="editor-stub" />;
  },
}));

vi.mock("@/components/bookings/BookingStageRail", () => ({
  BookingStageRail: (props: Record<string, unknown>) => {
    mocks.railProps(props);
    return <div data-testid="rail-stub" />;
  },
}));

import { AdminAgreementPage } from "../_components/AdminAgreementPage";

const AGREEMENT_ID = "0d3c0b6e-1111-4c1a-9a1e-000000000001";

const GREEK = {
  kind: "org",
  orgId: "org-greek",
  orgName: "Greek Theatre",
  orgSlug: "greek",
  role: "ADMIN",
  avatarUrl: null,
  adminSlug: "greek",
};
const OTHER = {
  kind: "org",
  orgId: "org-other",
  orgName: "Other Org",
  orgSlug: "other",
  role: "ADMIN",
  avatarUrl: null,
  adminSlug: "other",
};

function agreementData(overrides: Record<string, unknown> = {}) {
  return {
    agreement: {
      id: AGREEMENT_ID,
      title: "Booking — Greek Theatre",
      status: "DRAFT",
      eventId: null,
      proposerType: "organization",
      proposerId: "org-greek",
      counterpartyType: "human",
      counterpartyId: "act-9",
    },
    actorSide: "proposer",
    bookingRequest: {
      id: "req-1",
      status: "ACCEPTED",
      preferredDates: ["2026-09-18"],
    },
    event: null,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.getUseQuery.mockReset();
  mocks.editorProps.mockReset();
  mocks.railProps.mockReset();
  mocks.replace.mockReset();
  mocks.currentOwner = GREEK;
  mocks.owners = [GREEK, OTHER];
});

describe("AdminAgreementPage", () => {
  it("renders nothing identity-shaped before the read resolves, but mounts the editor", () => {
    mocks.getUseQuery.mockReturnValue({ data: undefined, isLoading: true });
    render(<AdminAgreementPage slug="greek" agreementId={AGREEMENT_ID} />);

    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.queryByTestId("rail-stub")).toBeNull();
    expect(screen.getByTestId("editor-stub")).toBeInTheDocument();
    // Back link still works — to the inbox, since the request is unknown.
    expect(screen.getByTestId("admin-agreement-back")).toHaveAttribute(
      "href",
      "/admin/greek/bookings",
    );
  });

  it("links back to the booking, titles the page once, and badges the status once", () => {
    mocks.getUseQuery.mockReturnValue({
      data: agreementData(),
      isLoading: false,
    });
    render(<AdminAgreementPage slug="greek" agreementId={AGREEMENT_ID} />);

    expect(mocks.getUseQuery).toHaveBeenCalledWith(
      { agreementId: AGREEMENT_ID },
      expect.objectContaining({ retry: false }),
    );
    expect(screen.getByTestId("admin-agreement-back")).toHaveAttribute(
      "href",
      "/admin/greek/bookings?request=req-1",
    );
    expect(screen.getAllByRole("heading")).toHaveLength(1);
    expect(screen.getByRole("heading")).toHaveTextContent(
      "Booking — Greek Theatre",
    );
    expect(screen.getAllByTestId("admin-agreement-status")).toHaveLength(1);
    expect(screen.getByTestId("admin-agreement-status")).toHaveTextContent(
      "admin.baStatusDraft",
    );
  });

  it("mounts the editor in admin chrome with the slug for its own back-CTAs", () => {
    mocks.getUseQuery.mockReturnValue({
      data: agreementData(),
      isLoading: false,
    });
    render(<AdminAgreementPage slug="greek" agreementId={AGREEMENT_ID} />);

    expect(mocks.editorProps).toHaveBeenCalledWith({
      agreementId: AGREEMENT_ID,
      chrome: "admin",
      adminSlug: "greek",
    });
  });

  it("feeds the full stage rail the inbox row's triple, event winning over the bare link", () => {
    mocks.getUseQuery.mockReturnValue({
      data: agreementData({
        agreement: {
          id: AGREEMENT_ID,
          title: "T",
          status: "FULFILLED",
          eventId: "ev-old",
        },
        event: {
          id: "ev-1",
          status: "PUBLISHED",
          startsAt: new Date("2026-09-25T02:00:00Z"),
        },
      }),
      isLoading: false,
    });
    render(<AdminAgreementPage slug="greek" agreementId={AGREEMENT_ID} />);

    expect(mocks.railProps).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: "full",
        status: "ACCEPTED",
        agreementStatus: "FULFILLED",
        eventId: "ev-1",
        eventStatus: "PUBLISHED",
        eventStartsAt: new Date("2026-09-25T02:00:00Z"),
        preferredDates: ["2026-09-18"],
        testIdBase: "admin-agreement",
      }),
    );
  });

  it("stays, with the booking back link, when the shell IS the party's own", () => {
    mocks.getUseQuery.mockReturnValue({
      data: agreementData(),
      isLoading: false,
    });
    render(<AdminAgreementPage slug="greek" agreementId={AGREEMENT_ID} />);

    expect(mocks.replace).not.toHaveBeenCalled();
    expect(screen.getByTestId("admin-agreement-back")).toHaveAttribute(
      "href",
      "/admin/greek/bookings?request=req-1",
    );
  });

  it("relocates under the party's own slug when opened from another org's shell", () => {
    mocks.currentOwner = OTHER;
    mocks.getUseQuery.mockReturnValue({
      data: agreementData(),
      isLoading: false,
    });
    render(<AdminAgreementPage slug="other" agreementId={AGREEMENT_ID} />);

    expect(mocks.replace).toHaveBeenCalledWith(
      `/admin/greek/bookings/agreement/${AGREEMENT_ID}`,
    );
  });

  it("falls back to the bare inbox link when the shell is wrong and the viewer has no slug for the party", () => {
    // Party through a place grant: the viewer's entities carry neither org.
    mocks.currentOwner = OTHER;
    mocks.owners = [OTHER];
    mocks.getUseQuery.mockReturnValue({
      data: agreementData(),
      isLoading: false,
    });
    render(<AdminAgreementPage slug="other" agreementId={AGREEMENT_ID} />);

    expect(mocks.replace).not.toHaveBeenCalled();
    expect(screen.getByTestId("admin-agreement-back")).toHaveAttribute(
      "href",
      "/admin/other/bookings",
    );
  });

  it("does not judge the shell before the owner is known", () => {
    mocks.currentOwner = null;
    mocks.getUseQuery.mockReturnValue({
      data: agreementData(),
      isLoading: false,
    });
    render(<AdminAgreementPage slug="greek" agreementId={AGREEMENT_ID} />);

    expect(mocks.replace).not.toHaveBeenCalled();
    expect(screen.getByTestId("admin-agreement-back")).toHaveAttribute(
      "href",
      "/admin/greek/bookings?request=req-1",
    );
  });

  it("draws no rail for an agreement with no originating request", () => {
    mocks.getUseQuery.mockReturnValue({
      data: agreementData({ bookingRequest: null }),
      isLoading: false,
    });
    render(<AdminAgreementPage slug="greek" agreementId={AGREEMENT_ID} />);

    expect(screen.queryByTestId("rail-stub")).toBeNull();
    expect(screen.getByTestId("admin-agreement-back")).toHaveAttribute(
      "href",
      "/admin/greek/bookings",
    );
  });
});
