/**
 * Settings → Access Gate invite panel (gated-event invite links, step 7):
 * the shared "Invite link" and the "Invited guests" list.
 *
 * The styling layer is replaced by DOM stand-ins (as in the other
 * EventGateSettings tests) so the assertions target behaviour: which copy
 * shows for which state, what each control sends, and that every row action
 * carries a distinct accessible name.
 */
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

// ── DOM-level stand-ins for the styling layer ─────────────────────────────

const PASS_PROP = /^(data-|aria-)|^(id|role|style|title|tabIndex|type)$/;
function domProps(rest: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (PASS_PROP.test(key)) out[key] = value;
  }
  return out;
}

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({
    children,
    tag,
    ...rest
  }: {
    children?: ReactNode;
    tag?: string;
    [key: string]: unknown;
  }) => React.createElement(tag ?? "div", domProps(rest), children);
  return {
    XStack: Stack,
    YStack: Stack,
    Stack,
    styled: () => Stack,
    useTheme: () => new Proxy({}, { get: () => ({ val: "#211C16" }) }),
  };
});

vi.mock("@th/ui", async () => {
  const React = await import("react");
  const Text = ({
    children,
    ...rest
  }: {
    children?: ReactNode;
    [key: string]: unknown;
  }) => React.createElement("span", domProps(rest), children);
  const Passthrough = ({ children }: { children?: ReactNode }) =>
    React.createElement("div", null, children);
  const ModalRoot = ({
    open,
    children,
  }: {
    open?: boolean;
    children?: ReactNode;
  }) =>
    open ? React.createElement("div", { role: "dialog" }, children) : null;
  const Modal = Object.assign(ModalRoot, {
    Panel: ({ children, ...rest }: { children?: ReactNode }) =>
      React.createElement("div", domProps(rest), children),
    Header: ({ title }: { title?: string }) =>
      React.createElement("h2", null, title),
    Body: Passthrough,
    Footer: Passthrough,
  });
  // Real DOM radios through a context (the SeriesEditScopeDialog test's double).
  type GroupCtx = { value: string; onValueChange: (v: string) => void };
  const RadioCtx = React.createContext<GroupCtx>({
    value: "",
    onValueChange: () => {},
  });
  const RadioGroupField = ({
    value,
    onValueChange,
    children,
    ...rest
  }: {
    value: string;
    onValueChange: (v: string) => void;
    children?: ReactNode;
    [key: string]: unknown;
  }) =>
    React.createElement(
      RadioCtx.Provider,
      { value: { value, onValueChange } },
      React.createElement(
        "div",
        { role: "radiogroup", "aria-label": rest["aria-label"] as string },
        children,
      ),
    );
  const Radio = ({
    value,
    label,
    description,
    disabled,
    testIdBase,
  }: {
    value: string;
    label?: ReactNode;
    description?: ReactNode;
    disabled?: boolean;
    testIdBase?: string;
  }) => {
    const ctx = React.useContext(RadioCtx);
    return React.createElement(
      "label",
      { "data-testid": testIdBase },
      React.createElement("input", {
        type: "radio",
        checked: ctx.value === value,
        disabled,
        onChange: () => ctx.onValueChange(value),
      }),
      label,
      description ?? null,
    );
  };
  return {
    Text,
    Badge: Text,
    Modal,
    Radio,
    RadioGroupField,
    Spinner: () => null,
    Button: React.forwardRef(
      (
        {
          children,
          onPress,
          disabled,
          variant,
          ...rest
        }: {
          children?: ReactNode;
          onPress?: () => void;
          disabled?: boolean;
          variant?: string;
          [key: string]: unknown;
        },
        ref,
      ) =>
        React.createElement(
          "button",
          {
            ref,
            type: "button",
            onClick: onPress,
            disabled,
            "data-variant": variant,
            ...domProps(rest),
          },
          children,
        ),
    ),
    TextInput: ({
      testId,
      value,
      onChangeText,
      id,
      type,
      ...rest
    }: {
      testId?: string;
      value?: string;
      onChangeText?: (v: string) => void;
      id?: string;
      type?: string;
      [key: string]: unknown;
    }) =>
      React.createElement("input", {
        "data-testid": testId,
        id,
        type,
        value,
        onChange: (e: { target: { value: string } }) =>
          onChangeText?.(e.target.value),
        ...domProps(rest),
      }),
    StyledSelect: ({
      value,
      options,
      onChange,
      selectId,
      testId,
    }: {
      value: string;
      options: { value: string; label: string }[];
      onChange: (v: string) => void;
      selectId?: string;
      testId?: string;
    }) =>
      React.createElement(
        "select",
        {
          id: selectId,
          "data-testid": testId,
          value,
          onChange: (e: { target: { value: string } }) =>
            onChange(e.target.value),
        },
        [
          React.createElement("option", { key: "", value: "" }, "-"),
          ...options.map((o) =>
            React.createElement(
              "option",
              { key: o.value, value: o.value },
              o.label,
            ),
          ),
        ],
      ),
    // Key-echoing translator; values are appended so assertions can see them.
    useTranslations:
      () => (key: string, values?: Record<string, unknown>) =>
        values ? `${key} ${JSON.stringify(values)}` : key,
  };
});

vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => false }));

const copyText = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
vi.mock("@/lib/calendar/calendar-actions", () => ({ copyText }));

type Shared = { id: string; url: string; redemptionCount: number } | null;
type Guest = {
  id: string;
  name: string | null;
  email: string;
  status: "SENT" | "USED" | "REVOKED" | "UNSENT";
  copyUrl: string | null;
};

const api = vi.hoisted(() => ({
  query: {
    isLoading: false,
    isError: false,
    isFetching: false,
    data: undefined as
      | { shared: Shared; guests: Guest[] }
      | undefined,
    refetch: vi.fn(),
  },
  lists: [] as { id: string; name: string }[],
  setSharedInvite: vi.fn(),
  createGuestInvites: vi.fn(),
  resendGuestInvite: vi.fn(),
  revokeGuestInvite: vi.fn(),
  invalidate: vi.fn(() => Promise.resolve(undefined)),
  mutationOptions: [] as { name: string; opts: unknown }[],
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      events: {
        listInvites: {
          invalidate: api.invalidate,
          getData: () => api.query.data,
        },
      },
      invitePauses: { status: { invalidate: vi.fn(), setData: vi.fn() } },
    }),
    // W4: not paused (InvitePauseNotice.test.tsx covers the paused states).
    invitePauses: {
      status: {
        useQuery: () => ({
          isLoading: false,
          isError: false,
          data: { paused: false, pause: null, lastDecision: null },
        }),
      },
    },
    events: {
      listInvites: { useQuery: () => api.query },
      setSharedInvite: {
        useMutation: (opts?: unknown) => {
          api.mutationOptions.push({ name: "setSharedInvite", opts });
          return { mutateAsync: api.setSharedInvite };
        },
      },
      createGuestInvites: {
        useMutation: (opts?: unknown) => {
          api.mutationOptions.push({ name: "createGuestInvites", opts });
          return { mutateAsync: api.createGuestInvites, isPending: false };
        },
      },
      resendGuestInvite: {
        useMutation: (opts?: unknown) => {
          api.mutationOptions.push({ name: "resendGuestInvite", opts });
          return { mutateAsync: api.resendGuestInvite };
        },
      },
      revokeGuestInvite: {
        useMutation: (opts?: unknown) => {
          api.mutationOptions.push({ name: "revokeGuestInvite", opts });
          return { mutateAsync: api.revokeGuestInvite };
        },
      },
    },
    comms: {
      listAudiences: {
        useQuery: () => ({
          isLoading: false,
          isError: false,
          data: api.lists,
          refetch: vi.fn(),
        }),
      },
    },
  },
}));

import { EventInviteSettings } from "../EventInviteSettings";
import {
  INVITE_ALLOWANCE_NUMBERS,
  inviteErrorMessage,
  summarizeListSend,
} from "../event-invite-helpers";
import {
  MIN_DISTINCT_SCANNED_HOLDERS,
  NEW_ACCOUNT_DAILY_RECIPIENTS,
  NEW_SENDER_DAILY_RECIPIENTS,
  TRACK_RECORD_DAILY_RECIPIENTS,
} from "@th/core/use-cases/events/invites/invite-allowance";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const OWNER = {
  ownerScope: "ORGANIZATION" as const,
  ownerId: "22222222-2222-4222-8222-222222222222",
};
const SHARED_URL =
  "https://ithasfire.com/events/vip-members-only-night?invite=inv_8f3kq2abcdef";

const MAYA: Guest = {
  id: "a0000000-0000-4000-8000-000000000001",
  name: "Maya Robinson",
  email: "maya@example.com",
  status: "USED",
  copyUrl: "https://ithasfire.com/e/x?invite=maya",
};
const DEV: Guest = {
  id: "a0000000-0000-4000-8000-000000000002",
  name: "Dev Patel",
  email: "dev.patel@example.com",
  status: "SENT",
  copyUrl: "https://ithasfire.com/e/x?invite=dev",
};
const SAM: Guest = {
  id: "a0000000-0000-4000-8000-000000000003",
  name: "Sam Lee",
  email: "sam.lee@example.com",
  status: "REVOKED",
  copyUrl: null,
};

const ZERO_SEND = {
  created: 0,
  reused: 0,
  sent: 0,
  skippedUnsubscribed: 0,
  skippedOptedOut: 0,
  skippedNoEmail: 0,
  failed: 0,
};

function renderPanel(
  gateType: "PASSWORD" | "APPLICATION" = "PASSWORD",
) {
  return render(
    <EventInviteSettings eventId={EVENT_ID} gateType={gateType} owner={OWNER} />,
  );
}

function trpcError(
  code: string,
  appCode?: string,
  meta?: Record<string, unknown>,
) {
  return Object.assign(new Error(appCode ?? code), {
    data: {
      code,
      ...(appCode ? { appCode } : {}),
      ...(meta ? { meta } : {}),
    },
  });
}

/** INVITE_ALLOWANCE_EXCEEDED as the client sees it (invite-allowance.ts). */
function allowanceError(meta: {
  requested: number;
  remaining: number;
  limit: number;
  tier?: "NEW_ACCOUNT" | "NEW_SENDER" | "TRACK_RECORD";
}) {
  return trpcError("TOO_MANY_REQUESTS", "INVITE_ALLOWANCE_EXCEEDED", {
    ...meta,
    windowSeconds: 86_400,
    retryAfterSeconds: 3_600,
    appCode: "INVITE_ALLOWANCE_EXCEEDED",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  copyText.mockImplementation(() => Promise.resolve(true));
  api.query.isLoading = false;
  api.query.isError = false;
  api.query.data = { shared: null, guests: [] };
  api.lists = [];
});

describe("EventInviteSettings — loading and errors", () => {
  it("shows a loading line while the invites load", () => {
    api.query.isLoading = true;
    api.query.data = undefined;
    renderPanel();
    expect(screen.getByRole("status").textContent).toBe("admin.ginLoading");
  });

  it("shows the load error with a retry that refetches", () => {
    api.query.isError = true;
    api.query.data = undefined;
    renderPanel();
    expect(screen.getByRole("alert").textContent).toBe("admin.ginLoadError");
    fireEvent.click(screen.getByTestId("invite-settings-retry"));
    expect(api.query.refetch).toHaveBeenCalledTimes(1);
  });
});

describe("EventInviteSettings — shared invite link", () => {
  it("is off by default with the password wording and turns on via ENABLE", async () => {
    api.setSharedInvite.mockResolvedValue({ id: "x", url: SHARED_URL });
    renderPanel("PASSWORD");
    expect(screen.getByText("admin.ginLinkOffPassword")).toBeTruthy();
    expect(screen.queryByTestId("invite-link-url")).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId("invite-link-turn-on"));
      await Promise.resolve();
    });
    expect(api.setSharedInvite).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      action: "ENABLE",
    });
    expect(api.invalidate).toHaveBeenCalledWith({ eventId: EVENT_ID });
  });

  it("says 'skips the application' on an APPLICATION event", () => {
    renderPanel("APPLICATION");
    expect(screen.getByText("admin.ginLinkOffApplication")).toBeTruthy();
    expect(screen.queryByText("admin.ginLinkOffPassword")).toBeNull();
  });

  it("shows the live link, the approval wording and the usage meta", () => {
    api.query.data = {
      shared: { id: "s1", url: SHARED_URL, redemptionCount: 23 },
      guests: [],
    };
    renderPanel("APPLICATION");
    const input = screen.getByTestId("invite-link-url") as HTMLInputElement;
    expect(input.value).toBe(SHARED_URL);
    expect(input.readOnly).toBe(true);
    expect(input.getAttribute("aria-label")).toBe("admin.ginLinkTitle");
    expect(screen.getByText("admin.ginLinkOnApplication")).toBeTruthy();
    expect(screen.getByText("admin.ginLinkResetHint")).toBeTruthy();
    expect(screen.getByTestId("invite-link-meta").textContent).toBe(
      'admin.ginLinkUsedMeta {"count":23}',
    );
  });

  it("copies the full URL, flips the label to Copied and announces it", async () => {
    api.query.data = {
      shared: { id: "s1", url: SHARED_URL, redemptionCount: 0 },
      guests: [],
    };
    renderPanel();
    const copy = screen.getByTestId("invite-link-copy");
    // Distinct from the builder's own public-link "Copy link".
    expect(copy.getAttribute("aria-label")).toBe("admin.ginCopySharedA11y");
    await act(async () => {
      fireEvent.click(copy);
      await Promise.resolve();
    });
    expect(copyText).toHaveBeenCalledWith(SHARED_URL);
    expect(copy.textContent).toBe("admin.ginCopied");
    // "Copied" keeps a name no other button on the builder page has.
    expect(copy.getAttribute("aria-label")).toBe("admin.ginCopiedSharedA11y");
    const live = screen
      .getAllByRole("status")
      .find((el) => el.getAttribute("aria-live") === "polite");
    expect(live?.textContent).toBe("admin.ginLinkCopied");
  });

  it("names a failed copy instead of claiming success", async () => {
    copyText.mockImplementation(() => Promise.resolve(false));
    api.query.data = {
      shared: { id: "s1", url: SHARED_URL, redemptionCount: 0 },
      guests: [],
    };
    renderPanel();
    await act(async () => {
      fireEvent.click(screen.getByTestId("invite-link-copy"));
      await Promise.resolve();
    });
    expect(screen.getByTestId("invite-link-copy-failed").textContent).toBe(
      "admin.ginCopyFailed",
    );
    expect(screen.getByTestId("invite-link-copy").textContent).toBe(
      "admin.ginCopyLink",
    );
  });

  it("sends RESET and DISABLE, and reports a failure inline", async () => {
    api.query.data = {
      shared: { id: "s1", url: SHARED_URL, redemptionCount: 2 },
      guests: [],
    };
    api.setSharedInvite.mockResolvedValueOnce({ id: "s2", url: SHARED_URL });
    renderPanel();
    // Reset asks first; nothing is sent by opening the dialog.
    fireEvent.click(screen.getByTestId("invite-link-reset"));
    expect(api.setSharedInvite).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByTestId("invite-link-reset-confirm"));
      await Promise.resolve();
    });
    expect(api.setSharedInvite).toHaveBeenLastCalledWith({
      eventId: EVENT_ID,
      action: "RESET",
    });

    api.setSharedInvite.mockRejectedValueOnce(
      trpcError("TOO_MANY_REQUESTS"),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("invite-link-turn-off"));
      await Promise.resolve();
    });
    expect(api.setSharedInvite).toHaveBeenLastCalledWith({
      eventId: EVENT_ID,
      action: "DISABLE",
    });
    expect(screen.getByTestId("invite-link-error").textContent).toBe(
      "admin.ginRateLimited",
    );
  });
});

describe("EventInviteSettings — invited guests", () => {
  it("shows the empty state with no guests", () => {
    renderPanel();
    expect(screen.getByTestId("guest-invites-empty").textContent).toBe(
      "admin.ginGuestsEmpty",
    );
  });

  it("validates name and email before sending anything", async () => {
    renderPanel();
    await act(async () => {
      fireEvent.click(screen.getByTestId("guest-invite-send"));
      await Promise.resolve();
    });
    expect(api.createGuestInvites).not.toHaveBeenCalled();
    expect(screen.getByText("admin.ginNameRequired")).toBeTruthy();
    expect(screen.getByText("admin.ginEmailInvalid")).toBeTruthy();
    expect(
      screen.getByTestId("guest-invite-name").getAttribute("aria-invalid"),
    ).toBe("true");
  });

  it("labels the add-guest inputs", () => {
    renderPanel();
    expect(screen.getByLabelText("admin.ginNameLabel")).toBe(
      screen.getByTestId("guest-invite-name"),
    );
    expect(screen.getByLabelText("admin.ginEmailLabel")).toBe(
      screen.getByTestId("guest-invite-email"),
    );
  });

  it("sends one invite and clears the form", async () => {
    api.createGuestInvites.mockResolvedValue({
      ...ZERO_SEND,
      created: 1,
      sent: 1,
    });
    renderPanel();
    fireEvent.change(screen.getByTestId("guest-invite-name"), {
      target: { value: "Maya Robinson" },
    });
    fireEvent.change(screen.getByTestId("guest-invite-email"), {
      target: { value: "maya@example.com" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("guest-invite-send"));
      await Promise.resolve();
    });
    expect(api.createGuestInvites).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      guests: [{ name: "Maya Robinson", email: "maya@example.com" }],
    });
    expect(
      screen.getByTestId("guest-invite-send-feedback").textContent,
    ).toBe('admin.ginSentTo {"email":"maya@example.com"}');
    expect(
      (screen.getByTestId("guest-invite-name") as HTMLInputElement).value,
    ).toBe("");
  });

  it("shows the not-published refusal next to Send on a draft event", async () => {
    api.createGuestInvites.mockRejectedValue(
      trpcError("PRECONDITION_FAILED", "EVENT_NOT_PUBLISHED"),
    );
    renderPanel();
    fireEvent.change(screen.getByTestId("guest-invite-name"), {
      target: { value: "Dev" },
    });
    fireEvent.change(screen.getByTestId("guest-invite-email"), {
      target: { value: "dev@example.com" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("guest-invite-send"));
      await Promise.resolve();
    });
    const feedback = screen.getByTestId("guest-invite-send-feedback");
    expect(feedback.textContent).toBe("admin.ginNotPublished");
    expect(feedback.getAttribute("role")).toBe("alert");
    expect(
      screen.getByTestId("guest-invite-send").getAttribute("aria-describedby"),
    ).toBe(feedback.id);
  });

  it("gives every row action a unique accessible name", () => {
    api.query.data = { shared: null, guests: [MAYA, DEV, SAM] };
    renderPanel();
    const names = screen
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label") ?? b.textContent ?? "");
    const rowNames = names.filter((n) => /Maya|Dev|Sam/.test(n));
    expect(new Set(rowNames).size).toBe(rowNames.length);
    expect(rowNames).toContain('admin.ginRevokeFor {"name":"Maya Robinson"}');
    expect(rowNames).toContain('admin.ginResendFor {"name":"Dev Patel"}');
    expect(rowNames).toContain('admin.ginCopyLinkFor {"name":"Dev Patel"}');
    expect(screen.getByTestId(`guest-invite-status-${MAYA.id}`).textContent).toBe(
      "admin.ginStatusUsed",
    );
    expect(screen.getByTestId(`guest-invite-status-${SAM.id}`).textContent).toBe(
      "admin.ginStatusRevoked",
    );
  });

  it("offers only Invite again on a revoked row, which re-invites the same guest", async () => {
    api.query.data = { shared: null, guests: [SAM] };
    api.createGuestInvites.mockResolvedValue({
      ...ZERO_SEND,
      created: 1,
      sent: 1,
    });
    renderPanel();
    const row = screen.getByTestId(`guest-invite-row-${SAM.id}`);
    expect(within(row).queryByTestId(`guest-invite-copy-${SAM.id}`)).toBeNull();
    expect(
      within(row).queryByTestId(`guest-invite-resend-${SAM.id}`),
    ).toBeNull();
    expect(
      within(row).queryByTestId(`guest-invite-revoke-${SAM.id}`),
    ).toBeNull();
    await act(async () => {
      fireEvent.click(
        within(row).getByTestId(`guest-invite-reinvite-${SAM.id}`),
      );
      await Promise.resolve();
    });
    expect(api.createGuestInvites).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      guests: [{ name: "Sam Lee", email: "sam.lee@example.com" }],
    });
  });

  it("asks before revoking, then revokes", async () => {
    api.query.data = { shared: null, guests: [DEV] };
    api.revokeGuestInvite.mockResolvedValue({
      inviteId: DEV.id,
      revoked: true,
      revokedAt: new Date(),
      unlocksRevoked: 1,
      submissionsRescinded: 0,
    });
    renderPanel();
    fireEvent.click(screen.getByTestId(`guest-invite-revoke-${DEV.id}`));
    expect(api.revokeGuestInvite).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText('admin.ginRevokeBody {"name":"Dev Patel"}'),
    ).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(dialog).getByText("admin.ginRevokeConfirm"));
      await Promise.resolve();
    });
    expect(api.revokeGuestInvite).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      inviteId: DEV.id,
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("resends and reports a row-level rate limit", async () => {
    api.query.data = { shared: null, guests: [DEV] };
    api.resendGuestInvite.mockRejectedValue(trpcError("TOO_MANY_REQUESTS"));
    renderPanel();
    await act(async () => {
      fireEvent.click(screen.getByTestId(`guest-invite-resend-${DEV.id}`));
      await Promise.resolve();
    });
    expect(api.resendGuestInvite).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      inviteId: DEV.id,
    });
    expect(
      screen.getByTestId(`guest-invite-feedback-${DEV.id}`).textContent,
    ).toBe("admin.ginRateLimited");
  });

  it("sends to a contact list and reports the counts in one line", async () => {
    api.lists = [{ id: "33333333-3333-4333-8333-333333333333", name: "VIPs" }];
    api.createGuestInvites.mockResolvedValue({
      ...ZERO_SEND,
      created: 42,
      sent: 41,
      skippedUnsubscribed: 3,
      failed: 1,
    });
    renderPanel();
    fireEvent.click(screen.getByTestId("guest-invite-list-open"));
    const dialog = screen.getByRole("dialog");
    expect(
      (within(dialog).getByTestId("guest-invite-list-send") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("admin.ginListLabel"), {
      target: { value: "33333333-3333-4333-8333-333333333333" },
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByTestId("guest-invite-list-send"));
      await Promise.resolve();
    });
    expect(api.createGuestInvites).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      contactListId: "33333333-3333-4333-8333-333333333333",
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("guest-invite-list-summary").textContent).toBe(
      'admin.ginListSentTo {"count":41} admin.ginListSkippedUnsubscribed {"count":3} admin.ginListFailed {"count":1}',
    );
  });
});

describe("summarizeListSend", () => {
  const t = (key: string, values?: Record<string, string | number>) =>
    `${key}:${values?.count}`;

  it("always leads with the sent count and drops zero parts", () => {
    expect(summarizeListSend(ZERO_SEND, t)).toBe("admin.ginListSentTo:0");
  });

  it("lists every non-zero part in order", () => {
    expect(
      summarizeListSend(
        {
          created: 5,
          reused: 2,
          sent: 5,
          skippedUnsubscribed: 1,
          skippedOptedOut: 3,
          skippedNoEmail: 4,
          failed: 0,
        },
        t,
      ),
    ).toBe(
      "admin.ginListSentTo:5 admin.ginListAlreadyInvited:2 admin.ginListSkippedUnsubscribed:1 admin.ginListSkippedOptedOut:3 admin.ginListSkippedNoEmail:4",
    );
  });
});

describe("inviteErrorMessage", () => {
  const t = (key: string) => key;
  // The shapes the client sees: AppError messages travel as `message`, the
  // canonical code as `data.appCode` (create-event-guest-invites.ts,
  // _shared.ts).
  const cases: [string, unknown, string][] = [
    [
      "a list over the 500 cap",
      Object.assign(new Error("guest_invite_list_too_large"), {
        data: { code: "BAD_REQUEST", appCode: "INVALID_INPUT" },
      }),
      "admin.ginListTooLarge",
    ],
    [
      "an unverified sender",
      Object.assign(new Error("EMAIL_NOT_VERIFIED"), {
        data: { code: "FORBIDDEN", appCode: "EMAIL_NOT_VERIFIED" },
      }),
      "admin.ginVerifyEmailToSend",
    ],
    [
      "an ended event",
      Object.assign(new Error("EVENT_ALREADY_ENDED"), {
        data: { code: "PRECONDITION_FAILED", appCode: "EVENT_ALREADY_ENDED" },
      }),
      "admin.ginEventEnded",
    ],
    [
      "a revoked invite",
      Object.assign(new Error("invite_revoked"), {
        data: { code: "PRECONDITION_FAILED", appCode: "INVALID_STATUS" },
      }),
      "admin.ginInviteWasRevoked",
    ],
    [
      "a gate that was removed",
      Object.assign(new Error("event_not_gated"), {
        data: { code: "PRECONDITION_FAILED", appCode: "INVALID_STATUS" },
      }),
      "admin.ginEventNotGated",
    ],
    [
      "a draft event",
      trpcError("PRECONDITION_FAILED", "EVENT_NOT_PUBLISHED"),
      "admin.ginNotPublished",
    ],
    ["the rate limiter", trpcError("TOO_MANY_REQUESTS"), "admin.ginRateLimited"],
  ];
  it.each(cases)("names %s", (_label, error, key) => {
    expect(inviteErrorMessage(error, t)).toBe(key);
  });

  it("ignores server messages that only match inherited properties", () => {
    const error = Object.assign(new Error("constructor"), {
      data: { code: "BAD_REQUEST" },
    });
    // Without the own-property check, MESSAGE_COPY["constructor"] is
    // Object.prototype.constructor and the translator is handed a function.
    const spy = vi.fn((key: unknown) => String(key));
    inviteErrorMessage(error, spy as unknown as (key: string) => string);
    for (const [key] of spy.mock.calls) expect(typeof key).toBe("string");
    expect(spy).not.toHaveBeenCalledWith(expect.stringMatching(/^admin\.gin/));
  });
});

describe("EventInviteSettings — stale rows and focus", () => {
  it("refetches the list when a resend hits an invite revoked elsewhere", async () => {
    api.query.data = { shared: null, guests: [DEV] };
    api.resendGuestInvite.mockRejectedValue(
      Object.assign(new Error("invite_revoked"), {
        data: { code: "PRECONDITION_FAILED", appCode: "INVALID_STATUS" },
      }),
    );
    renderPanel();
    await act(async () => {
      fireEvent.click(screen.getByTestId(`guest-invite-resend-${DEV.id}`));
      await Promise.resolve();
    });
    expect(
      screen.getByTestId(`guest-invite-feedback-${DEV.id}`).textContent,
    ).toBe("admin.ginInviteWasRevoked");
    expect(api.invalidate).toHaveBeenCalledWith({ eventId: EVENT_ID });
  });

  it("moves focus to the row's Invite again after a revoke", async () => {
    api.query.data = { shared: null, guests: [DEV] };
    api.revokeGuestInvite.mockResolvedValue({
      inviteId: DEV.id,
      revoked: true,
      revokedAt: new Date(),
      unlocksRevoked: 0,
      submissionsRescinded: 0,
    });
    const view = renderPanel();
    // The refetch returns the same row, now revoked; the cache updates
    // before invalidate() resolves, the render lands after (as in the app).
    api.invalidate.mockImplementationOnce(() => {
      api.query.data = {
        shared: null,
        guests: [{ ...DEV, status: "REVOKED", copyUrl: null }],
      };
      return Promise.resolve(undefined);
    });
    fireEvent.click(screen.getByTestId(`guest-invite-revoke-${DEV.id}`));
    await act(async () => {
      fireEvent.click(screen.getByText("admin.ginRevokeConfirm"));
      await Promise.resolve();
    });
    view.rerender(
      <EventInviteSettings eventId={EVENT_ID} gateType="PASSWORD" owner={OWNER} />,
    );
    expect(document.activeElement).toBe(
      screen.getByTestId(`guest-invite-reinvite-${DEV.id}`),
    );
  });
});

describe("EventInviteSettings — focus target is dropped on a no-op refetch", () => {
  it("does not move focus on a later update after an unchanged refetch", async () => {
    api.query.data = { shared: null, guests: [DEV] };
    api.revokeGuestInvite.mockResolvedValue({
      inviteId: DEV.id,
      revoked: true,
      revokedAt: new Date(),
      unlocksRevoked: 0,
      submissionsRescinded: 0,
    });
    const view = renderPanel();
    fireEvent.click(screen.getByTestId(`guest-invite-revoke-${DEV.id}`));
    await act(async () => {
      fireEvent.click(screen.getByText("admin.ginRevokeConfirm"));
      await Promise.resolve();
    });
    // The refetch changed nothing; later, an unrelated update arrives.
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    api.query.data = {
      shared: null,
      guests: [{ ...DEV, status: "REVOKED", copyUrl: null }],
    };
    view.rerender(
      <EventInviteSettings eventId={EVENT_ID} gateType="PASSWORD" owner={OWNER} />,
    );
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});

// ── Invite opt-out board (owner ruling 2026-10-06) ─────────────────────────

const LIST_ID = "33333333-3333-4333-8333-333333333333";

/** Opens the contact-list dialog, picks the list and presses Send. */
async function sendToList() {
  fireEvent.click(screen.getByTestId("guest-invite-list-open"));
  const dialog = screen.getByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText("admin.ginListLabel"), {
    target: { value: LIST_ID },
  });
  await act(async () => {
    fireEvent.click(within(dialog).getByTestId("guest-invite-list-send"));
    await Promise.resolve();
  });
}

async function sendOne() {
  fireEvent.change(screen.getByTestId("guest-invite-name"), {
    target: { value: "Sam" },
  });
  fireEvent.change(screen.getByTestId("guest-invite-email"), {
    target: { value: "sam@example.com" },
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId("guest-invite-send"));
    await Promise.resolve();
  });
}

describe("EventInviteSettings — people who stopped invites", () => {
  it("states the new list hint", () => {
    renderPanel();
    expect(screen.getByText("admin.ginInviteListHint")).toBeTruthy();
  });

  it("counts opted-out people in the list summary, never naming them", async () => {
    api.lists = [{ id: LIST_ID, name: "Autumn regulars" }];
    api.createGuestInvites.mockResolvedValue({
      ...ZERO_SEND,
      created: 3,
      sent: 3,
      skippedOptedOut: 1,
    });
    renderPanel();
    await sendToList();
    expect(screen.getByTestId("guest-invite-list-summary").textContent).toBe(
      'admin.ginListSentTo {"count":3} admin.ginListSkippedOptedOut {"count":1}',
    );
  });

  it("says a single opted-out guest was not sent, muted, keeping the form", async () => {
    api.createGuestInvites.mockResolvedValue({
      ...ZERO_SEND,
      skippedOptedOut: 1,
    });
    renderPanel();
    await sendOne();
    const line = screen.getByTestId("guest-invite-send-feedback");
    expect(line.textContent).toBe("admin.ginOptedOut");
    // Muted status, not an error alert: nothing went wrong.
    expect(line.getAttribute("role")).toBe("status");
    // The organiser typed it; it stays so they can see who it was.
    expect(
      (screen.getByTestId("guest-invite-email") as HTMLInputElement).value,
    ).toBe("sam@example.com");
  });

  it("says a resend to someone who has since opted out was not sent", async () => {
    api.query.data = { shared: null, guests: [DEV] };
    api.resendGuestInvite.mockResolvedValue({
      inviteId: DEV.id,
      sent: false,
      optedOut: true,
      sentAt: null,
    });
    renderPanel();
    await act(async () => {
      fireEvent.click(screen.getByTestId(`guest-invite-resend-${DEV.id}`));
      await Promise.resolve();
    });
    const line = screen.getByTestId(`guest-invite-feedback-${DEV.id}`);
    expect(line.textContent).toBe("admin.ginOptedOut");
    expect(line.getAttribute("role")).toBe("status");
  });
});

describe("EventInviteSettings — daily allowance (option A, state the rule)", () => {
  it("a new organiser's list: the list size, what fits, and the rule", async () => {
    api.lists = [{ id: LIST_ID, name: "Autumn regulars" }];
    api.createGuestInvites.mockRejectedValue(
      allowanceError({ requested: 40, remaining: 12, limit: 50 }),
    );
    renderPanel();
    await sendToList();
    const error = screen.getByTestId("guest-invite-list-error");
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.textContent).toBe(
      'admin.ginAllowanceList {"listCount":40,"remaining":12} admin.ginAllowanceRuleNew {"newDaily":50,"scanned":10,"trustedDaily":1000}',
    );
    // The dialog stays open: nothing was sent.
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("a new organiser with none left today: the spent line and the rule", async () => {
    api.lists = [{ id: LIST_ID, name: "Autumn regulars" }];
    api.createGuestInvites.mockRejectedValue(
      allowanceError({ requested: 40, remaining: 0, limit: 50 }),
    );
    renderPanel();
    await sendToList();
    expect(screen.getByTestId("guest-invite-list-error").textContent).toBe(
      'admin.ginAllowanceSpent {"limit":50} admin.ginAllowanceRuleNew {"newDaily":50,"scanned":10,"trustedDaily":1000}',
    );
  });

  it("an organiser with a track record gets the 1,000 rule", async () => {
    api.lists = [{ id: LIST_ID, name: "Autumn regulars" }];
    api.createGuestInvites.mockRejectedValue(
      allowanceError({ requested: 400, remaining: 120, limit: 1000 }),
    );
    renderPanel();
    await sendToList();
    expect(screen.getByTestId("guest-invite-list-error").textContent).toBe(
      'admin.ginAllowanceList {"listCount":400,"remaining":120} admin.ginAllowanceRuleTrusted {"trustedDaily":1000}',
    );
  });

  it("a sender whose account is under a week old: their own spent line and the new-account rule", async () => {
    api.createGuestInvites.mockRejectedValue(
      allowanceError({ requested: 1, remaining: 0, limit: 10, tier: "NEW_ACCOUNT" }),
    );
    renderPanel();
    await sendOne();
    const line = screen.getByTestId("guest-invite-send-feedback");
    expect(line.textContent).toBe(
      'admin.ginAllowanceSpentNewAccount {"limit":10} admin.ginAllowanceRuleNewAccount {"newAccountDaily":10}',
    );
    expect(line.getAttribute("role")).toBe("alert");
  });

  it("a new account's list: the list size, what fits, and the new-account rule", async () => {
    api.lists = [{ id: LIST_ID, name: "Autumn regulars" }];
    api.createGuestInvites.mockRejectedValue(
      allowanceError({ requested: 40, remaining: 7, limit: 10, tier: "NEW_ACCOUNT" }),
    );
    renderPanel();
    await sendToList();
    expect(screen.getByTestId("guest-invite-list-error").textContent).toBe(
      'admin.ginAllowanceList {"listCount":40,"remaining":7} admin.ginAllowanceRuleNewAccount {"newAccountDaily":10}',
    );
  });

  it("a tier from the server wins over the limit: an owner's 50 binding a new account states the organiser rule", async () => {
    api.createGuestInvites.mockRejectedValue(
      allowanceError({ requested: 6, remaining: 0, limit: 50, tier: "NEW_SENDER" }),
    );
    renderPanel();
    await sendOne();
    expect(screen.getByTestId("guest-invite-send-feedback").textContent).toBe(
      'admin.ginAllowanceSpent {"limit":50} admin.ginAllowanceRuleNew {"newDaily":50,"scanned":10,"trustedDaily":1000}',
    );
  });

  it("a single send over the limit says the allowance is spent", async () => {
    api.createGuestInvites.mockRejectedValue(
      allowanceError({ requested: 1, remaining: 0, limit: 1000 }),
    );
    renderPanel();
    await sendOne();
    const line = screen.getByTestId("guest-invite-send-feedback");
    expect(line.textContent).toBe(
      'admin.ginAllowanceSpent {"limit":1000} admin.ginAllowanceRuleTrusted {"trustedDaily":1000}',
    );
    expect(line.getAttribute("role")).toBe("alert");
  });
});

describe("inviteErrorMessage — opt-out board codes", () => {
  // formatErrorMessage treats `t(key) === key` as "no copy", so `errors.*`
  // keys resolve to a marked string here, as they do in the real catalog.
  const t = (key: string, values?: Record<string, string | number>) =>
    key.startsWith("errors.")
      ? `copy:${key}`
      : values
        ? `${key} ${JSON.stringify(values)}`
        : key;

  it("names the resend cooldown with the errors.* copy, not the generic 429", () => {
    const err = trpcError("TOO_MANY_REQUESTS", "INVITE_RESEND_TOO_SOON", {
      retryAfterSeconds: 540,
    });
    // formatErrorMessage reads the AppError message (= the code).
    expect(inviteErrorMessage(err, t)).toBe("copy:errors.inviteResendTooSoon");
  });

  it("says invites can't be sent while the limiter is down", () => {
    const err = Object.assign(new Error("Internal server error"), {
      data: { code: "INTERNAL_SERVER_ERROR", appCode: "SERVICE_UNAVAILABLE" },
    });
    expect(inviteErrorMessage(err, t)).toBe("admin.ginSendUnavailable");
  });

  it("falls back to the errors.* allowance line when the meta is missing", () => {
    const err = trpcError("TOO_MANY_REQUESTS", "INVITE_ALLOWANCE_EXCEEDED");
    expect(inviteErrorMessage(err, t, "list")).toBe(
      "copy:errors.inviteAllowanceExceeded",
    );
  });

  it("tells an unverified sender to verify their email, and where", () => {
    const err = trpcError("FORBIDDEN", "EMAIL_NOT_VERIFIED");
    expect(inviteErrorMessage(err, t)).toBe("admin.ginVerifyEmailToSend");
    expect(inviteErrorMessage(err, t, "list")).toBe("admin.ginVerifyEmailToSend");
  });

  it("keeps the generic rate-limit line for a bare 429", () => {
    expect(inviteErrorMessage(trpcError("TOO_MANY_REQUESTS"), t)).toBe(
      "admin.ginRateLimited",
    );
  });
});

describe("EventInviteSettings — Reset asks (option B)", () => {
  beforeEach(() => {
    api.query.data = {
      shared: { id: "s1", url: SHARED_URL, redemptionCount: 23 },
      guests: [],
    };
  });

  function radioIn(testId: string) {
    return within(screen.getByTestId(testId)).getByRole(
      "radio",
    ) as HTMLInputElement;
  }

  it("opens with Keep preselected and a primary Reset link", () => {
    renderPanel();
    expect(screen.getByText("admin.ginLinkResetHint")).toBeTruthy();
    fireEvent.click(screen.getByTestId("invite-link-reset"));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("admin.ginLinkResetTitle")).toBeTruthy();
    expect(within(dialog).getByText("admin.ginLinkResetBody")).toBeTruthy();
    expect(radioIn("invite-link-reset-keep").checked).toBe(true);
    expect(radioIn("invite-link-reset-remove").checked).toBe(false);
    const confirm = screen.getByTestId("invite-link-reset-confirm");
    expect(confirm.textContent).toBe("admin.ginLinkReset");
    expect(confirm.getAttribute("data-variant")).toBe("primary");
  });

  it("Cancel closes without resetting", () => {
    renderPanel();
    fireEvent.click(screen.getByTestId("invite-link-reset"));
    fireEvent.click(screen.getByTestId("invite-link-reset-cancel"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.setSharedInvite).not.toHaveBeenCalled();
  });

  it("Keep sends RESET and keeps the plain announcement", async () => {
    api.setSharedInvite.mockResolvedValue({ id: "s2", url: SHARED_URL });
    renderPanel();
    fireEvent.click(screen.getByTestId("invite-link-reset"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("invite-link-reset-confirm"));
      await Promise.resolve();
    });
    expect(api.setSharedInvite).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      action: "RESET",
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    const live = screen
      .getAllByRole("status")
      .find((el) => el.getAttribute("aria-live") === "polite");
    expect(live?.textContent).toBe("admin.ginLinkWasReset");
  });

  it("Remove turns the button red, sends RESET_AND_REMOVE and says who lost access", async () => {
    let finish: (v: unknown) => void = () => {};
    api.setSharedInvite.mockImplementation(
      () => new Promise((resolve) => (finish = resolve)),
    );
    renderPanel();
    fireEvent.click(screen.getByTestId("invite-link-reset"));
    fireEvent.click(radioIn("invite-link-reset-remove"));
    expect(radioIn("invite-link-reset-remove").checked).toBe(true);
    const confirm = screen.getByTestId("invite-link-reset-confirm");
    expect(confirm.textContent).toBe("admin.ginLinkResetRemoveConfirm");
    expect(confirm.getAttribute("data-variant")).toBe("destructive");
    expect(screen.getByTestId("invite-link-reset-remove").textContent).toBe(
      "admin.ginLinkResetRemoveLabeladmin.ginLinkResetRemoveDesc",
    );

    await act(async () => {
      fireEvent.click(confirm);
      await Promise.resolve();
    });
    expect(api.setSharedInvite).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      action: "RESET_AND_REMOVE",
    });
    // While it runs: "Removing…", and the choice can't change.
    expect(
      screen.getByTestId("invite-link-reset-confirm").textContent,
    ).toBe("admin.ginLinkResetRemoving");
    expect(radioIn("invite-link-reset-keep").disabled).toBe(true);

    await act(async () => {
      finish({
        id: "s2",
        url: SHARED_URL,
        removed: { namedGuestsKept: 2 },
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    const live = screen
      .getAllByRole("status")
      .find((el) => el.getAttribute("aria-live") === "polite");
    expect(live?.textContent).toBe("admin.ginLinkWasResetRemoved");
  });

  it("reopens on Keep after a Remove that was cancelled", () => {
    renderPanel();
    fireEvent.click(screen.getByTestId("invite-link-reset"));
    fireEvent.click(radioIn("invite-link-reset-remove"));
    fireEvent.click(screen.getByTestId("invite-link-reset-cancel"));
    fireEvent.click(screen.getByTestId("invite-link-reset"));
    expect(radioIn("invite-link-reset-keep").checked).toBe(true);
  });

  it("closes and shows a failed reset in the panel's error line", async () => {
    api.setSharedInvite.mockRejectedValue(trpcError("TOO_MANY_REQUESTS"));
    renderPanel();
    fireEvent.click(screen.getByTestId("invite-link-reset"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("invite-link-reset-confirm"));
      await Promise.resolve();
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("invite-link-error").textContent).toBe(
      "admin.ginRateLimited",
    );
  });
});

describe("allowance copy numbers", () => {
  it("match core's allowance constants", () => {
    expect(INVITE_ALLOWANCE_NUMBERS).toEqual({
      newDaily: NEW_SENDER_DAILY_RECIPIENTS,
      scanned: MIN_DISTINCT_SCANNED_HOLDERS,
      trustedDaily: TRACK_RECORD_DAILY_RECIPIENTS,
      newAccountDaily: NEW_ACCOUNT_DAILY_RECIPIENTS,
    });
  });
});

describe("no global toast on top of the inline error lines", () => {
  it("every invite mutation in the panel is silent", () => {
    api.mutationOptions.length = 0;
    api.lists = [{ id: LIST_ID, name: "VIPs" }];
    api.query.data = {
      shared: { id: "s1", url: SHARED_URL, redemptionCount: 0 },
      guests: [DEV],
    };
    renderPanel();
    fireEvent.click(screen.getByTestId("guest-invite-list-open"));
    const names = new Set(api.mutationOptions.map((m) => m.name));
    expect(names).toEqual(
      new Set([
        "setSharedInvite",
        "createGuestInvites",
        "resendGuestInvite",
        "revokeGuestInvite",
      ]),
    );
    for (const { name, opts } of api.mutationOptions) {
      expect({ name, opts }).toEqual({
        name,
        opts: { meta: { silent: true } },
      });
    }
  });
});
