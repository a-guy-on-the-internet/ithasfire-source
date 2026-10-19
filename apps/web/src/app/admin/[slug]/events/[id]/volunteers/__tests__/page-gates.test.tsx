import type { ComponentType, ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// The shell is the unit under test elsewhere (EventAdminPageShell.test.tsx);
// here it only records the gates each page asks for. It never calls
// `children`, so the tab components are never rendered — they are mocked
// only to keep their import graphs out of this test.
vi.mock("../../_components/EventAdminPageShell", () => ({
  EventAdminPageShell: (props: Record<string, unknown>) => (
    <div
      data-testid="shell"
      data-gates={JSON.stringify({
        requireEdit: Boolean(props.requireEdit),
        requireEditOrFinance: Boolean(props.requireEditOrFinance),
        requireFinance: Boolean(props.requireFinance),
        requireOrgEvent: Boolean(props.requireOrgEvent),
        requirePublished: Boolean(props.requirePublished),
      })}
    />
  ),
}));
vi.mock("../../_components/EventOpsShell", () => ({
  EventOpsShell: () => null,
}));
vi.mock("../_components/VolunteersSetupView", () => ({
  VolunteersSetupView: () => null,
}));
vi.mock("../_components/VolunteeringGate", () => ({
  VolunteeringGate: () => null,
}));
vi.mock("../_components/RolesTab", () => ({ RolesTab: () => null }));
vi.mock("../_components/SignupsTab", () => ({ SignupsTab: () => null }));
vi.mock("../_components/RewardsTab", () => ({ RewardsTab: () => null }));
vi.mock("@th/ui", () => ({
  Button: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  NextLinkAnchor: ({ children }: { children?: ReactNode }) => (
    <span>{children}</span>
  ),
  useTranslations: () => (key: string) => key,
}));

import SetupPage from "../page";
import RolesPage from "../roles/page";
import SignupsPage from "../signups/page";
import RewardsPage from "../rewards/page";

type PageComponent = ComponentType<{
  params: Promise<{ slug: string; id: string }>;
}>;

// An already-settled thenable: React 19's `use` reads `status`/`value`
// synchronously instead of suspending, so the page renders in one pass.
const settledParams = () => {
  const value = { slug: "acme-co", id: "evt-1" };
  return Object.assign(Promise.resolve(value), {
    status: "fulfilled" as const,
    value,
  });
};

const gatesOf = (Page: PageComponent) => {
  render(<Page params={settledParams()} />);
  const shell = screen.getByTestId("shell");
  return JSON.parse(shell.getAttribute("data-gates") ?? "{}");
};

/**
 * Each volunteer page's gates, set to match what its reads allow server-side:
 * every volunteer read is ORG_EDIT_ROLES; roles / signups / rewards also throw
 * EVENT_NOT_ORG_OWNED on an event without an org; the rewards ledger is
 * finance-gated on top. Setup is the exception: `getEventForEdit` and
 * `updateSettings` serve a person's own event.
 */
describe("event volunteer pages ask the shell for the server's gates", () => {
  it.each<[string, PageComponent, Record<string, boolean>]>([
    [
      "setup",
      SetupPage,
      {
        requireEdit: true,
        requireEditOrFinance: false,
        requireFinance: false,
        requireOrgEvent: false,
        requirePublished: false,
      },
    ],
    [
      "roles",
      RolesPage,
      {
        requireEdit: true,
        requireEditOrFinance: false,
        requireFinance: false,
        requireOrgEvent: true,
        requirePublished: false,
      },
    ],
    [
      "signups",
      SignupsPage,
      {
        requireEdit: true,
        requireEditOrFinance: false,
        requireFinance: false,
        requireOrgEvent: true,
        requirePublished: false,
      },
    ],
    [
      "rewards",
      RewardsPage,
      {
        requireEdit: true,
        requireEditOrFinance: false,
        requireFinance: true,
        requireOrgEvent: true,
        requirePublished: false,
      },
    ],
  ])("%s", (_name, Page, expected) => {
    expect(gatesOf(Page)).toEqual(expected);
  });
});
