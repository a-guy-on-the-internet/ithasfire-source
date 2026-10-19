/**
 * The entity-page settings save registry.
 *
 * Two forms (Profile, Theme) publish a save here and the toolbar commits all
 * of them at once. What is load-bearing and easy to break:
 *
 * - **Ownership-symbol cleanup.** Each hook instance mints one `Symbol` and
 *   `unregister` drops an entry only while the departing instance still owns
 *   it, so an outgoing instance's cleanup (which React may run AFTER the
 *   incoming one's setup) cannot delete the live registration.
 * - **Settled, not fail-fast.** One form rejecting must not stop the others
 *   from being attempted, and the caller must learn WHICH one failed.
 */
import { act, render, screen } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  PageSettingsSaveProvider,
  useRegisterPageSettingsSave,
  usePageSettingsSave,
  type PageSettingsSaveEntry,
  type PageSettingsSaveResults,
} from "../page-settings-save";

// ── Harness ───────────────────────────────────────────────────────────────

/** A registrant. Renders nothing; it exists to publish an entry. */
function Form(props: PageSettingsSaveEntry) {
  useRegisterPageSettingsSave(props);
  return null;
}

type Captured = {
  isDirty: boolean;
  isPending: boolean;
  isBlocked: boolean;
  saveAll: () => Promise<PageSettingsSaveResults>;
};

/** Stands in for the toolbar: exposes the aggregate to the test. */
function Toolbar({ onState }: { onState: (s: Captured) => void }) {
  const state = usePageSettingsSave();
  onState(state);
  return (
    <div
      data-testid="toolbar"
      data-dirty={String(state.isDirty)}
      data-pending={String(state.isPending)}
      data-blocked={String(state.isBlocked)}
    />
  );
}

function Host({
  children,
  onState,
}: {
  children?: ReactNode;
  onState: (s: Captured) => void;
}) {
  return (
    <PageSettingsSaveProvider>
      <Toolbar onState={onState} />
      {children}
    </PageSettingsSaveProvider>
  );
}

/** Latest aggregate the toolbar rendered with. */
function latest() {
  let current: Captured | null = null;
  return {
    onState: (s: Captured) => {
      current = s;
    },
    get: () => {
      if (!current) throw new Error("toolbar never rendered");
      return current as Captured;
    },
  };
}

const entry = (
  over: Partial<PageSettingsSaveEntry> & Pick<PageSettingsSaveEntry, "id">,
): PageSettingsSaveEntry => ({
  isDirty: true,
  isPending: false,
  save: () => {},
  ...over,
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe("page settings save registry — registration", () => {
  it("publishes a registered form's dirty/pending/blocked state to the toolbar", () => {
    const probe = latest();
    render(
      <Host onState={probe.onState}>
        <Form {...entry({ id: "profile", isDirty: true })} />
      </Host>,
    );

    expect(screen.getByTestId("toolbar")).toHaveAttribute("data-dirty", "true");
    expect(probe.get().isDirty).toBe(true);
    expect(probe.get().isBlocked).toBe(false);
  });

  it("is a no-op outside a provider (the forms stay renderable on their own)", () => {
    const save = vi.fn();
    expect(() =>
      render(<Form {...entry({ id: "profile", save })} />),
    ).not.toThrow();
    expect(save).not.toHaveBeenCalled();
  });

  it("drops the entry when its form unmounts", async () => {
    const probe = latest();
    function Switcher() {
      const [mounted, setMounted] = useState(true);
      return (
        <Host onState={probe.onState}>
          {mounted ? <Form {...entry({ id: "theme", isDirty: true })} /> : null}
          <button data-testid="unmount" onClick={() => setMounted(false)} />
        </Host>
      );
    }
    render(<Switcher />);
    expect(probe.get().isDirty).toBe(true);

    act(() => {
      screen.getByTestId("unmount").click();
    });

    expect(probe.get().isDirty).toBe(false);
    await expect(probe.get().saveAll()).resolves.toEqual({});
  });

  it("keeps the LIVE registration when a stale instance's cleanup runs late", async () => {
    // The ownership symbol's whole job. Two instances share the id "profile";
    // the outgoing one unmounts AFTER the incoming one has registered, so its
    // cleanup must not take the incoming one's entry with it.
    const probe = latest();
    const outgoing = vi.fn();
    const incoming = vi.fn();

    function Swap() {
      const [phase, setPhase] = useState<"a" | "both" | "b">("a");
      return (
        <Host onState={probe.onState}>
          {phase !== "b" ? (
            <Form
              {...entry({ id: "profile", save: outgoing })}
              key="outgoing"
            />
          ) : null}
          {phase !== "a" ? (
            <Form
              {...entry({ id: "profile", save: incoming })}
              key="incoming"
            />
          ) : null}
          <button data-testid="mount-b" onClick={() => setPhase("both")} />
          <button data-testid="drop-a" onClick={() => setPhase("b")} />
        </Host>
      );
    }
    render(<Swap />);

    act(() => screen.getByTestId("mount-b").click());
    act(() => screen.getByTestId("drop-a").click());

    // Still exactly one live "profile", and it is the INCOMING one.
    const results = await act(() => probe.get().saveAll());
    expect(Object.keys(results)).toEqual(["profile"]);
    expect(incoming).toHaveBeenCalledTimes(1);
    expect(outgoing).not.toHaveBeenCalled();
  });
});

describe("page settings save registry — saveAll", () => {
  it("resolves to an empty record when nothing is registered", async () => {
    const probe = latest();
    render(<Host onState={probe.onState} />);

    await expect(probe.get().saveAll()).resolves.toEqual({});
    expect(probe.get().isDirty).toBe(false);
  });

  it("attempts EVERY entry when one rejects, and keys the outcomes by id", async () => {
    const probe = latest();
    const boom = new Error("slug already taken");
    const themeSave = vi.fn(async () => {});
    const profileSave = vi.fn(async () => {
      throw boom;
    });

    render(
      <Host onState={probe.onState}>
        <Form {...entry({ id: "profile", save: profileSave })} />
        <Form {...entry({ id: "theme", save: themeSave })} />
      </Host>,
    );

    const results = await act(() => probe.get().saveAll());

    // Both were attempted — settled, not fail-fast.
    expect(profileSave).toHaveBeenCalledTimes(1);
    expect(themeSave).toHaveBeenCalledTimes(1);
    expect(results).toEqual({
      profile: { status: "rejected", reason: boom },
      theme: { status: "fulfilled" },
    });
  });

  it("treats a SYNCHRONOUS throw as a rejection without unwinding the others", async () => {
    const probe = latest();
    const boom = new Error("sync blowup");
    const themeSave = vi.fn(() => {});
    const profileSave = vi.fn(() => {
      throw boom;
    });

    render(
      <Host onState={probe.onState}>
        <Form {...entry({ id: "profile", save: profileSave })} />
        <Form {...entry({ id: "theme", save: themeSave })} />
      </Host>,
    );

    const results = await act(() => probe.get().saveAll());

    expect(themeSave).toHaveBeenCalledTimes(1);
    expect(results).toEqual({
      profile: { status: "rejected", reason: boom },
      theme: { status: "fulfilled" },
    });
  });

  it("still supports a plain sync `() => void` entry", async () => {
    const probe = latest();
    const save = vi.fn(() => {});

    render(
      <Host onState={probe.onState}>
        <Form {...entry({ id: "profile", save })} />
      </Host>,
    );

    const results = await act(() => probe.get().saveAll());

    expect(save).toHaveBeenCalledTimes(1);
    expect(results).toEqual({ profile: { status: "fulfilled" } });
  });

  it("skips clean and blocked forms — skipped is not failed, and they are absent from the record", async () => {
    const probe = latest();
    const clean = vi.fn();
    const blocked = vi.fn();
    const dirty = vi.fn();

    render(
      <Host onState={probe.onState}>
        <Form {...entry({ id: "clean", isDirty: false, save: clean })} />
        <Form {...entry({ id: "blocked", blocked: true, save: blocked })} />
        <Form {...entry({ id: "dirty", save: dirty })} />
      </Host>,
    );

    expect(probe.get().isBlocked).toBe(true);

    const results = await act(() => probe.get().saveAll());

    expect(clean).not.toHaveBeenCalled();
    expect(blocked).not.toHaveBeenCalled();
    expect(dirty).toHaveBeenCalledTimes(1);
    expect(results).toEqual({ dirty: { status: "fulfilled" } });
  });

  it("fires every save SYNCHRONOUSLY, before the returned promise is awaited", async () => {
    // The toolbar's `onPress={saveAll}` ignores the promise; the saves must
    // still all be in flight in the tick the button was pressed, as they were
    // when this was a plain for-loop.
    const probe = latest();
    const a = vi.fn(async () => {});
    const b = vi.fn(async () => {});

    render(
      <Host onState={probe.onState}>
        <Form {...entry({ id: "a", save: a })} />
        <Form {...entry({ id: "b", save: b })} />
      </Host>,
    );

    let pending!: Promise<PageSettingsSaveResults>;
    act(() => {
      pending = probe.get().saveAll();
      // No await yet.
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
    });
    await act(() => pending);
  });
});
