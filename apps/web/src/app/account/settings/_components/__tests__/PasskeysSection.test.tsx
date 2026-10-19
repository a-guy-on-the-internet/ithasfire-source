import { forwardRef, type ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const testMocks = vi.hoisted(() => ({
  useSession: vi.fn(),
  listUserPasskeys: vi.fn(),
  addPasskey: vi.fn(),
  updatePasskey: vi.fn(),
  deletePasskey: vi.fn(),
  detectDeviceLabel: vi.fn(),
  invalidateStaff: vi.fn(),
  invalidateModerator: vi.fn(),
  toastSuccess: vi.fn(),
  toastDanger: vi.fn(),
  traceIgnoredError: vi.fn(),
}));

vi.mock("@/lib/auth/auth-client", () => ({
  authClient: {
    useSession: testMocks.useSession,
    passkey: {
      listUserPasskeys: testMocks.listUserPasskeys,
      addPasskey: testMocks.addPasskey,
      updatePasskey: testMocks.updatePasskey,
      deletePasskey: testMocks.deletePasskey,
    },
  },
}));

// Platform sniffing is covered by `src/lib/auth/__tests__/device-label.test.ts`.
// Mocking it here keeps the derived names deterministic (jsdom's UA reports
// neither a recognizable platform nor Client Hints).
vi.mock("@/lib/auth/device-label", () => ({
  detectDeviceLabel: testMocks.detectDeviceLabel,
}));

// Faithful to the real helper (`src/lib/trace-ignored-error.ts`): it returns a
// REJECTION HANDLER and honours the optional `expected` predicate, so a mock
// that ignored either would let a "we reported it" assertion pass against code
// that reports the wrong thing.
vi.mock("@/lib/trace-ignored-error", () => ({
  traceIgnoredError:
    (label: string, expected?: (err: unknown) => boolean) => (err: unknown) => {
      if (expected?.(err)) return;
      testMocks.traceIgnoredError(label, err);
    },
  isAbortError: () => false,
  isAutoplayBlocked: () => false,
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      platform: { checkStaffAccess: { invalidate: testMocks.invalidateStaff } },
      community: {
        checkModeratorAccess: { invalidate: testMocks.invalidateModerator },
      },
    }),
  },
}));

vi.mock("tamagui", () => {
  const Stack = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    XStack: Stack,
    YStack: Stack,
  };
});

vi.mock("../settings-primitives", () => ({
  SectionCard: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@th/ui", () => ({
  // forwardRef so the focus-restore assertions below exercise the real ref
  // plumbing (`ref` on the Rename button / the Add CTA) rather than a no-op.
  Button: forwardRef<
    HTMLButtonElement,
    {
      children?: ReactNode;
      disabled?: boolean;
      onPress?: () => void;
      "aria-label"?: string;
      "aria-busy"?: boolean;
      "aria-disabled"?: boolean;
      testID?: string;
    }
  >(({ children, disabled, onPress, ...rest }, ref) => (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      onClick={onPress}
      aria-label={rest["aria-label"]}
      aria-busy={rest["aria-busy"]}
      aria-disabled={rest["aria-disabled"]}
      data-testid={rest.testID}
    >
      {children}
    </button>
  )),
  Spinner: () => <span>Loading</span>,
  Text: ({
    children,
    ...rest
  }: {
    children?: ReactNode;
    id?: string;
    role?: string;
  }) => (
    <span id={rest.id} role={rest.role}>
      {children}
    </span>
  ),
  TextInput: ({
    autoFocus,
    disabled,
    maxLength,
    onChangeText,
    onKeyPress,
    onSubmitEditing,
    placeholder,
    value,
    ...rest
  }: {
    autoFocus?: boolean;
    disabled?: boolean;
    maxLength?: number;
    onChangeText?: (value: string) => void;
    onKeyPress?: (event: {
      nativeEvent: { key: string; isComposing?: boolean; keyCode?: number };
      preventDefault?: () => void;
    }) => void;
    onSubmitEditing?: () => void;
    placeholder?: string;
    value?: string;
    "aria-label"?: string;
    "aria-invalid"?: boolean;
    "aria-describedby"?: string;
  }) => (
    <input
      aria-label={rest["aria-label"]}
      aria-invalid={rest["aria-invalid"]}
      aria-describedby={rest["aria-describedby"]}
      autoFocus={autoFocus}
      disabled={disabled}
      maxLength={maxLength}
      placeholder={placeholder}
      value={value ?? ""}
      onChange={(event) => onChangeText?.(event.currentTarget.value)}
      // Mirrors react-native-web's TextInput (dist/exports/TextInput/index.js):
      // `onKeyPress` is wired to the DOM keydown event, and RNW's OWN Enter
      // branch — `onSubmitEditing` plus a deferred `blur()` — is gated on
      // `!e.isDefaultPrevented()`. Reproducing that gate here is what makes the
      // handler's `preventDefault()` observable; without it, deleting that line
      // left every test green.
      onKeyDown={(event) => {
        onKeyPress?.({
          nativeEvent: {
            key: event.key,
            isComposing: (
              event.nativeEvent as unknown as { isComposing?: boolean }
            ).isComposing,
            keyCode: event.keyCode,
          },
          preventDefault: () => event.preventDefault(),
        });
        if (event.key === "Enter" && !event.defaultPrevented) {
          onSubmitEditing?.();
          const node = event.currentTarget;
          setTimeout(() => node.blur(), 0);
        }
      }}
    />
  ),
  useNotify: () => ({
    toast: {
      success: testMocks.toastSuccess,
      danger: testMocks.toastDanger,
    },
  }),
}));

import { ABSENT_AAGUID } from "@th/types/passkey-aaguid";

import { PasskeysSection } from "../PasskeysSection";

/**
 * Real AAGUIDs from the pinned upstream dataset (see
 * `packages/types/src/passkey-aaguid-data.ts`). The mapping itself is covered
 * by `packages/types/src/__tests__/passkey-aaguid.test.ts`; these are here so
 * the component test exercises the actual table rather than a stub.
 */
const AAGUID = {
  onePassword: "bada5566-a7aa-401f-bd96-45619a55120d",
  windowsHello: "08987058-cadc-4b81-b6e1-30de50dcbe96",
  yubikey5: "cb69481e-8ff7-4039-93ec-0a2729a154a8",
  /** Well-formed, deliberately not a real model. */
  unknown: "ffffffff-ffff-ffff-ffff-ffffffffffff",
} as const;

interface StoredPasskey {
  id: string;
  name?: string | null;
  createdAt?: string;
  aaguid?: string | null;
}

/**
 * Drive a full enrollment: render with `before`, click Add, have
 * `addPasskey` resolve to `created`, and have the post-enrollment refetch
 * resolve to `after`.
 */
const enroll = async ({
  before = [],
  created,
  after,
}: {
  before?: StoredPasskey[];
  created: StoredPasskey | null;
  after: StoredPasskey[];
}) => {
  testMocks.listUserPasskeys.mockResolvedValue({ data: before });
  render(<PasskeysSection />);
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: /Add a passkey/i }),
    ).toBeInTheDocument(),
  );

  testMocks.addPasskey.mockResolvedValue({ data: created, error: null });
  testMocks.listUserPasskeys.mockResolvedValue({ data: after });
  fireEvent.click(screen.getByRole("button", { name: /Add a passkey/i }));
  await waitFor(() => expect(testMocks.addPasskey).toHaveBeenCalled());
};

const addedToastMessage = (): string =>
  (
    testMocks.toastSuccess.mock.calls.find(
      (call) => (call[0] as { id: string }).id === "passkey-added",
    )?.[0] as { message: string }
  ).message;

const nameInputLabel = (displayName: string) => `New name for ${displayName}`;
const NAME_INPUT_LABEL = nameInputLabel("macOS");

const renderAndLoad = async (
  passkeys: { id: string; name?: string | null; createdAt?: string }[],
) => {
  testMocks.listUserPasskeys.mockResolvedValue({ data: passkeys });
  render(<PasskeysSection />);
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: /Add a passkey/i }),
    ).toBeInTheDocument(),
  );
  return screen;
};

const openRename = (
  accessibleName: string | RegExp,
  inputLabel = NAME_INPUT_LABEL,
) => {
  fireEvent.click(screen.getByRole("button", { name: accessibleName }));
  return screen.getByLabelText(inputLabel);
};

describe("PasskeysSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The section short-circuits to an unsupported-browser message without it.
    vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
    testMocks.useSession.mockReturnValue({ data: { user: { name: "Tom" } } });
    testMocks.detectDeviceLabel.mockReturnValue("macOS");
    testMocks.listUserPasskeys.mockResolvedValue({ data: [] });
    // `/passkey/verify-registration` returns the created row verbatim and the
    // client passes it through as `data` (typed `Passkey`,
    // `@better-auth/passkey/dist/client.d.mts:115`). The default carries no
    // AAGUID, which is the common real-world case — privacy-preserving
    // authenticators report all zeroes — so the browser-derived name stands.
    testMocks.addPasskey.mockResolvedValue({
      data: { id: "pk_new", aaguid: ABSENT_AAGUID },
      error: null,
    });
    testMocks.updatePasskey.mockResolvedValue({ error: null });
    testMocks.deletePasskey.mockResolvedValue({ error: null });
  });

  describe("rename", () => {
    it("saves the normalized name and leaves edit mode", async () => {
      await renderAndLoad([
        { id: "pk_1", name: "macOS", createdAt: "2026-07-01T00:00:00.000Z" },
      ]);

      // Regex: this row HAS a createdAt, so its controls are date-qualified
      // ("Rename macOS, added Jul 1, 2026") — see the row-qualifier test below.
      const input = openRename(/^Rename macOS/);
      expect(input).toHaveValue("macOS");

      fireEvent.change(input, { target: { value: "  Work   laptop  " } });
      fireEvent.click(screen.getByRole("button", { name: /^Save new name for/ }));

      await waitFor(() =>
        expect(testMocks.updatePasskey).toHaveBeenCalledWith({
          id: "pk_1",
          name: "Work laptop",
        }),
      );
      expect(testMocks.toastSuccess).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "passkey-renamed",
          title: "Passkey renamed",
        }),
      );
      await waitFor(() =>
        expect(screen.queryByLabelText(NAME_INPUT_LABEL)).not.toBeInTheDocument(),
      );
      // A rename can't change second-factor enrollment status, so the gate
      // probes must NOT be invalidated (unlike add/delete).
      expect(testMocks.invalidateStaff).not.toHaveBeenCalled();
      expect(testMocks.invalidateModerator).not.toHaveBeenCalled();
    });

    it("saves on Enter", async () => {
      await renderAndLoad([{ id: "pk_1", name: "macOS" }]);

      const input = openRename("Rename macOS");
      fireEvent.change(input, { target: { value: "Studio iMac" } });
      fireEvent.keyDown(input, { key: "Enter" });

      await waitFor(() =>
        expect(testMocks.updatePasskey).toHaveBeenCalledWith({
          id: "pk_1",
          name: "Studio iMac",
        }),
      );
    });

    it("prefills an empty input for an unnamed passkey (never the placeholder)", async () => {
      await renderAndLoad([{ id: "pk_1", name: null }]);

      expect(screen.getByText("Untitled passkey")).toBeInTheDocument();
      expect(
        openRename(
          "Rename Untitled passkey",
          nameInputLabel("Untitled passkey"),
        ),
      ).toHaveValue("");
    });

    it("caps the input at the shared max length", async () => {
      await renderAndLoad([{ id: "pk_1", name: "macOS" }]);

      expect(openRename("Rename macOS")).toHaveAttribute("maxlength", "64");
    });

    it("disables Save for a blank or unchanged name", async () => {
      await renderAndLoad([{ id: "pk_1", name: "macOS" }]);

      const input = openRename("Rename macOS");
      // Unchanged.
      expect(screen.getByRole("button", { name: /^Save new name for/ })).toBeDisabled();

      // Blank.
      fireEvent.change(input, { target: { value: "   " } });
      expect(screen.getByRole("button", { name: /^Save new name for/ })).toBeDisabled();

      // Whitespace-only difference still counts as unchanged.
      fireEvent.change(input, { target: { value: "  macOS  " } });
      expect(screen.getByRole("button", { name: /^Save new name for/ })).toBeDisabled();

      fireEvent.change(input, { target: { value: "Work laptop" } });
      expect(screen.getByRole("button", { name: /^Save new name for/ })).toBeEnabled();
    });

    it("does not call the API when Enter is pressed on a blank name", async () => {
      await renderAndLoad([{ id: "pk_1", name: "macOS" }]);

      const input = openRename("Rename macOS");
      fireEvent.change(input, { target: { value: "  " } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(testMocks.updatePasskey).not.toHaveBeenCalled();
      expect(screen.getByLabelText(NAME_INPUT_LABEL)).toBeInTheDocument();
    });

    it("cancels on Escape without calling the API", async () => {
      await renderAndLoad([{ id: "pk_1", name: "macOS" }]);

      const input = openRename("Rename macOS");
      fireEvent.change(input, { target: { value: "Work laptop" } });
      fireEvent.keyDown(input, { key: "Escape" });

      expect(screen.queryByLabelText(NAME_INPUT_LABEL)).not.toBeInTheDocument();
      expect(testMocks.updatePasskey).not.toHaveBeenCalled();
      expect(screen.getByText("macOS")).toBeInTheDocument();
    });

    it("cancels on the Cancel button without calling the API", async () => {
      await renderAndLoad([{ id: "pk_1", name: "macOS" }]);

      openRename("Rename macOS");
      fireEvent.click(screen.getByRole("button", { name: /^Cancel renaming/ }));

      expect(screen.queryByLabelText(NAME_INPUT_LABEL)).not.toBeInTheDocument();
      expect(testMocks.updatePasskey).not.toHaveBeenCalled();
    });

    it("surfaces a toast and stays in edit mode when the API returns an error", async () => {
      testMocks.updatePasskey.mockResolvedValue({
        error: { message: "Passkey not found." },
      });
      await renderAndLoad([{ id: "pk_1", name: "macOS" }]);

      const input = openRename("Rename macOS");
      fireEvent.change(input, { target: { value: "Work laptop" } });
      fireEvent.click(screen.getByRole("button", { name: /^Save new name for/ }));

      await waitFor(() =>
        expect(testMocks.toastDanger).toHaveBeenCalledWith(
          expect.objectContaining({
            id: "passkey-rename-failed",
            title: "Couldn't rename passkey",
            message: "Passkey not found.",
          }),
        ),
      );
      expect(testMocks.toastSuccess).not.toHaveBeenCalled();
      // Edit mode intact, typed value preserved for a retry.
      expect(screen.getByLabelText(NAME_INPUT_LABEL)).toHaveValue("Work laptop");
    });

    it("surfaces a toast and stays in edit mode when the API throws", async () => {
      testMocks.updatePasskey.mockRejectedValue(new Error("Network down."));
      await renderAndLoad([{ id: "pk_1", name: "macOS" }]);

      const input = openRename("Rename macOS");
      fireEvent.change(input, { target: { value: "Work laptop" } });
      fireEvent.click(screen.getByRole("button", { name: /^Save new name for/ }));

      await waitFor(() =>
        expect(testMocks.toastDanger).toHaveBeenCalledWith(
          expect.objectContaining({
            id: "passkey-rename-failed",
            message: "Network down.",
          }),
        ),
      );
      expect(screen.getByLabelText(NAME_INPUT_LABEL)).toHaveValue("Work laptop");
    });

    it("shows a saving state and locks every other row's actions in flight", async () => {
      let resolveUpdate: (value: { error: null }) => void = () => {};
      testMocks.updatePasskey.mockReturnValue(
        new Promise<{ error: null }>((resolve) => {
          resolveUpdate = resolve;
        }),
      );
      await renderAndLoad([
        { id: "pk_1", name: "macOS" },
        { id: "pk_2", name: "iPhone" },
      ]);

      const input = openRename("Rename macOS");
      fireEvent.change(input, { target: { value: "Work laptop" } });
      fireEvent.click(screen.getByRole("button", { name: /^Save new name for/ }));

      // Queried by the STABLE aria-label, not by the "Saving…" text. The button
      // carries an explicit `aria-label` (several sections on /account/settings
      // render a "Save", so a bare name is ambiguous), and an explicit label
      // overrides text content as the accessible name. That is the correct ARIA
      // pattern: the name stays put and `aria-busy` carries the state, rather
      // than the name mutating to convey it. The visible "Saving…" swap is
      // asserted separately via text content below.
      const saving = await screen.findByRole("button", {
        name: /^Save new name for/,
      });
      expect(saving).toHaveTextContent(/Saving…/);
      // NOT `disabled`: that pulls in Button's disabledStyle (0.45 opacity),
      // which painted the spinner + "Saving…" — the only progress feedback there
      // is — at roughly 2:1. `aria-disabled` reproduces exactly the semantics
      // @th/ui's `disabled` already emitted (it never emits native `disabled`),
      // and `aria-busy` is the genuine addition — a "Save" → "Saving…" text swap
      // is not announced on its own. The duplicate press is stopped in
      // `handleRename`, asserted just below.
      expect(saving).toBeEnabled();
      expect(saving).toHaveAttribute("aria-busy", "true");
      expect(saving).toHaveAttribute("aria-disabled", "true");
      expect(screen.getByRole("button", { name: /^Cancel renaming/ })).toBeDisabled();
      expect(screen.getByLabelText(NAME_INPUT_LABEL)).toBeDisabled();
      // The untouched row must not offer actions that would race the save.
      expect(screen.getByRole("button", { name: "Rename iPhone" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Remove iPhone" })).toBeDisabled();

      // A second press while in flight must not fire a second request.
      fireEvent.click(saving);
      expect(testMocks.updatePasskey).toHaveBeenCalledTimes(1);

      resolveUpdate({ error: null });
      await waitFor(() =>
        expect(screen.queryByLabelText(NAME_INPUT_LABEL)).not.toBeInTheDocument(),
      );
    });

    it("keeps a removal readable and focusable while it is in flight", async () => {
      let resolveDelete: (value: { error: null }) => void = () => {};
      testMocks.deletePasskey.mockReturnValue(
        new Promise<{ error: null }>((resolve) => {
          resolveDelete = resolve;
        }),
      );
      await renderAndLoad([{ id: "pk_1", name: "macOS" }]);

      const remove = screen.getByRole("button", { name: "Remove macOS" });
      fireEvent.click(remove);

      await waitFor(() =>
        expect(remove).toHaveAttribute("aria-busy", "true"),
      );
      expect(remove).toBeEnabled();
      expect(remove).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(remove);
      expect(testMocks.deletePasskey).toHaveBeenCalledTimes(1);

      testMocks.listUserPasskeys.mockResolvedValue({ data: [] });
      resolveDelete({ error: null });
      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: "Remove macOS" }),
        ).not.toBeInTheDocument(),
      );
    });

    it("keeps only one row in edit mode at a time", async () => {
      await renderAndLoad([
        { id: "pk_1", name: "macOS" },
        { id: "pk_2", name: "iPhone" },
      ]);

      openRename("Rename macOS");
      expect(screen.getByLabelText(NAME_INPUT_LABEL)).toBeInTheDocument();

      const second = openRename("Rename iPhone", nameInputLabel("iPhone"));
      expect(screen.queryByLabelText(NAME_INPUT_LABEL)).not.toBeInTheDocument();
      expect(second).toHaveValue("iPhone");
    });

    it("owns the Enter key so RNW's submit-and-blur branch cannot also run", async () => {
      await renderAndLoad([{ id: "pk_1", name: "macOS" }]);

      const input = openRename("Rename macOS");
      fireEvent.change(input, { target: { value: "Studio iMac" } });

      // `fireEvent` returns dispatchEvent's result — false once preventDefault
      // has run. react-native-web gates its OWN Enter branch (onSubmitEditing
      // plus a deferred blur(), TextInput/index.js) on `!isDefaultPrevented()`,
      // so claiming the default IS the reason this handler exists. Without this
      // assertion, deleting the `preventDefault()` line leaves every other test
      // in this file green.
      expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
      await waitFor(() => expect(testMocks.updatePasskey).toHaveBeenCalled());
    });

    it("ignores an IME commit-candidate Enter instead of saving a pre-commit draft", async () => {
      await renderAndLoad([{ id: "pk_1", name: "macOS" }]);

      const input = openRename("Rename macOS");
      fireEvent.change(input, { target: { value: "しごと" } });

      // Chrome fires onChange DURING composition, so the draft here is a
      // pre-commit reading. The first Enter commits the IME candidate; it is not
      // a submit. Mirrors RNW's `isEventComposing` guard — and the default must
      // be left ALONE so the candidate commit isn't disturbed.
      expect(
        fireEvent.keyDown(input, { key: "Enter", isComposing: true }),
      ).toBe(true);
      expect(testMocks.updatePasskey).not.toHaveBeenCalled();

      // keyCode 229 is the legacy tell RNW also checks.
      expect(fireEvent.keyDown(input, { key: "Enter", keyCode: 229 })).toBe(
        true,
      );
      expect(testMocks.updatePasskey).not.toHaveBeenCalled();

      // Composition finished — the same key now saves.
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() =>
        expect(testMocks.updatePasskey).toHaveBeenCalledWith({
          id: "pk_1",
          name: "しごと",
        }),
      );
    });

    it("blocks a colliding rename and says so inline instead of silently suffixing", async () => {
      await renderAndLoad([
        { id: "pk_1", name: "macOS" },
        { id: "pk_2", name: "iPhone" },
      ]);

      const input = openRename("Rename macOS");
      // Case- and whitespace-insensitive: both sides go through
      // normalizePasskeyName, then fold.
      fireEvent.change(input, { target: { value: "  iPHONE " } });

      expect(screen.getByRole("alert")).toHaveTextContent(
        "You already have a passkey with that name.",
      );
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(input).toHaveAttribute(
        "aria-describedby",
        screen.getByRole("alert").id,
      );
      expect(screen.getByRole("button", { name: /^Save new name for/ })).toBeDisabled();

      fireEvent.keyDown(input, { key: "Enter" });
      expect(testMocks.updatePasskey).not.toHaveBeenCalled();

      // Typing away from the collision clears it live — the message is derived,
      // not stashed in state.
      fireEvent.change(input, { target: { value: "iPhone 15" } });
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^Save new name for/ })).toBeEnabled();
    });

    it("returns focus to the row's Rename button on every exit from edit mode", async () => {
      await renderAndLoad([{ id: "pk_1", name: "macOS" }]);
      const renameButton = () =>
        screen.getByRole("button", { name: "Rename macOS" });

      // Escape.
      fireEvent.keyDown(openRename("Rename macOS"), { key: "Escape" });
      expect(document.activeElement).toBe(renameButton());

      // Cancel.
      openRename("Rename macOS");
      fireEvent.click(screen.getByRole("button", { name: /^Cancel renaming/ }));
      expect(document.activeElement).toBe(renameButton());

      // Save.
      const input = openRename("Rename macOS");
      fireEvent.change(input, { target: { value: "Work laptop" } });
      fireEvent.click(screen.getByRole("button", { name: /^Save new name for/ }));
      await waitFor(() =>
        expect(
          screen.queryByLabelText(NAME_INPUT_LABEL),
        ).not.toBeInTheDocument(),
      );
      expect(document.activeElement).toBe(renameButton());
    });

    it("does not steal focus when the user opens another row's rename", async () => {
      await renderAndLoad([
        { id: "pk_1", name: "macOS" },
        { id: "pk_2", name: "iPhone" },
      ]);

      openRename("Rename macOS");
      const second = openRename("Rename iPhone", nameInputLabel("iPhone"));

      // Row 1 left edit mode, but focus was NOT orphaned — it moved to row 2's
      // field — so row 1 must not yank it back to its own Rename button.
      expect(document.activeElement).toBe(second);
    });

    it("keeps a mid-edit row mounted when an unrelated refetch lands", async () => {
      await renderAndLoad([
        { id: "pk_1", name: "macOS" },
        { id: "pk_2", name: "iPhone" },
      ]);

      const input = openRename("Rename macOS");
      fireEvent.change(input, { target: { value: "Work la" } });

      // Removing the OTHER row triggers refresh(). A refetch must not swap the
      // whole list for the loading spinner: that unmounted the open field, and
      // `autoFocus` re-fired on remount and threw the caret to the end.
      //
      // The refetch is held PENDING on purpose. With an already-resolved mock,
      // every state update lands in one microtask flush and React never commits
      // the intermediate `loading: true` render — so the assertion passes even
      // with the bug present. Holding the promise forces the in-flight render to
      // be real.
      let resolveList: (value: { data: { id: string; name: string }[] }) => void =
        () => {};
      testMocks.listUserPasskeys.mockReturnValue(
        new Promise<{ data: { id: string; name: string }[] }>((resolve) => {
          resolveList = resolve;
        }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Remove iPhone" }));

      await waitFor(() => expect(testMocks.deletePasskey).toHaveBeenCalled());
      expect(
        screen.queryByText("Loading your passkeys…"),
      ).not.toBeInTheDocument();
      // Same DOM node — never remounted.
      expect(screen.getByLabelText(NAME_INPUT_LABEL)).toBe(input);

      resolveList({ data: [{ id: "pk_1", name: "macOS" }] });
      await waitFor(() =>
        expect(screen.queryByText("iPhone")).not.toBeInTheDocument(),
      );
      expect(screen.getByLabelText(NAME_INPUT_LABEL)).toBe(input);
      expect(input).toHaveValue("Work la");
    });

    it("reconciles the list when the server refuses the rename", async () => {
      testMocks.updatePasskey.mockResolvedValue({
        error: { message: "Passkey not found." },
      });
      await renderAndLoad([{ id: "pk_1", name: "macOS" }]);

      const input = openRename("Rename macOS");
      fireEvent.change(input, { target: { value: "Work laptop" } });
      // The row was deleted in another tab; without a refetch the user retries
      // forever against a row that no longer exists server-side.
      testMocks.listUserPasskeys.mockResolvedValue({ data: [] });
      fireEvent.click(screen.getByRole("button", { name: /^Save new name for/ }));

      await waitFor(() =>
        expect(
          screen.getByText("No passkeys yet. Add one to skip the password next time."),
        ).toBeInTheDocument(),
      );
    });
  });

  describe("row-qualified control names", () => {
    it("date-qualifies the actions so two same-named passkeys stay distinguishable", async () => {
      await renderAndLoad([
        { id: "pk_1", name: "Android", createdAt: "2026-07-01T00:00:00.000Z" },
        { id: "pk_2", name: "Android", createdAt: "2026-07-20T00:00:00.000Z" },
      ]);

      const removes = screen.getAllByRole("button", { name: /^Remove Android/ });
      expect(removes).toHaveLength(2);
      for (const button of removes) {
        expect(button.getAttribute("aria-label")).toMatch(
          /^Remove Android, added .+/,
        );
      }
      expect(
        new Set(removes.map((b) => b.getAttribute("aria-label"))).size,
      ).toBe(2);
    });

    it("omits the date qualifier rather than rendering 'added —'", async () => {
      await renderAndLoad([{ id: "pk_1", name: "macOS" }]);

      expect(
        screen.getByRole("button", { name: "Remove macOS" }),
      ).toBeInTheDocument();
    });
  });

  describe("derived add name", () => {
    it("has no date in it and combines the display name with the device label", async () => {
      await renderAndLoad([]);

      fireEvent.click(screen.getByRole("button", { name: /Add a passkey/i }));

      await waitFor(() => expect(testMocks.addPasskey).toHaveBeenCalled());
      const { name } = testMocks.addPasskey.mock.calls[0][0] as {
        name: string;
      };
      expect(name).toBe("Tom’s macOS");
      // The old hand-rolled name appended `new Date().toLocaleDateString()`.
      expect(name).not.toMatch(/\d/);
      expect(name).not.toContain("·");
    });

    it("disambiguates against the names already on the account", async () => {
      testMocks.useSession.mockReturnValue({ data: { user: { name: null } } });
      await renderAndLoad([{ id: "pk_1", name: "macOS" }]);

      fireEvent.click(screen.getByRole("button", { name: /Add a passkey/i }));

      await waitFor(() =>
        expect(testMocks.addPasskey).toHaveBeenCalledWith({
          name: "macOS (2)",
        }),
      );
    });

    it("degrades to a device-free name when the platform can't be detected", async () => {
      testMocks.detectDeviceLabel.mockReturnValue(null);
      await renderAndLoad([]);

      fireEvent.click(screen.getByRole("button", { name: /Add a passkey/i }));

      await waitFor(() =>
        expect(testMocks.addPasskey).toHaveBeenCalledWith({
          name: "Tom’s passkey",
        }),
      );
    });
  });

  /**
   * The AAGUID identifies the authenticator MODEL and is the only signal that
   * separates iCloud Keychain from 1Password from a YubiKey. It does not exist
   * until the ceremony completes, but `addPasskey({ name })` sends the name
   * WITH the registration request — so the flow enrolls under the
   * browser-derived name and then immediately renames.
   */
  describe("AAGUID-derived name", () => {
    it("renames the new credential to its provider label after enrollment", async () => {
      await enroll({
        created: { id: "pk_new", aaguid: AAGUID.onePassword },
        after: [
          { id: "pk_new", name: "Tom’s macOS", aaguid: AAGUID.onePassword },
        ],
      });

      // Enrollment still goes out under the browser guess — the AAGUID is not
      // knowable yet at that point.
      expect(testMocks.addPasskey).toHaveBeenCalledWith({
        name: "Tom’s macOS",
      });
      await waitFor(() =>
        expect(testMocks.updatePasskey).toHaveBeenCalledWith({
          id: "pk_new",
          name: "Tom’s 1Password",
        }),
      );
      // The toast reports what is actually STORED, not the interim name.
      await waitFor(() =>
        expect(addedToastMessage()).toBe('Saved as "Tom’s 1Password".'),
      );
      expect(testMocks.toastDanger).not.toHaveBeenCalled();
      // Initial load, post-enrollment refetch, post-rename refetch.
      expect(testMocks.listUserPasskeys).toHaveBeenCalledTimes(3);
    });

    it("keeps the browser-derived name when the AAGUID is all zeroes", async () => {
      // The COMMON path, not an edge case: reporting a real AAGUID lets a
      // relying party fingerprint the authenticator, so privacy-preserving
      // platform authenticators zero it.
      await enroll({
        created: { id: "pk_new", aaguid: ABSENT_AAGUID },
        after: [{ id: "pk_new", name: "Tom’s macOS", aaguid: ABSENT_AAGUID }],
      });

      await waitFor(() =>
        expect(addedToastMessage()).toBe('Saved as "Tom’s macOS".'),
      );
      expect(testMocks.updatePasskey).not.toHaveBeenCalled();
      expect(testMocks.traceIgnoredError).not.toHaveBeenCalled();
    });

    it("keeps the browser-derived name for an AAGUID that is not in the table", async () => {
      await enroll({
        created: { id: "pk_new", aaguid: AAGUID.unknown },
        after: [{ id: "pk_new", name: "Tom’s macOS", aaguid: AAGUID.unknown }],
      });

      await waitFor(() =>
        expect(addedToastMessage()).toBe('Saved as "Tom’s macOS".'),
      );
      expect(testMocks.updatePasskey).not.toHaveBeenCalled();
    });

    it("falls all the way back to a device-free name when neither source has one", async () => {
      // Ladder: AAGUID label -> browser guess -> nothing.
      testMocks.detectDeviceLabel.mockReturnValue(null);
      await enroll({
        created: { id: "pk_new", aaguid: null },
        after: [{ id: "pk_new", name: "Tom’s passkey" }],
      });

      expect(testMocks.addPasskey).toHaveBeenCalledWith({
        name: "Tom’s passkey",
      });
      await waitFor(() =>
        expect(addedToastMessage()).toBe('Saved as "Tom’s passkey".'),
      );
      expect(testMocks.updatePasskey).not.toHaveBeenCalled();
    });

    it("skips the rename when the AAGUID label matches the name already stored", async () => {
      testMocks.useSession.mockReturnValue({ data: { user: { name: null } } });
      testMocks.detectDeviceLabel.mockReturnValue("Windows Hello");
      await enroll({
        created: { id: "pk_new", aaguid: AAGUID.windowsHello },
        after: [
          { id: "pk_new", name: "Windows Hello", aaguid: AAGUID.windowsHello },
        ],
      });

      await waitFor(() =>
        expect(addedToastMessage()).toBe('Saved as "Windows Hello".'),
      );
      expect(testMocks.updatePasskey).not.toHaveBeenCalled();
    });

    it("routes the AAGUID label through the shared collision suffix", async () => {
      testMocks.useSession.mockReturnValue({ data: { user: { name: null } } });
      await enroll({
        before: [{ id: "pk_1", name: "1Password" }],
        created: { id: "pk_2", aaguid: AAGUID.onePassword },
        // New row FIRST on purpose: identification must not depend on order.
        after: [
          { id: "pk_2", name: "macOS", aaguid: AAGUID.onePassword },
          { id: "pk_1", name: "1Password" },
        ],
      });

      await waitFor(() =>
        expect(testMocks.updatePasskey).toHaveBeenCalledWith({
          id: "pk_2",
          name: "1Password (2)",
        }),
      );
    });

    it("targets the new row by id even when a sibling shares its name", async () => {
      // Two rows already named "macOS" — the exact case the collision suffix
      // exists for, and the reason name and index are both unusable as keys.
      testMocks.useSession.mockReturnValue({ data: { user: { name: null } } });
      await enroll({
        before: [
          { id: "pk_1", name: "macOS" },
          { id: "pk_2", name: "macOS (2)" },
        ],
        created: { id: "pk_3", aaguid: AAGUID.yubikey5 },
        after: [
          { id: "pk_1", name: "macOS" },
          { id: "pk_2", name: "macOS (2)" },
          { id: "pk_3", name: "macOS (3)", aaguid: AAGUID.yubikey5 },
        ],
      });

      await waitFor(() =>
        expect(testMocks.updatePasskey).toHaveBeenCalledWith({
          id: "pk_3",
          name: "YubiKey 5 Series",
        }),
      );
    });

    it("identifies the new row by an id diff when the create response has none", async () => {
      testMocks.useSession.mockReturnValue({ data: { user: { name: null } } });
      await enroll({
        before: [{ id: "pk_1", name: "iPhone" }],
        created: null,
        after: [
          { id: "pk_1", name: "iPhone" },
          { id: "pk_2", name: "macOS", aaguid: AAGUID.yubikey5 },
        ],
      });

      await waitFor(() =>
        expect(testMocks.updatePasskey).toHaveBeenCalledWith({
          id: "pk_2",
          name: "YubiKey 5 Series",
        }),
      );
    });

    it("renames nothing when the id diff is ambiguous", async () => {
      // A second tab enrolled at the same moment. Renaming the wrong
      // credential is worse than leaving both under their browser names.
      await enroll({
        before: [],
        created: null,
        after: [
          { id: "pk_a", name: "Tom’s macOS", aaguid: AAGUID.onePassword },
          { id: "pk_b", name: "Tom’s macOS (2)", aaguid: AAGUID.yubikey5 },
        ],
      });

      await waitFor(() =>
        expect(addedToastMessage()).toBe('Saved as "Tom’s macOS".'),
      );
      expect(testMocks.updatePasskey).not.toHaveBeenCalled();
      expect(testMocks.traceIgnoredError).toHaveBeenCalledWith(
        "account.passkeys.aaguidRename.unidentified",
        expect.any(Error),
      );
    });

    it("renames nothing, and reports nothing, when the refetch fails", async () => {
      testMocks.listUserPasskeys.mockResolvedValue({ data: [] });
      render(<PasskeysSection />);
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: /Add a passkey/i }),
        ).toBeInTheDocument(),
      );

      testMocks.addPasskey.mockResolvedValue({
        data: { id: "pk_new", aaguid: AAGUID.onePassword },
        error: null,
      });
      // A failed refetch is not evidence about which row is new, and it is an
      // EXPECTED failure (`isExpectedListFailure`) — so no telemetry either.
      testMocks.listUserPasskeys.mockRejectedValue(new Error("Failed to fetch"));
      fireEvent.click(screen.getByRole("button", { name: /Add a passkey/i }));

      await waitFor(() =>
        expect(addedToastMessage()).toBe('Saved as "Tom’s macOS".'),
      );
      expect(testMocks.updatePasskey).not.toHaveBeenCalled();
      expect(testMocks.toastDanger).not.toHaveBeenCalled();
      expect(testMocks.traceIgnoredError).not.toHaveBeenCalled();
    });

    describe("best-effort: a failed rename never breaks enrollment", () => {
      it("keeps the enrollment successful when updatePasskey returns an error", async () => {
        testMocks.updatePasskey.mockResolvedValue({
          error: { message: "Passkey not found." },
        });
        await enroll({
          created: { id: "pk_new", aaguid: AAGUID.onePassword },
          after: [
            { id: "pk_new", name: "Tom’s macOS", aaguid: AAGUID.onePassword },
          ],
        });

        await waitFor(() => expect(testMocks.updatePasskey).toHaveBeenCalled());
        // Success, not failure: the credential is enrolled and usable. The
        // only casualty is a nicer label the user can set themselves.
        await waitFor(() =>
          expect(testMocks.toastSuccess).toHaveBeenCalledWith(
            expect.objectContaining({ id: "passkey-added" }),
          ),
        );
        expect(addedToastMessage()).toBe('Saved as "Tom’s macOS".');
        expect(testMocks.toastDanger).not.toHaveBeenCalled();
        expect(
          screen.queryByText(/Couldn't add passkey/i),
        ).not.toBeInTheDocument();
        // Swallowed for the USER, still reported for us.
        expect(testMocks.traceIgnoredError).toHaveBeenCalledWith(
          "account.passkeys.aaguidRename",
          expect.any(Error),
        );
      });

      it("keeps the enrollment successful when updatePasskey throws", async () => {
        const boom = new Error("Network down.");
        testMocks.updatePasskey.mockRejectedValue(boom);
        await enroll({
          created: { id: "pk_new", aaguid: AAGUID.onePassword },
          after: [
            { id: "pk_new", name: "Tom’s macOS", aaguid: AAGUID.onePassword },
          ],
        });

        await waitFor(() =>
          expect(testMocks.toastSuccess).toHaveBeenCalledWith(
            expect.objectContaining({ id: "passkey-added" }),
          ),
        );
        expect(addedToastMessage()).toBe('Saved as "Tom’s macOS".');
        expect(testMocks.toastDanger).not.toHaveBeenCalled();
        expect(testMocks.traceIgnoredError).toHaveBeenCalledWith(
          "account.passkeys.aaguidRename",
          boom,
        );
      });

      it("still re-enables the Add button after a failed rename", async () => {
        testMocks.updatePasskey.mockRejectedValue(new Error("Network down."));
        await enroll({
          created: { id: "pk_new", aaguid: AAGUID.onePassword },
          after: [
            { id: "pk_new", name: "Tom’s macOS", aaguid: AAGUID.onePassword },
          ],
        });

        await waitFor(() =>
          expect(screen.getByTestId("passkey-add")).toBeEnabled(),
        );
        expect(screen.getByTestId("passkey-add")).toHaveTextContent(
          /Add a passkey/i,
        );
      });
    });

    it("does not rename when the enrollment itself failed", async () => {
      testMocks.addPasskey.mockResolvedValue({
        data: null,
        error: { message: "Ceremony aborted." },
      });
      await renderAndLoad([]);
      fireEvent.click(screen.getByRole("button", { name: /Add a passkey/i }));

      await waitFor(() =>
        expect(testMocks.toastDanger).toHaveBeenCalledWith(
          expect.objectContaining({ id: "passkey-add-failed" }),
        ),
      );
      expect(testMocks.updatePasskey).not.toHaveBeenCalled();
      expect(testMocks.toastSuccess).not.toHaveBeenCalled();
    });
  });

  it("still removes a passkey and refreshes the second-factor gates", async () => {
    await renderAndLoad([{ id: "pk_1", name: "macOS" }]);

    fireEvent.click(screen.getByRole("button", { name: "Remove macOS" }));

    await waitFor(() =>
      expect(testMocks.deletePasskey).toHaveBeenCalledWith({ id: "pk_1" }),
    );
    expect(testMocks.invalidateStaff).toHaveBeenCalled();
  });

  it("hands focus to the Add CTA when a removal orphans it", async () => {
    await renderAndLoad([{ id: "pk_1", name: "macOS" }]);

    const remove = screen.getByRole("button", { name: "Remove macOS" });
    remove.focus();
    testMocks.listUserPasskeys.mockResolvedValue({ data: [] });
    fireEvent.click(remove);

    // The row unmounts, dropping focus to <body>. Without a restore a keyboard
    // user has to Tab from the top of the document past sections 01–05.
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId("passkey-add")),
    );
  });
});
