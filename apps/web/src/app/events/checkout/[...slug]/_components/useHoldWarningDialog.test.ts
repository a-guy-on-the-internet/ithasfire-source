import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useHoldWarningDialog } from "./useHoldWarningDialog";
import { CONFIRMATION_HEADING_ID } from "./confirmation-heading";

describe("useHoldWarningDialog — never open over the confirmation", () => {
  it("regression: open, then the purchase confirms → the dialog closes", () => {
    const { result, rerender } = renderHook(
      ({ forceClosed }: { forceClosed: boolean }) =>
        useHoldWarningDialog({ forceClosed }),
      { initialProps: { forceClosed: false } },
    );
    act(() => result.current.openHoldWarning());
    expect(result.current.showHoldWarning).toBe(true);

    rerender({ forceClosed: true });
    expect(result.current.showHoldWarning).toBe(false);
  });

  it("stays closed while confirmed, even if something asks it to open", () => {
    const { result } = renderHook(() =>
      useHoldWarningDialog({ forceClosed: true }),
    );
    act(() => result.current.openHoldWarning());
    expect(result.current.showHoldWarning).toBe(false);
  });

  it("opens normally otherwise", () => {
    const { result } = renderHook(() => useHoldWarningDialog());
    act(() => result.current.openHoldWarning());
    expect(result.current.showHoldWarning).toBe(true);
  });
});

describe("useHoldWarningDialog — closed by the confirmation, focus goes back", () => {
  it("regression: force-closed → focus returns to where the dialog was opened from (not <body>)", async () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    try {
      const { result, rerender } = renderHook(
        ({ forceClosed }: { forceClosed: boolean }) =>
          useHoldWarningDialog({ forceClosed }),
        { initialProps: { forceClosed: false } },
      );
      act(() => result.current.openHoldWarning());
      // The dialog took focus (Cancel); simulate it leaving the opener.
      opener.blur();
      expect(document.activeElement).not.toBe(opener);

      rerender({ forceClosed: true });
      await waitFor(() => expect(document.activeElement).toBe(opener));
    } finally {
      opener.remove();
    }
  });
});

describe("useHoldWarningDialog — the opener is gone (it unmounted with the step)", () => {
  it("regression: focus goes to the confirmation's heading, not <body>", async () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    const heading = document.createElement("h1");
    heading.id = CONFIRMATION_HEADING_ID;
    heading.tabIndex = -1;
    opener.focus();
    try {
      const { result, rerender } = renderHook(
        ({ forceClosed }: { forceClosed: boolean }) => useHoldWarningDialog({ forceClosed }),
        { initialProps: { forceClosed: false } },
      );
      act(() => result.current.openHoldWarning());
      // The step (and its "Change tickets") unmounts; the confirmation mounts.
      opener.remove();
      document.body.appendChild(heading);
      rerender({ forceClosed: true });
      await waitFor(() => expect(document.activeElement).toBe(heading));
    } finally {
      heading.remove();
    }
  });
});

describe("useHoldWarningDialog — the confirmation is still loading (no heading yet)", () => {
  it("regression: focus goes to the heading once it mounts", async () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    const heading = document.createElement("h1");
    heading.id = CONFIRMATION_HEADING_ID;
    heading.tabIndex = -1;
    opener.focus();
    try {
      const { result, rerender } = renderHook(
        ({ forceClosed }: { forceClosed: boolean }) => useHoldWarningDialog({ forceClosed }),
        { initialProps: { forceClosed: false } },
      );
      act(() => result.current.openHoldWarning());
      opener.remove();
      // Confirmed, but the order's totals are still loading: no heading.
      rerender({ forceClosed: true });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(document.activeElement).not.toBe(heading);
      // The totals arrive and the confirmation (with its heading) mounts.
      document.body.appendChild(heading);
      await waitFor(() => expect(document.activeElement).toBe(heading));
    } finally {
      heading.remove();
    }
  });

  it("does not steal focus the buyer moved themselves before the heading mounted", async () => {
    const opener = document.createElement("button");
    const other = document.createElement("button");
    document.body.append(opener, other);
    const heading = document.createElement("h1");
    heading.id = CONFIRMATION_HEADING_ID;
    heading.tabIndex = -1;
    opener.focus();
    try {
      const { result, rerender } = renderHook(
        ({ forceClosed }: { forceClosed: boolean }) => useHoldWarningDialog({ forceClosed }),
        { initialProps: { forceClosed: false } },
      );
      act(() => result.current.openHoldWarning());
      opener.remove();
      rerender({ forceClosed: true });
      await new Promise((resolve) => setTimeout(resolve, 10));
      other.focus();
      document.body.appendChild(heading);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(document.activeElement).toBe(other);
    } finally {
      heading.remove();
      other.remove();
    }
  });
});
