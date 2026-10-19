import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NativeThemeProvider } from "@th/ui-native";

import { Platform } from "react-native";

import { announcements } from "../../../test/stubs/react-native";
import { AccessDeniedScreen } from "../access-denied-screen";
import type {
  CardClearedKind,
  LeaveRisk,
} from "../../features/pos/sale-attempt";
import type {
  AccessDeniedReason,
  CheckAgainResult,
} from "../../lib/use-access-revocation";

/**
 * The server refuses the scanner for two causes under one tRPC code. Each one
 * has a different fix, so each one gets its own words: telling platform staff
 * who lack a second factor to "ask for the SCANNER role" sends them to an org
 * admin who cannot help.
 *
 * Signing out deletes the scans still on the phone, so the screen shows them
 * and asks before a sign-out that would lose any.
 */
type ShowOpts = {
  reason?: AccessDeniedReason;
  unsentScans?: number;
  failedScans?: number;
  onSignOut?: () => Promise<void>;
  onCheckAgain?: () => Promise<CheckAgainResult>;
  cardCleared?: { kind: CardClearedKind | null; amount: string | null };
  clearedSale?: LeaveRisk | null;
};
const screenFor = (opts: ShowOpts) => (
  <NativeThemeProvider enabledThemes={["stub"]} defaultTheme="stub">
    <AccessDeniedScreen
      userEmail="op@example.test"
      onSignOut={opts.onSignOut ?? (async () => {})}
      onCheckAgain={opts.onCheckAgain}
      reason={opts.reason}
      unsentScans={opts.unsentScans}
      failedScans={opts.failedScans}
      cardCleared={opts.cardCleared}
      clearedSale={opts.clearedSale}
    />
  </NativeThemeProvider>
);
const show = (opts: ShowOpts = {}) => render(screenFor(opts));
const text = (testId: string) => screen.queryByTestId(testId)?.textContent ?? null;
const press = (testId: string) => fireEvent.click(screen.getByTestId(testId));

afterEach(() => {
  cleanup();
  announcements.length = 0;
});

describe("why the scanner refused", () => {
  it("no scan role (the default): says who can grant one", () => {
    show();

    const page = text("access-denied-screen") ?? "";
    expect(page).toContain("op@example.test");
    expect(page).toContain("SCANNER role");
    expect(page).toContain("sign out and try again with the email");
    expect(screen.queryByTestId("access-denied-second-factor")).toBeNull();
  });

  it("second factor required: says what to add and where, and does not mention roles", () => {
    show({ reason: "second_factor_required" });

    const line = text("access-denied-second-factor");
    expect(line).toContain("Platform staff accounts");
    expect(line).toContain("passkey");
    expect(line).toContain("authenticator app");
    expect(line).toContain("account settings on the web");
    const page = text("access-denied-screen") ?? "";
    expect(page).not.toContain("SCANNER role");
    expect(page).not.toContain("scanner role");
    // Sign-out is still there.
    expect(screen.getByTestId("access-denied-sign-out-button")).toBeTruthy();
  });
});

describe("the scans still on the phone", () => {
  it("shows how many are not sent and how many failed", () => {
    show({ unsentScans: 2, failedScans: 1 });
    expect(text("access-denied-scans-on-phone")).toBe(
      "2 scans on this phone are not sent yet, and 1 failed to send.",
    );
  });

  it("one kind only, in the singular", () => {
    show({ unsentScans: 1 });
    expect(text("access-denied-scans-on-phone")).toBe(
      "1 scan on this phone is not sent yet.",
    );
    cleanup();
    show({ failedScans: 1 });
    expect(text("access-denied-scans-on-phone")).toBe(
      "1 scan on this phone failed to send.",
    );
  });

  it("says nothing when there are none, and signs out at once", () => {
    const onSignOut = vi.fn(async () => {});
    show({ onSignOut });

    expect(screen.queryByTestId("access-denied-scans-on-phone")).toBeNull();
    press("access-denied-sign-out-button");
    expect(onSignOut).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("access-denied-sign-out-confirm")).toBeNull();
  });
});

describe("signing out with scans that would be lost", () => {
  it("asks first, saying they may not have been recorded", () => {
    const onSignOut = vi.fn(async () => {});
    show({ unsentScans: 2, failedScans: 1, onSignOut });

    press("access-denied-sign-out-button");

    expect(onSignOut).not.toHaveBeenCalled();
    const confirm =
      "Signing out deletes 3 scans this phone has not confirmed with the server. Those admissions may not have been recorded.";
    expect(text("access-denied-sign-out-confirm")).toBe(confirm);
    expect(announcements).toEqual([confirm]);
    expect(
      screen.getByTestId("access-denied-sign-out-confirm").closest("[aria-live]")
        ?.getAttribute("aria-live"),
    ).toBe("polite");
  });

  it("closes when the last scan is sent, and stays closed when another is queued", () => {
    const onSignOut = vi.fn(async () => {});
    const view = show({ unsentScans: 1, onSignOut });
    press("access-denied-sign-out-button");
    expect(screen.getByTestId("access-denied-sign-out-confirm")).toBeTruthy();

    view.rerender(screenFor({ onSignOut }));
    expect(screen.queryByTestId("access-denied-sign-out-confirm")).toBeNull();
    expect(screen.getByTestId("access-denied-sign-out-button")).toBeTruthy();

    view.rerender(screenFor({ unsentScans: 1, onSignOut }));
    expect(screen.queryByTestId("access-denied-sign-out-confirm")).toBeNull();
    expect(onSignOut).not.toHaveBeenCalled();
  });

  it("Stay signed in keeps them: no sign-out, back to the Sign out button", () => {
    const onSignOut = vi.fn(async () => {});
    show({ failedScans: 1, onSignOut });

    press("access-denied-sign-out-button");
    press("access-denied-stay-button");

    expect(onSignOut).not.toHaveBeenCalled();
    expect(screen.queryByTestId("access-denied-sign-out-confirm")).toBeNull();
    expect(screen.getByTestId("access-denied-sign-out-button")).toBeTruthy();
  });

  it("Sign out anyway signs out", () => {
    const onSignOut = vi.fn(async () => {});
    show({ unsentScans: 1, onSignOut });

    press("access-denied-sign-out-button");
    press("access-denied-sign-out-anyway-button");

    expect(onSignOut).toHaveBeenCalledTimes(1);
  });
});

describe("Check again", () => {
  it("asks the server, and shows nothing more while it is asking", async () => {
    let answer!: (result: CheckAgainResult) => void;
    const onCheckAgain = vi.fn(
      () =>
        new Promise<CheckAgainResult>((resolve) => {
          answer = resolve;
        }),
    );
    show({ onCheckAgain });

    press("access-denied-check-again-button");
    expect(onCheckAgain).toHaveBeenCalledTimes(1);
    expect(text("access-denied-check-again-button")).toBe("Checking…");
    // A second press while asking does not ask twice.
    press("access-denied-check-again-button");
    expect(onCheckAgain).toHaveBeenCalledTimes(1);

    await act(async () => {
      answer("granted");
    });
    expect(text("access-denied-check-again-button")).toBe("Check again");
    expect(screen.queryByTestId("access-denied-check-result")).toBeNull();
  });

  it("still refused: says so", async () => {
    show({ onCheckAgain: async () => "refused" });
    await act(async () => {
      press("access-denied-check-again-button");
    });
    expect(text("access-denied-check-result")).toBe(
      "Still no scanner access for this account.",
    );
    // Read out, and inside a polite live region.
    expect(announcements).toEqual(["Still no scanner access for this account."]);
    expect(
      screen.getByTestId("access-denied-check-result").closest("[aria-live]")
        ?.getAttribute("aria-live"),
    ).toBe("polite");
  });

  it("no answer: says the server could not be reached", async () => {
    show({ onCheckAgain: async () => "unreachable" });
    await act(async () => {
      press("access-denied-check-again-button");
    });
    expect(text("access-denied-check-result")).toBe(
      "Could not reach the server. Check your connection and try again.",
    );
    expect(announcements).toEqual([
      "Could not reach the server. Check your connection and try again.",
    ]);
  });

  it("is offered for a missing second factor too", () => {
    show({ reason: "second_factor_required", onCheckAgain: async () => "granted" });
    expect(screen.getByTestId("access-denied-check-again-button")).toBeTruthy();
  });
});

describe("on Android, a line in a live region is not also announced", () => {
  const platform = Platform as { OS: string };
  afterEach(() => {
    platform.OS = "ios";
  });

  it("Check again's result is read from its live region only", async () => {
    platform.OS = "android";
    show({ onCheckAgain: async () => "refused" });
    await act(async () => {
      press("access-denied-check-again-button");
    });

    expect(text("access-denied-check-result")).toBe(
      "Still no scanner access for this account.",
    );
    expect(announcements).toEqual([]);
  });

  it("the sign-out confirm too", () => {
    platform.OS = "android";
    show({ unsentScans: 1 });
    press("access-denied-sign-out-button");

    expect(screen.getByTestId("access-denied-sign-out-confirm")).toBeTruthy();
    expect(announcements).toEqual([]);
  });
});

describe("a card sale cleared on the way here", () => {
  it("says not to take cash for it, by its amount", () => {
    show({ cardCleared: { kind: "unconfirmed", amount: "$24.00" } });

    const notice = text("access-denied-card-cleared") ?? "";
    expect(notice).toContain("Don't take cash for the $24.00 card sale you cleared");
    expect(
      screen.getByTestId("access-denied-card-cleared").getAttribute("aria-live"),
    ).toBe("polite");
  });

  it("a cancel the server confirmed: says the card wasn't charged, and nothing about the till", () => {
    show({ cardCleared: { kind: "cancelled", amount: "$24.00" } });

    const notice = text("access-denied-card-cleared") ?? "";
    expect(notice).toContain("Card sale cancelled");
    expect(notice).toContain("The card wasn't charged.");
    expect(notice).not.toContain("ring those tickets up");
  });

  it("no notice: nothing shown", () => {
    show({ cardCleared: { kind: null, amount: null } });
    expect(screen.queryByTestId("access-denied-card-cleared")).toBeNull();
  });
});

describe("a sale cleared on the way here with no cancel", () => {
  it.each(["sending", "unresolved"] as const)(
    "%s: says the sale may have gone through",
    (risk) => {
      show({ clearedSale: risk });
      expect(text("access-denied-sale-cleared")).toBe(
        "The last sale may have gone through. Check before taking cash for it again.",
      );
    },
  );

  it("nothing cleared: no such line", () => {
    show({ clearedSale: null });
    expect(screen.queryByTestId("access-denied-sale-cleared")).toBeNull();
  });

  it("a card sale with its notice: the notice says it, no extra line", () => {
    show({
      clearedSale: "card",
      cardCleared: { kind: "unconfirmed", amount: "$24.00" },
    });
    expect(screen.getByTestId("access-denied-card-cleared")).toBeTruthy();
    expect(screen.queryByTestId("access-denied-sale-cleared")).toBeNull();
  });

  it("a card sale whose clear left no notice: the line stands in", () => {
    show({ clearedSale: "card", cardCleared: { kind: null, amount: null } });
    expect(screen.queryByTestId("access-denied-card-cleared")).toBeNull();
    expect(text("access-denied-sale-cleared")).toBe(
      "The last sale may have gone through. Check before taking cash for it again.",
    );
  });
});
