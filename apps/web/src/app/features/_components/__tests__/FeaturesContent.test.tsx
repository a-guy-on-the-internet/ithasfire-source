import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FeatureGatesSnapshot } from "@/lib/feature-gates/types";

let mockGates: FeatureGatesSnapshot | undefined;

vi.mock("@/hooks/useFeatureGates", () => ({
  useFeatureGates: () => ({
    gates: mockGates,
    isLoading: mockGates === undefined,
  }),
}));

// Key-echoing translator so assertions can target stable i18n keys.
vi.mock("@th/ui", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/components/layout/PagePrimitives", () => {
  const passthrough = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  const NumberedSection = ({
    title,
    children,
  }: {
    title?: string;
    children?: ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  );
  const CardBody = ({
    title,
    description,
  }: {
    title?: string;
    description?: string;
  }) => (
    <div>
      <span>{title}</span>
      <span>{description}</span>
    </div>
  );
  const ButtonLink = ({
    children,
    href,
  }: {
    children?: ReactNode;
    href?: string;
  }) => <a href={href}>{children}</a>;
  return {
    PageContainer: passthrough,
    AutoGrid: passthrough,
    Card: passthrough,
    IconCircle: () => null,
    MutedText: passthrough,
    ButtonRow: passthrough,
    ButtonPrimary: ButtonLink,
    ButtonOutline: ButtonLink,
    CardBody,
    NumberedSection,
    AsymmetricGrid: passthrough,
    DisplayHeading: passthrough,
    Overline: passthrough,
    Stripe: () => <hr />,
  };
});

import { FeaturesContent } from "../FeaturesContent";

const allGates = (
  overrides: Partial<FeatureGatesSnapshot> = {},
): FeatureGatesSnapshot => ({
  travelTime: true,
  createEvents: true,
  buyTickets: true,
  promos: true,
  maintenanceMode: false,
  unifiedScanResolver: true,
  seatingLayouts: true,
  waivers: true,
  entityPageEditor: true,
  broadcasts: true,
  resale: true,
  humanProfilesPublic: true,
  waitlists: true,
  arrivalAreas: true,
  sms: true,
  ...overrides,
});

describe("FeaturesContent feature-gate filtering", () => {
  beforeEach(() => {
    mockGates = undefined;
    // RevealSection observes its container; jsdom has no IntersectionObserver.
    class IntersectionObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    Object.defineProperty(window, "IntersectionObserver", {
      writable: true,
      value: IntersectionObserverStub,
    });
  });

  it("hides the resale category and broadcasts/announcements entries when the gates are off", () => {
    mockGates = allGates({ resale: false, broadcasts: false });
    render(<FeaturesContent />);

    // Whole resale category is gone.
    expect(
      screen.queryByText("featuresPage.resale.title"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("featuresPage.resale.listingsTitle"),
    ).not.toBeInTheDocument();

    // The broadcasts-gated org-CRM entry is gone…
    expect(
      screen.queryByText("featuresPage.orgtools.announcementsTitle"),
    ).not.toBeInTheDocument();

    // …but volunteer ROSTER broadcasts (a shipped, ungated volunteer
    // feature — distinct from the org-CRM `broadcasts` gate) stays visible.
    expect(
      screen.getByText("featuresPage.volunteer.broadcastsTitle"),
    ).toBeInTheDocument();

    // Their categories survive with their ungated entries.
    expect(
      screen.getByText("featuresPage.volunteer.asksTitle"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("featuresPage.orgtools.dashboardsTitle"),
    ).toBeInTheDocument();

    // Ungated categories are untouched.
    expect(
      screen.getByText("featuresPage.ticketing.title"),
    ).toBeInTheDocument();
  });

  it("hides the waitlists claim when the gate is off, keeping its category", () => {
    // Only the join half of waitlists exists (nothing sets NOTIFIED, no
    // release trigger/job/roster), so the public claim must not render.
    mockGates = allGates({ waitlists: false });
    render(<FeaturesContent />);

    expect(
      screen.queryByText("featuresPage.ticketing.waitlistTitle"),
    ).not.toBeInTheDocument();

    // The ticketing category survives on its ungated entries.
    expect(
      screen.getByText("featuresPage.ticketing.title"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("featuresPage.ticketing.multiTierTitle"),
    ).toBeInTheDocument();
  });

  it("hides the reserved-seating claim when the gate is off", () => {
    // `seatingLayouts` defaults to false with NO env override — only a
    // PlatformSetting row can turn it on — so it is dark for every org today
    // and the public claim must not render.
    mockGates = allGates({ seatingLayouts: false });
    render(<FeaturesContent />);

    expect(
      screen.queryByText("featuresPage.ticketing.seatingTitle"),
    ).not.toBeInTheDocument();

    // The ticketing category survives on its ungated entries.
    expect(
      screen.getByText("featuresPage.ticketing.holdsTitle"),
    ).toBeInTheDocument();
  });

  it("fails closed while gates load (undefined = hidden)", () => {
    mockGates = undefined;
    render(<FeaturesContent />);

    expect(
      screen.queryByText("featuresPage.ticketing.waitlistTitle"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("featuresPage.ticketing.seatingTitle"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("featuresPage.resale.title"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("featuresPage.orgtools.announcementsTitle"),
    ).not.toBeInTheDocument();
    // Ungated entries (incl. volunteer roster broadcasts) are unaffected
    // by gates loading.
    expect(
      screen.getByText("featuresPage.volunteer.broadcastsTitle"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("featuresPage.ticketing.title"),
    ).toBeInTheDocument();
  });

  it("shows everything when the gates are explicitly on", () => {
    mockGates = allGates();
    render(<FeaturesContent />);

    expect(screen.getByText("featuresPage.resale.title")).toBeInTheDocument();
    expect(
      screen.getByText("featuresPage.resale.listingsTitle"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("featuresPage.volunteer.broadcastsTitle"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("featuresPage.orgtools.announcementsTitle"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("featuresPage.ticketing.waitlistTitle"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("featuresPage.ticketing.seatingTitle"),
    ).toBeInTheDocument();
  });

  it("describes messaging without SMS unless the sms gate is on", () => {
    mockGates = allGates({ sms: false });
    const { unmount } = render(<FeaturesContent />);
    expect(
      screen.getByText("featuresPage.orgtools.channelsDescNoSms"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("featuresPage.orgtools.channelsDesc"),
    ).not.toBeInTheDocument();
    unmount();

    mockGates = allGates({ sms: true });
    render(<FeaturesContent />);
    expect(
      screen.getByText("featuresPage.orgtools.channelsDesc"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("featuresPage.orgtools.channelsDescNoSms"),
    ).not.toBeInTheDocument();
  });
});
