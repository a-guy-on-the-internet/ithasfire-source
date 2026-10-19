import type { ReactNode } from "react";
import { fireEvent, render as rtlRender, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AcceptDelegateInvite } from "../AcceptDelegateInvite";

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  previewMutate: vi.fn(),
  push: vi.fn(),
}));

vi.mock("@bprogress/next/app", () => ({ useRouter: () => ({ push: mocks.push }) }));

let sessionState: { data: unknown; isPending: boolean };
let previewState: {
  data?: { principalName: string | null; role: string };
  error?: unknown;
};
let mutationState: {
  isPending: boolean;
  isSuccess: boolean;
  isError: boolean;
  data?: { principalId: string; principalName: string | null; role: string };
  error?: unknown;
};

vi.mock("@/lib/auth/auth-client", () => ({
  authClient: { useSession: () => sessionState },
}));

vi.mock("@/lib/app-error", () => ({
  getAppErrorCode: (error: unknown) =>
    (error as { data?: { appCode?: string } } | null)?.data?.appCode ?? null,
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      client: { delegates: { previewInvite: { mutate: mocks.previewMutate } } },
    }),
    delegates: {
      acceptInvite: {
        useMutation: () => ({ mutate: mocks.mutate, ...mutationState }),
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

describe("AcceptDelegateInvite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    mocks.previewMutate.mockImplementation(async () => {
      if (previewState.error) throw previewState.error;
      if (!previewState.data) return new Promise(() => {});
      return previewState.data;
    });
    sessionState = { data: { user: { id: "u1" } }, isPending: false };
    mutationState = { isPending: false, isSuccess: false, isError: false };
    previewState = { data: { principalName: "Pat Principal", role: "EDITOR" } };
  });

  it("does NOT auto-accept on load; it previews, names the inviter, and waits for Accept", async () => {
    render(<AcceptDelegateInvite token="v1.a.b" />);

    expect(await screen.findByText("auth.delInvConfirmDesc")).toBeTruthy();
    expect(mocks.previewMutate).toHaveBeenCalledWith({ token: "v1.a.b" });
    expect(mocks.mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("auth.delInvAccept"));
    expect(mocks.mutate).toHaveBeenCalledWith({ token: "v1.a.b" });
  });

  it("signed out: Sign in stashes the token and redirects WITHOUT it", () => {
    sessionState = { data: null, isPending: false };
    render(<AcceptDelegateInvite token="v1.a.b" />);

    fireEvent.click(screen.getByText("auth.signIn"));
    expect(mocks.push).toHaveBeenCalledWith(
      `/sign-in?redirect=${encodeURIComponent("/delegate/accept")}`,
    );
    expect(window.sessionStorage.getItem("th:pending-invite-token:delegate")).toBe("v1.a.b");
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("back from sign-in with no URL token, it previews the stashed one", async () => {
    window.sessionStorage.setItem("th:pending-invite-token:delegate", "v1.s.t");
    render(<AcceptDelegateInvite token={null} />);
    expect(await screen.findByText("auth.delInvConfirmDesc")).toBeTruthy();
    expect(mocks.previewMutate).toHaveBeenCalledWith({ token: "v1.s.t" });
  });

  it("explains a wrong-account link without revealing the invited email", () => {
    mutationState = {
      ...mutationState,
      isError: true,
      error: { data: { appCode: "INVITATION_NOT_FOUND" } },
    };
    render(<AcceptDelegateInvite token="v1.a.b" />);
    expect(screen.getByText("auth.delInvWrongAccountDesc")).toBeTruthy();
  });

  it("shows the already-used state for a replayed link", () => {
    mutationState = {
      ...mutationState,
      isError: true,
      error: { data: { appCode: "INVITATION_NOT_PENDING" } },
    };
    render(<AcceptDelegateInvite token="v1.a.b" />);
    expect(screen.getByText("auth.delInvAlreadyUsedDesc")).toBeTruthy();
  });

  it("shows success once accepted", () => {
    mutationState = {
      ...mutationState,
      isSuccess: true,
      data: { principalId: "p1", principalName: "Pat", role: "EDITOR" },
    };
    render(<AcceptDelegateInvite token="v1.a.b" />);
    expect(screen.getByText("auth.invYoureIn")).toBeTruthy();
  });

  it("handles a missing token", async () => {
    render(<AcceptDelegateInvite token={null} />);
    expect(await screen.findByText("auth.delInvNoTokenDesc")).toBeTruthy();
  });
  it("shows a spinner, not the Accept button, until the preview answers", () => {
    previewState = {};
    render(<AcceptDelegateInvite token="v1.a.b" />);
    expect(screen.queryByText("auth.delInvAccept")).toBeNull();
    expect(screen.getByText("auth.invChecking")).toBeTruthy();
  });

  it("uses the unnamed copy when the inviter has no display name", async () => {
    previewState = { data: { principalName: null, role: "EDITOR" } };
    render(<AcceptDelegateInvite token="v1.a.b" />);
    expect(await screen.findByText("auth.delInvConfirmDescUnnamed")).toBeTruthy();
  });

  it("shows the wrong-account message when the PREVIEW is refused", async () => {
    previewState = { error: { data: { appCode: "INVITATION_NOT_FOUND" } } };
    render(<AcceptDelegateInvite token="v1.a.b" />);
    expect(await screen.findByText("auth.delInvWrongAccountDesc")).toBeTruthy();
    expect(screen.queryByText("auth.delInvAccept")).toBeNull();
  });

  it("success copy never renders an empty name", () => {
    mutationState = {
      ...mutationState,
      isSuccess: true,
      data: { principalId: "p1", principalName: null, role: "EDITOR" },
    };
    render(<AcceptDelegateInvite token="v1.a.b" />);
    expect(screen.getByText("auth.delInvYoureInDescUnnamed")).toBeTruthy();
  });
  it.each(["INVITATION_NOT_FOUND", "INVITATION_EXPIRED", "INVITATION_NOT_PENDING"])(
    "clears the stashed token on terminal error %s",
    async (appCode) => {
      window.sessionStorage.setItem("th:pending-invite-token:delegate", "stashed");
      previewState = { error: { data: { appCode } } };
      render(<AcceptDelegateInvite token={null} />);
      await vi.waitFor(() =>
        expect(
          window.sessionStorage.getItem("th:pending-invite-token:delegate"),
        ).toBeNull(),
      );
    },
  );

  it("KEEPS the stash on EMAIL_NOT_VERIFIED", async () => {
    window.sessionStorage.setItem("th:pending-invite-token:delegate", "stashed");
    previewState = { error: { data: { appCode: "EMAIL_NOT_VERIFIED" } } };
    render(<AcceptDelegateInvite token={null} />);
    expect(await screen.findByText("auth.delInvVerifyEmailDesc")).toBeTruthy();
    expect(window.sessionStorage.getItem("th:pending-invite-token:delegate")).toBe(
      "stashed",
    );
  });
});
