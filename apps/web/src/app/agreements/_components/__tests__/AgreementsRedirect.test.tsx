import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OwnerEntityWithSlug } from "@/hooks/useEventOwnerEntities";
import { AgreementsRedirect } from "../AgreementsRedirect";

/**
 * The retired `/agreements` list: a spinner while the session and owners
 * settle, then exactly one `router.replace`. A resolved-but-empty session
 * must leave for sign-in — a disabled owners query never settles on its own.
 */

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  session: {
    data: { user: { id: "u1" } } as unknown,
    isPending: false,
  },
  owners: {
    ownersWithSlugs: undefined as OwnerEntityWithSlug[] | undefined,
    isPending: false,
    isError: false,
  },
}));

vi.mock("@bprogress/next/app", () => ({
  useRouter: () => ({ replace: mocks.replace, push: vi.fn() }),
}));

vi.mock("@/lib/auth/auth-client", () => ({
  authClient: { useSession: () => mocks.session },
}));

vi.mock("@/hooks/useEventOwnerEntities", () => ({
  useEventOwnerEntities: () => mocks.owners,
}));

vi.mock("tamagui", () => ({
  YStack: ({ children, role }: { children?: ReactNode; role?: string }) => (
    <div role={role}>{children}</div>
  ),
}));

vi.mock("@th/ui", () => ({
  useTranslations: () => (key: string) => key,
  Spinner: () => <span data-testid="spinner" />,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

const ORG: OwnerEntityWithSlug = {
  kind: "org",
  orgId: "org-1",
  orgName: "Greek Theatre",
  orgSlug: "greek",
  role: "ADMIN",
  avatarUrl: null,
  adminSlug: "greek",
};

describe("AgreementsRedirect", () => {
  beforeEach(() => {
    mocks.replace.mockReset();
    mocks.session.data = { user: { id: "u1" } };
    mocks.session.isPending = false;
    mocks.owners.ownersWithSlugs = undefined;
    mocks.owners.isPending = false;
    mocks.owners.isError = false;
  });

  it("shows a spinner and does not move while owners are pending", () => {
    mocks.owners.isPending = true;
    render(<AgreementsRedirect />);
    expect(screen.getByTestId("spinner")).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("does not move while the session is still resolving", () => {
    mocks.session.isPending = true;
    mocks.session.data = null;
    render(<AgreementsRedirect />);
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("sends a settled viewer with no owners to settings → Booking requests", () => {
    render(<AgreementsRedirect />);
    expect(mocks.replace).toHaveBeenCalledTimes(1);
    expect(mocks.replace).toHaveBeenCalledWith(
      "/account/settings/booking-requests",
    );
  });

  it("falls to the performer surface when the owners read fails", () => {
    mocks.owners.isPending = true;
    mocks.owners.isError = true;
    render(<AgreementsRedirect />);
    expect(mocks.replace).toHaveBeenCalledWith(
      "/account/settings/booking-requests",
    );
  });

  it("sends a single-org viewer to that org's booking inbox", () => {
    mocks.owners.ownersWithSlugs = [ORG];
    render(<AgreementsRedirect />);
    expect(mocks.replace).toHaveBeenCalledWith("/admin/greek/bookings");
  });

  it("sends a resolved signed-out session to sign-in with a redirect back", () => {
    mocks.session.data = null;
    mocks.owners.isPending = true; // disabled query: would never settle
    render(<AgreementsRedirect />);
    expect(mocks.replace).toHaveBeenCalledTimes(1);
    expect(mocks.replace).toHaveBeenCalledWith(
      "/sign-in?redirect_url=%2Fagreements",
    );
  });
});
