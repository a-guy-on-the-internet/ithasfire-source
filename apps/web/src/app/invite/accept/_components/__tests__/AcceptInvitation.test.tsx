import type { ReactNode } from "react";
import { fireEvent, render as rtlRender, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AcceptInvitation } from "../AcceptInvitation";

// Security review 2026-09-29: page load must never be consent. An attacker
// can invite their OWN address and lure a signed-in victim to the link.

const mocks = vi.hoisted(() => ({
  acceptMutate: vi.fn(),
  previewMutate: vi.fn(),
  push: vi.fn(),
}));

let sessionState: { data: unknown; isPending: boolean };
let previewState: { data?: { orgName: string; role: string }; error?: unknown };
let acceptState: {
  isPending: boolean;
  isSuccess: boolean;
  data?: { orgId: string; orgName: string; role: string };
  error?: unknown;
};

vi.mock("@/lib/auth/auth-client", () => ({
  authClient: { useSession: () => sessionState },
}));
vi.mock("@/lib/app-error", () => ({
  getAppErrorCode: (error: unknown) =>
    (error as { data?: { appCode?: string } } | null)?.data?.appCode ?? null,
}));
vi.mock("@/lib/quota-error", () => ({ extractQuotaExceededMeta: () => null }));
vi.mock("@/components/errors/QuotaExceededDialog", () => ({
  QuotaExceededDialog: () => null,
}));
vi.mock("@bprogress/next/app", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      client: { orgs: { previewInvitation: { mutate: mocks.previewMutate } } },
    }),
    orgs: {
      acceptInvitation: {
        useMutation: () => ({
          mutate: mocks.acceptMutate,
          ...acceptState,
          error: acceptState.error ?? null,
        }),
      },
    },
  },
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children?: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("tamagui", () => ({
  YStack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Spinner: () => <span>loading…</span>,
}));
vi.mock("@th/ui", () => ({
  Button: ({
    children,
    disabled,
    onPress,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onPress?: () => void;
  }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
  Text: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  useTranslations: () => (key: string) => key,
}));

const render = (ui: ReactNode) =>
  rtlRender(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {ui}
    </QueryClientProvider>,
  );

describe("AcceptInvitation (org)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    mocks.previewMutate.mockImplementation(async () => {
      if (previewState.error) throw previewState.error;
      if (!previewState.data) return new Promise(() => {}); // never answers
      return previewState.data;
    });
    sessionState = { data: { user: { id: "u1" } }, isPending: false };
    previewState = { data: { orgName: "Test Org", role: "SCANNER" } };
    acceptState = { isPending: false, isSuccess: false };
  });

  it("accepts NOTHING on load — it only previews, then waits for the click", async () => {
    render(<AcceptInvitation token="tok/with+chars" />);

    expect(await screen.findByText("auth.invConfirmTitle")).toBeTruthy();
    expect(mocks.previewMutate).toHaveBeenCalledWith({ token: "tok/with+chars" });
    expect(mocks.acceptMutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("auth.invAccept"));
    expect(mocks.acceptMutate).toHaveBeenCalledWith({ token: "tok/with+chars" });
  });

  it("shows no Accept button until the preview answers", () => {
    previewState = {};
    render(<AcceptInvitation token="t" />);
    expect(screen.queryByText("auth.invAccept")).toBeNull();
    expect(mocks.acceptMutate).not.toHaveBeenCalled();
  });

  it("a different signed-in account gets the wrong-account message and no Accept button", async () => {
    previewState = { error: { data: { appCode: "INVITATION_NOT_FOUND" } } };
    render(<AcceptInvitation token="t" />);
    expect(await screen.findByText("auth.invNotValidForAccountDesc")).toBeTruthy();
    expect(screen.queryByText("auth.invAccept")).toBeNull();
    expect(mocks.acceptMutate).not.toHaveBeenCalled();
  });

  it("maps unverified email and revoked invitations by code", async () => {
    previewState = { error: { data: { appCode: "EMAIL_NOT_VERIFIED" } } };
    const { unmount } = render(<AcceptInvitation token="t" />);
    expect(await screen.findByText("auth.delInvVerifyEmailDesc")).toBeTruthy();
    unmount();

    previewState = {
      error: {
        data: { appCode: "INVITATION_NOT_PENDING", meta: { status: "REVOKED" } },
      },
    };
    render(<AcceptInvitation token="t2" />);
    expect(await screen.findByText("auth.invRevokedDesc")).toBeTruthy();
  });

  it("signed out: nothing is called, and Sign in stashes the token and redirects WITHOUT it", () => {
    sessionState = { data: null, isPending: false };
    render(<AcceptInvitation token="a+b/c=" />);
    expect(mocks.previewMutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("auth.signIn"));
    expect(mocks.push).toHaveBeenCalledWith(
      `/sign-in?redirect=${encodeURIComponent("/invite/accept")}`,
    );
    expect(String(mocks.push.mock.calls[0]![0])).not.toContain("token");
    expect(window.sessionStorage.getItem("th:pending-invite-token:org")).toBe("a+b/c=");
  });

  it("falls back to the token in the redirect when storage is unavailable", () => {
    sessionState = { data: null, isPending: false };
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("QuotaExceeded");
      });
    render(<AcceptInvitation token="a+b/c=" />);
    fireEvent.click(screen.getByText("auth.signIn"));
    expect(mocks.push).toHaveBeenCalledWith(
      `/sign-in?redirect=${encodeURIComponent(`/invite/accept?token=${encodeURIComponent("a+b/c=")}`)}`,
    );
    setItem.mockRestore();
  });

  it("back from sign-in with NO token in the URL, it uses the stashed one", async () => {
    window.sessionStorage.setItem("th:pending-invite-token:org", "stashed-tok");
    render(<AcceptInvitation token={null} />);
    expect(await screen.findByText("auth.invConfirmTitle")).toBeTruthy();
    expect(mocks.previewMutate).toHaveBeenCalledWith({ token: "stashed-tok" });
    fireEvent.click(screen.getByText("auth.invAccept"));
    expect(mocks.acceptMutate).toHaveBeenCalledWith({ token: "stashed-tok" });
  });

  it("with no URL token and nothing stashed, shows the invalid-link screen", async () => {
    render(<AcceptInvitation token={null} />);
    expect(await screen.findByText("auth.invNoTokenDesc")).toBeTruthy();
  });
  it.each(["INVITATION_NOT_FOUND", "INVITATION_EXPIRED", "INVITATION_NOT_PENDING"])(
    "clears the stashed token on terminal error %s",
    async (appCode) => {
      window.sessionStorage.setItem("th:pending-invite-token:org", "stashed");
      previewState = { error: { data: { appCode } } };
      render(<AcceptInvitation token={null} />);
      await vi.waitFor(() =>
        expect(window.sessionStorage.getItem("th:pending-invite-token:org")).toBeNull(),
      );
    },
  );

  it("KEEPS the stash on EMAIL_NOT_VERIFIED (the invitee verifies and returns)", async () => {
    window.sessionStorage.setItem("th:pending-invite-token:org", "stashed");
    previewState = { error: { data: { appCode: "EMAIL_NOT_VERIFIED" } } };
    render(<AcceptInvitation token={null} />);
    expect(await screen.findByText("auth.delInvVerifyEmailDesc")).toBeTruthy();
    expect(window.sessionStorage.getItem("th:pending-invite-token:org")).toBe("stashed");
  });
});
