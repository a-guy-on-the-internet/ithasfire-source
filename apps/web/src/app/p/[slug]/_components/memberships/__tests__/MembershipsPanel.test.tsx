import { render, screen, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PageBlockRecord } from "@th/types/repos/entity-pages";

/**
 * MembershipsPanel — pins the BLOCK-LEVEL member gate (recurring-memberships
 * spec): the same tab serves the pitch (tier cards + join) to non-members and
 * the `section == "memberships"` blocks to members, decided by whether the
 * viewer holds a benefit-GRANTING membership on one of this owner's tiers.
 * past_due/canceled must NOT unlock member content (a failing card keeps
 * earning nothing — mirrors MEMBERSHIP_BENEFIT_GRANTING_STATUSES).
 */

vi.mock("@th/ui", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/p/demo",
}));

const showSignInOverlay = vi.fn();
vi.mock("@/components/layout/AppOverlayProvider", () => ({
  useAppOverlay: () => ({ showSignInOverlay }),
}));

let sessionUser: { id: string } | null = null;
vi.mock("@/lib/auth/auth-client", () => ({
  authClient: {
    useSession: () => ({
      data: sessionUser ? { user: sessionUser } : null,
      isPending: false,
    }),
  },
}));

let mineItems: Array<{
  id: string;
  status: string;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
  currentPeriodEnd: Date;
  startedAt: Date;
  tier: {
    id: string;
    name: string;
    priceCents: number;
    currency: string;
    interval: "MONTH" | "YEAR";
  };
  owner: { type: "HUMAN" | "ORGANIZATION"; id: string; name: string | null };
}> = [];

/**
 * When set, the start mutation resolves with this membership payload (the
 * `memberships.start` output shape: row fields + paymentIntentClientSecret).
 */
let startResult: {
  id: string;
  status: string;
  paymentIntentClientSecret: string | null;
} | null = null;

/**
 * What the authed `memberships.memberBlocks` procedure would answer. Member
 * content is NEVER a prop (it must stay out of the public RSC payload); the
 * panel fetches it lazily, and `memberBlocksQueries` records every hook call
 * with its `enabled` flag so tests can pin that the fetch happens ONLY once
 * the member gate has passed.
 */
let memberBlocksResult: { blocks: PageBlockRecord[] } = { blocks: [] };
const memberBlocksQueries: Array<{ input: unknown; enabled?: boolean }> = [];

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      memberships: { mine: { list: { invalidate: vi.fn() } } },
    }),
    memberships: {
      mine: {
        list: {
          useQuery: (_input: unknown, opts?: { enabled?: boolean }) =>
            opts?.enabled
              ? { data: { items: mineItems }, isPending: false }
              : { data: undefined, isPending: false },
        },
      },
      memberBlocks: {
        useQuery: (input: unknown, opts?: { enabled?: boolean }) => {
          memberBlocksQueries.push({ input, enabled: opts?.enabled });
          return opts?.enabled
            ? { data: memberBlocksResult, isPending: false }
            : { data: undefined, isPending: false };
        },
      },
      start: {
        useMutation: () => ({
          mutate: (
            _input: unknown,
            opts?: { onSuccess?: (membership: unknown) => void },
          ) => {
            if (startResult) opts?.onSuccess?.(startResult);
          },
          isPending: false,
        }),
      },
      portalSession: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
    },
  },
}));

// The payment step's internals (Stripe Elements) are covered by its own test;
// here a stub exposes the callbacks so the PANEL's state machine is what's
// under test.
vi.mock("../MembershipPaymentStep", () => ({
  MembershipPaymentStep: ({
    clientSecret,
    tierName,
    onSuccess,
    onCancel,
  }: {
    clientSecret: string;
    tierName: string;
    onSuccess: () => void;
    onCancel: () => void;
  }) => (
    <div data-testid="payment-step" data-client-secret={clientSecret}>
      <span>{tierName}</span>
      <button type="button" onClick={onSuccess}>
        stub-confirm
      </button>
      <button type="button" onClick={onCancel}>
        stub-cancel
      </button>
    </div>
  ),
}));

vi.mock("../../blocks", () => ({
  BlockRenderer: ({ block }: { block: PageBlockRecord }) => (
    <div data-testid="member-block" data-block-kind={block.kind} />
  ),
}));

vi.mock("../../blocks/block-page-owner-context", () => ({
  BlockPageOwnerProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

import { MembershipsPanel } from "../MembershipsPanel";

const OWNER_ID = "00000000-0000-4000-8000-00000000d001";
const TIER = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Sustaining Member",
  description: "Keeps the lights on.",
  benefitsDescription: null,
  priceCents: 1000,
  currency: "usd",
  interval: "MONTH" as const,
  sortOrder: 0,
};

const MEMBER_BLOCK: PageBlockRecord = {
  id: "b-members",
  pageId: "page-1",
  kind: "announcements",
  orderIndex: 0,
  data: {},
  visible: true,
  section: "memberships",
};

function membership(status: string) {
  return {
    id: "m-1",
    status,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    currentPeriodEnd: new Date("2026-09-01"),
    startedAt: new Date("2026-08-01"),
    tier: {
      id: TIER.id,
      name: TIER.name,
      priceCents: TIER.priceCents,
      currency: TIER.currency,
      interval: TIER.interval,
    },
    owner: {
      type: "ORGANIZATION" as const,
      id: OWNER_ID,
      name: "Demo Org",
    },
  };
}

function renderPanel() {
  return render(
    <MembershipsPanel
      entityName="Demo Org"
      ownerType="ORGANIZATION"
      ownerId={OWNER_ID}
      tiers={[TIER]}
    />,
  );
}

/** True when ANY memberBlocks hook call ran with the fetch enabled. */
function memberBlocksFetchEnabled() {
  return memberBlocksQueries.some((call) => call.enabled === true);
}

beforeEach(() => {
  sessionUser = null;
  mineItems = [];
  startResult = null;
  memberBlocksResult = { blocks: [MEMBER_BLOCK] };
  memberBlocksQueries.length = 0;
  showSignInOverlay.mockClear();
});

/** Open the join form for the single tier and submit a ZIP. */
function submitJoin() {
  fireEvent.click(
    screen.getByRole("button", { name: "entityMemberships.joinAria" }),
  );
  fireEvent.change(screen.getByLabelText("entityMemberships.postalLabel"), {
    target: { value: "37203" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "entityMemberships.confirmJoin" }),
  );
}

describe("MembershipsPanel gating", () => {
  it("signed-out: renders the pitch and opens the sign-in overlay on Join", () => {
    renderPanel();

    expect(screen.getByText("Sustaining Member")).toBeInTheDocument();
    expect(screen.queryByTestId("member-block")).not.toBeInTheDocument();
    // Anonymous viewers must never even REQUEST member content.
    expect(memberBlocksFetchEnabled()).toBe(false);

    fireEvent.click(
      screen.getByRole("button", { name: "entityMemberships.joinAria" }),
    );
    expect(showSignInOverlay).toHaveBeenCalledWith({
      redirect: "/p/demo?tab=memberships",
    });
  });

  it("signed-in non-member: pitch, no member blocks, join opens the ZIP form", () => {
    sessionUser = { id: "human-1" };
    renderPanel();

    expect(screen.queryByTestId("member-block")).not.toBeInTheDocument();
    // Signed-in but not a member: the gate has not passed, no fetch.
    expect(memberBlocksFetchEnabled()).toBe(false);
    fireEvent.click(
      screen.getByRole("button", { name: "entityMemberships.joinAria" }),
    );
    expect(showSignInOverlay).not.toHaveBeenCalled();
    expect(
      screen.getByLabelText("entityMemberships.postalLabel"),
    ).toBeInTheDocument();
  });

  it("active member: member view + LAZILY-FETCHED memberships-section blocks, no pitch", () => {
    sessionUser = { id: "human-1" };
    mineItems = [membership("active")];
    renderPanel();

    expect(screen.getByTestId("member-block")).toBeInTheDocument();
    // The content arrived via the authed memberBlocks query, scoped to THIS
    // owner — never via server props (which would serialise it into the
    // anonymously-cached RSC payload).
    expect(memberBlocksFetchEnabled()).toBe(true);
    expect(memberBlocksQueries.at(-1)?.input).toEqual({
      ownerType: "ORGANIZATION",
      ownerId: OWNER_ID,
    });
    expect(
      screen.getByText("entityMemberships.memberBadge"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "entityMemberships.joinAria" }),
    ).not.toBeInTheDocument();
  });

  it("active member with NO member blocks published: empty-state note, not a crash", () => {
    sessionUser = { id: "human-1" };
    mineItems = [membership("active")];
    memberBlocksResult = { blocks: [] };
    renderPanel();

    expect(screen.queryByTestId("member-block")).not.toBeInTheDocument();
    expect(
      screen.getByText("entityMemberships.memberContentEmpty"),
    ).toBeInTheDocument();
  });

  it("past_due membership grants NO member content — pitch renders, nothing fetched", () => {
    sessionUser = { id: "human-1" };
    mineItems = [membership("past_due")];
    renderPanel();

    expect(screen.queryByTestId("member-block")).not.toBeInTheDocument();
    expect(memberBlocksFetchEnabled()).toBe(false);
    expect(
      screen.getByRole("button", { name: "entityMemberships.joinAria" }),
    ).toBeInTheDocument();
  });

  it("start with a client secret → the Elements payment step renders (default_incomplete flow)", () => {
    sessionUser = { id: "human-1" };
    startResult = {
      id: "m-new",
      status: "incomplete",
      paymentIntentClientSecret: "pi_1_secret_abc",
    };
    renderPanel();

    submitJoin();

    const step = screen.getByTestId("payment-step");
    expect(step).toHaveAttribute("data-client-secret", "pi_1_secret_abc");
    // Not a success state yet — nothing has been paid.
    expect(
      screen.queryByText("entityMemberships.joinSuccessActive"),
    ).not.toBeInTheDocument();
  });

  it("payment confirm success → honest 'activating' state (webhooks finish it), no Finish-payment CTA", () => {
    sessionUser = { id: "human-1" };
    startResult = {
      id: "m-new",
      status: "incomplete",
      paymentIntentClientSecret: "pi_1_secret_abc",
    };
    renderPanel();
    submitJoin();

    fireEvent.click(screen.getByRole("button", { name: "stub-confirm" }));

    expect(
      screen.getByText("entityMemberships.joinSuccessProcessing"),
    ).toBeInTheDocument();
    // Payment is already confirmed — offering the portal "finish payment"
    // path here would be wrong.
    expect(
      screen.queryByRole("button", { name: "entityMemberships.finishPayment" }),
    ).not.toBeInTheDocument();
  });

  it("backing out of payment → incomplete fallback with the Finish-payment (portal) CTA", () => {
    sessionUser = { id: "human-1" };
    startResult = {
      id: "m-new",
      status: "incomplete",
      paymentIntentClientSecret: "pi_1_secret_abc",
    };
    renderPanel();
    submitJoin();

    fireEvent.click(screen.getByRole("button", { name: "stub-cancel" }));

    expect(
      screen.getByText("entityMemberships.joinSuccessIncomplete"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "entityMemberships.finishPayment" }),
    ).toBeInTheDocument();
  });

  it("start with a NULL client secret (nothing to pay) skips payment and lands on success", () => {
    sessionUser = { id: "human-1" };
    startResult = {
      id: "m-new",
      status: "active",
      paymentIntentClientSecret: null,
    };
    renderPanel();

    submitJoin();

    expect(screen.queryByTestId("payment-step")).not.toBeInTheDocument();
    expect(
      screen.getByText("entityMemberships.joinSuccessActive"),
    ).toBeInTheDocument();
  });

  it("a membership at a DIFFERENT owner does not unlock this page — and does not fetch", () => {
    sessionUser = { id: "human-1" };
    const other = membership("active");
    other.owner = { ...other.owner, id: "99999999-9999-4999-8999-999999999999" };
    mineItems = [other];
    renderPanel();

    expect(screen.queryByTestId("member-block")).not.toBeInTheDocument();
    expect(memberBlocksFetchEnabled()).toBe(false);
  });
});
