import React from "react";
import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TranslationProvider } from "@th/ui";
import type { Messages } from "@th/ui";
import enPackage from "@th/locale/messages/en.json";

import enApp from "@/i18n/messages/en";
import { pickDomProps } from "@/test-support/pick-dom-props";

/**
 * Force-verify pre-flight (B2): `platform.listHumans` flags an unverified
 * human whose email-attached rows the server would refuse to vouch for
 * (FORCE_VERIFY_HOLDS_EMAIL_ATTACHED). The item stays in the menu, marked
 * unavailable, with its reason visible and wired as its description.
 */

const forceVerify = vi.hoisted(() => vi.fn(() => Promise.resolve({})));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({ platform: { listHumans: { invalidate: vi.fn() } } }),
    platform: {
      setHumanStatus: {
        useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
      },
      forceVerifyEmail: {
        useMutation: () => ({ mutateAsync: forceVerify, isPending: false }),
      },
    },
  },
}));

vi.mock("../ManageAccountsDialog", () => ({ ManageAccountsDialog: () => null }));
vi.mock("../DeleteHumanDialog", () => ({ DeleteHumanDialog: () => null }));

vi.mock("tamagui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("tamagui")>();
  const Stack = React.forwardRef<HTMLDivElement, Record<string, unknown>>(
    ({ children, ...rest }, ref) => (
      <div ref={ref} {...pickDomProps(rest)}>
        {children as ReactNode}
      </div>
    ),
  );
  Stack.displayName = "Stack";
  return { ...actual, Stack, XStack: Stack, YStack: Stack };
});

vi.mock("@th/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@th/ui")>();
  const { ButtonStub } = await import("@/test-support/th-ui-button-stub");
  return {
    ...actual,
    Button: ButtonStub,
    Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    TextInput: () => null,
    Modal: () => null,
    Popover: ({
      anchor,
      open,
      children,
    }: {
      anchor: ReactNode;
      open: boolean;
      children?: ReactNode;
    }) => (
      <>
        {anchor}
        {open ? children : null}
      </>
    ),
    useNotify: () => ({ toast: { success: vi.fn(), danger: vi.fn() } }),
  };
});

import { HumanActions } from "../HumanActions";

const mergeCatalogs = (base: Messages, override: Messages): Messages => {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = result[key];
    result[key] =
      typeof value === "object" &&
      value !== null &&
      typeof existing === "object" &&
      existing !== null
        ? mergeCatalogs(existing as Messages, value as Messages)
        : value;
  }
  return result as Messages;
};
const messages = mergeCatalogs(enPackage as unknown as Messages, enApp);

const openMenu = (holdsEmailAttachedRows: boolean | null) => {
  render(
    <TranslationProvider locale="en" messages={messages}>
      <HumanActions
        isPlatformAdmin
        onMutationSuccess={vi.fn()}
        row={{
          id: "h1",
          name: "Sam",
          status: "ACTIVE",
          identity: { email: "sam@example.com", emailVerified: false },
          holdsEmailAttachedRows,
        }}
      />
    </TranslationProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Actions" }));
  return screen.getByRole("button", { name: "Force Verify Email" });
};

beforeEach(() => forceVerify.mockClear());

describe("HumanActions force-verify pre-flight", () => {
  it("marks the item unavailable and describes why when rows are attached", () => {
    const item = openMenu(true);
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).not.toBeDisabled(); // still focusable, so the reason is read
    expect(item).toHaveAccessibleDescription(
      "Holds tickets, orders or a lineup or volunteer role sent to this email. Ask them to sign in with an email code, which verifies it.",
    );
    expect(screen.getByTestId("force-verify-blocked-reason")).toBeVisible();

    fireEvent.click(item);
    expect(forceVerify).not.toHaveBeenCalled();
  });

  it.each([false, null])(
    "leaves the item live when the flag is %s",
    (flag) => {
      const item = openMenu(flag);
      expect(item).not.toHaveAttribute("aria-disabled");
      expect(item).not.toHaveAttribute("aria-describedby");
      expect(screen.queryByTestId("force-verify-blocked-reason")).toBeNull();

      fireEvent.click(item);
      expect(forceVerify).toHaveBeenCalledWith({ humanId: "h1" });
    },
  );
});
