import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockIcsFetch = vi.fn();
const mockFeedTokenMutateAsync = vi.fn();
const mockRotateFeedMutateAsync = vi.fn();
const mockToastDanger = vi.fn();
const mockToastSuccess = vi.fn();

/**
 * Minimal stand-in for the browser ClipboardItem (jsdom has none). Captures
 * the payload record so tests can resolve the "text/plain" promise.
 */
class FakeClipboardItem {
  data: Record<string, string | Blob | Promise<string | Blob>>;

  constructor(data: Record<string, string | Blob | Promise<string | Blob>>) {
    this.data = data;
  }
}

/** jsdom-safe Blob reader (older jsdom lacks Blob.prototype.text). */
const readBlobText = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    // `reader.error` is `DOMException | null`, and rejecting with null trips
    // @typescript-eslint/prefer-promise-reject-errors — which is an ERROR, not
    // a warning, so it fails `pnpm lint` and with it the CI quality gate that
    // every dev deploy job depends on.
    reader.onerror = () =>
      reject(reader.error ?? new Error("FileReader failed to read the blob"));
    reader.readAsText(blob);
  });

vi.mock("tamagui", () => {
  const passthrough = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  return { XStack: passthrough, YStack: passthrough, styled: () => passthrough };
});

vi.mock("@th/ui", () => ({
  Button: ({
    children,
    onPress,
    disabled,
    "data-testid": testId,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    "data-testid"?: string;
  }) => (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={() => onPress?.()}
    >
      {children}
    </button>
  ),
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  useTranslations: () => (key: string) => key,
  useNotify: () => ({
    toast: { success: mockToastSuccess, danger: mockToastDanger },
  }),
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      volunteer: {
        ics: { mySignupIcs: { fetch: mockIcsFetch } },
      },
    }),
    volunteer: {
      ics: {
        myFeedToken: {
          useMutation: () => ({
            mutateAsync: mockFeedTokenMutateAsync,
            isPending: false,
          }),
        },
        rotateMyFeedToken: {
          useMutation: () => ({
            mutateAsync: mockRotateFeedMutateAsync,
            isPending: false,
          }),
        },
      },
    },
  },
}));

vi.mock("@/config/env.public", () => ({
  publicRuntimeEnv: { apiBaseUrl: "https://api.ithasfire.com" },
}));

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: () => "err",
}));

import { AddToCalendarButton } from "../AddToCalendarButton";

describe("AddToCalendarButton", () => {
  // Own descriptor of any pre-existing navigator.clipboard override —
  // normally undefined (jsdom exposes clipboard via the prototype), in
  // which case restoring means deleting the test's own property.
  const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(
    navigator,
    "clipboard",
  );

  beforeEach(() => {
    mockIcsFetch.mockReset();
    mockFeedTokenMutateAsync.mockReset();
    mockRotateFeedMutateAsync.mockReset();
    mockToastDanger.mockReset();
    mockToastSuccess.mockReset();
  });

  afterEach(() => {
    // Drop any stubbed global ClipboardItem so fallback-path tests really
    // exercise the writeText branch.
    vi.unstubAllGlobals();
    // Restore the clipboard mock installed via Object.defineProperty so
    // state can't leak between tests.
    if (originalClipboardDescriptor) {
      Object.defineProperty(
        navigator,
        "clipboard",
        originalClipboardDescriptor,
      );
    } else {
      delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });

  it("copies the composed webcal feed URL on subscribe (writeText fallback, no ClipboardItem)", async () => {
    mockFeedTokenMutateAsync.mockResolvedValue({
      feedToken: "tok_abc",
      minted: true,
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render(<AddToCalendarButton />);
    fireEvent.click(screen.getByTestId("volunteer-feed-subscribe"));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        "webcal://api.ithasfire.com/api/volunteering/tok_abc/calendar.ics",
      );
    });
    expect(
      screen.getByText("volunteering.feedLinkCopied"),
    ).toBeInTheDocument();
  });

  it("uses a ClipboardItem promise payload on subscribe when available (Safari path)", async () => {
    mockFeedTokenMutateAsync.mockResolvedValue({
      feedToken: "tok_abc",
      minted: true,
    });
    const write = vi.fn().mockResolvedValue(undefined);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { write, writeText },
      configurable: true,
    });
    vi.stubGlobal("ClipboardItem", FakeClipboardItem);

    render(<AddToCalendarButton />);
    fireEvent.click(screen.getByTestId("volunteer-feed-subscribe"));

    await waitFor(() => {
      expect(write).toHaveBeenCalledTimes(1);
    });
    // The Safari path must never fall back to writeText.
    expect(writeText).not.toHaveBeenCalled();

    const [items] = write.mock.calls[0] as [FakeClipboardItem[]];
    expect(items).toHaveLength(1);
    const payload = await items[0]!.data["text/plain"];
    expect(payload).toBeInstanceOf(Blob);
    expect(await readBlobText(payload as Blob)).toBe(
      "webcal://api.ithasfire.com/api/volunteering/tok_abc/calendar.ics",
    );

    await waitFor(() => {
      expect(
        screen.getByText("volunteering.feedLinkCopied"),
      ).toBeInTheDocument();
    });
  });

  it("uses a ClipboardItem promise payload on reset with the FRESH token (Safari path)", async () => {
    mockRotateFeedMutateAsync.mockResolvedValue({
      feedToken: "tok_fresh",
      minted: true,
    });
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { write },
      configurable: true,
    });
    vi.stubGlobal("ClipboardItem", FakeClipboardItem);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<AddToCalendarButton />);
    fireEvent.click(screen.getByTestId("volunteer-feed-reset"));

    await waitFor(() => {
      expect(write).toHaveBeenCalledTimes(1);
    });
    const [items] = write.mock.calls[0] as [FakeClipboardItem[]];
    const payload = await items[0]!.data["text/plain"];
    expect(await readBlobText(payload as Blob)).toBe(
      "webcal://api.ithasfire.com/api/volunteering/tok_fresh/calendar.ics",
    );
    confirmSpy.mockRestore();
  });

  it("surfaces the copy-blocked toast AND logs when the clipboard write is rejected", async () => {
    mockFeedTokenMutateAsync.mockResolvedValue({
      feedToken: "tok_abc",
      minted: true,
    });
    const writeText = vi
      .fn()
      .mockRejectedValue(new DOMException("blocked", "NotAllowedError"));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    render(<AddToCalendarButton />);
    fireEvent.click(screen.getByTestId("volunteer-feed-subscribe"));

    await waitFor(() => {
      expect(mockToastDanger).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "volunteer-feed-subscribe-failed",
          message: "volunteering.feedCopyBlocked",
        }),
      );
    });
    expect(consoleError).toHaveBeenCalledWith(
      "volunteer feed subscribe failed",
      expect.any(DOMException),
    );
    consoleError.mockRestore();
  });

  it("shows the mutation error (NOT feedCopyBlocked) when the token mutation rejects on the Safari path", async () => {
    // API-down: the token mutation rejects. The rejected payload promise
    // inside ClipboardItem makes clipboard.write reject with NotAllowedError
    // — indistinguishable from a real clipboard block without the handler's
    // explicit mutation-failure tracking.
    mockFeedTokenMutateAsync.mockRejectedValue(new Error("api down"));
    const write = vi
      .fn()
      .mockRejectedValue(new DOMException("blocked", "NotAllowedError"));
    Object.defineProperty(navigator, "clipboard", {
      value: { write },
      configurable: true,
    });
    vi.stubGlobal("ClipboardItem", FakeClipboardItem);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    render(<AddToCalendarButton />);
    fireEvent.click(screen.getByTestId("volunteer-feed-subscribe"));

    // copyTextFromPromise calls clipboard.write synchronously inside the
    // handler — swallow the fake payload promise's rejection right away so
    // it never surfaces as an unhandled rejection.
    const [items] = write.mock.calls[0] as [FakeClipboardItem[]];
    await expect(
      Promise.resolve(items[0]!.data["text/plain"]),
    ).rejects.toThrow("api down");

    await waitFor(() => {
      expect(mockToastDanger).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "volunteer-feed-subscribe-failed",
          // formatErrorMessage (mocked to "err") — NOT the copy-blocked copy.
          message: "err",
        }),
      );
    });
    // The underlying tRPC error (not the masking NotAllowedError) is logged.
    expect(consoleError).toHaveBeenCalledWith(
      "volunteer feed subscribe failed",
      expect.objectContaining({ message: "api down" }),
    );
    consoleError.mockRestore();
  });

  it("fetches the per-signup ics on download", async () => {
    mockIcsFetch.mockResolvedValue({
      filename: "door-volunteering.ics",
      icsBody: "BEGIN:VCALENDAR\nEND:VCALENDAR",
    });
    // jsdom lacks URL.createObjectURL — stub the blob download plumbing.
    const createObjectURL = vi.fn(() => "blob:mock");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      value: createObjectURL,
      configurable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      value: revokeObjectURL,
      configurable: true,
    });

    render(<AddToCalendarButton signupId="signup-1" showFeedSubscribe={false} />);
    fireEvent.click(screen.getByTestId("volunteer-ics-download"));

    await waitFor(() => {
      expect(mockIcsFetch).toHaveBeenCalledWith({ signupId: "signup-1" });
    });
    expect(createObjectURL).toHaveBeenCalled();
  });

  it("rotates the token and copies the NEW webcal URL after the user confirms", async () => {
    mockRotateFeedMutateAsync.mockResolvedValue({
      feedToken: "tok_fresh",
      minted: true,
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<AddToCalendarButton />);
    fireEvent.click(screen.getByTestId("volunteer-feed-reset"));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        "webcal://api.ithasfire.com/api/volunteering/tok_fresh/calendar.ics",
      );
    });
    expect(confirmSpy).toHaveBeenCalled();
    expect(mockRotateFeedMutateAsync).toHaveBeenCalledWith({});
    confirmSpy.mockRestore();
  });

  it("does NOT rotate when the confirm is declined", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    render(<AddToCalendarButton />);
    fireEvent.click(screen.getByTestId("volunteer-feed-reset"));

    expect(mockRotateFeedMutateAsync).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("renders no download button without a signupId", () => {
    render(<AddToCalendarButton />);
    expect(
      screen.queryByTestId("volunteer-ics-download"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("volunteer-feed-subscribe")).toBeInTheDocument();
  });
});
