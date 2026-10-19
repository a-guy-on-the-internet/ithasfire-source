import { describe, expect, it } from "vitest";

import {
  INITIAL_FORM_SLOT,
  costFormKey,
  expectedFingerprint,
  formSlotReducer,
  isStale,
  keepsInputOnChange,
  liveKeysWithoutDeal,
  presetFormKey,
  releasedKey,
  sectionOfKey,
  type FormSlotAction,
  type FormSlotState,
} from "../deal-form-state";

const run = (...actions: FormSlotAction[]): FormSlotState =>
  actions.reduce(formSlotReducer, INITIAL_FORM_SLOT);

const COSTS = "deal-costs";

describe("the fingerprint a save sends", () => {
  it("is the one the form opened against, even after a refetch brought another", () => {
    const slot = run({ type: "open", key: "rest", fingerprint: "fp-1" });
    // A refetch landed between open and Save: the live read is now fp-2.
    expect(expectedFingerprint(slot, "fp-2")).toBe("fp-1");
  });

  it("is the live one when no form is open (a preset applied straight away)", () => {
    expect(expectedFingerprint(INITIAL_FORM_SLOT, "fp-2")).toBe("fp-2");
    expect(expectedFingerprint(INITIAL_FORM_SLOT, undefined)).toBeNull();
  });

  it("is null for a target with no deal yet", () => {
    const slot = run({ type: "open", key: "picker", fingerprint: null });
    expect(expectedFingerprint(slot, null)).toBeNull();
  });
});

describe("a deal that changed under an open form", () => {
  it("is flagged stale when the live fingerprint moves", () => {
    const slot = run({ type: "open", key: "rest", fingerprint: "fp-1" });
    expect(isStale(slot, "fp-2")).toBe(true);
    expect(isStale(slot, null)).toBe(true);
  });

  it("is not stale while the fingerprint holds, before a read settles, or with nothing open", () => {
    const slot = run({ type: "open", key: "rest", fingerprint: "fp-1" });
    expect(isStale(slot, "fp-1")).toBe(false);
    expect(isStale(slot, undefined)).toBe(false);
    expect(isStale(INITIAL_FORM_SLOT, "fp-9")).toBe(false);
  });

  it("re-seeds the form, says so, and snapshots the fresh fingerprint", () => {
    const opened = run({ type: "open", key: "rest", fingerprint: "fp-1" });
    const refreshed = formSlotReducer(opened, {
      type: "refreshed",
      fingerprint: "fp-2",
    });
    expect(refreshed.key).toBe("rest");
    expect(refreshed.changed).toBe(true);
    expect(refreshed.seed).toBeGreaterThan(opened.seed);
    expect(isStale(refreshed, "fp-2")).toBe(false);
    expect(expectedFingerprint(refreshed, "fp-2")).toBe("fp-2");
  });

  it("does not flag our own save: the saved fingerprint becomes the snapshot", () => {
    const slot = run(
      { type: "open", key: "rest", fingerprint: "fp-1" },
      { type: "saved", fingerprint: "fp-2" },
    );
    expect(isStale(slot, "fp-2")).toBe(false);
    expect(slot.changed).toBe(false);
  });

  it("is not fooled by the read lagging behind our own save", () => {
    const slot = run(
      { type: "open", key: "rest", fingerprint: "fp-1" },
      { type: "saved", fingerprint: "fp-2" },
    );
    // The save landed; its refetch has not: the read still says fp-1.
    expect(isStale(slot, "fp-1")).toBe(false);
    // Someone else's change after ours still counts.
    expect(isStale(slot, "fp-3")).toBe(true);
  });

  it("starts a reopened form unflagged", () => {
    const slot = run(
      { type: "open", key: "rest", fingerprint: "fp-1" },
      { type: "refreshed", fingerprint: "fp-2" },
      { type: "close" },
      { type: "open", key: "rest", fingerprint: "fp-2" },
    );
    expect(slot.changed).toBe(false);
  });

  it("ignores a refresh with nothing open", () => {
    expect(
      formSlotReducer(INITIAL_FORM_SLOT, {
        type: "refreshed",
        fingerprint: "fp-2",
      }),
    ).toBe(INITIAL_FORM_SLOT);
  });
});

describe("releasing the slot", () => {
  const clause = "clause:deal-clause-c1";

  it("releases a form whose row is no longer rendered", () => {
    const slot = run({ type: "open", key: clause, fingerprint: "fp-1" });
    expect(releasedKey(slot, ["rest", "clause:deal-clause-c2"])).toBe(clause);
    const pruned = formSlotReducer(slot, { type: "prune", liveKeys: ["rest"] });
    expect(pruned.key).toBeNull();
    expect(pruned.fingerprint).toBeNull();
  });

  it("keeps a form whose row is still there", () => {
    const slot = run({ type: "open", key: clause, fingerprint: "fp-1" });
    expect(releasedKey(slot, [clause, "rest"])).toBeNull();
    expect(formSlotReducer(slot, { type: "prune", liveKeys: [clause] })).toBe(
      slot,
    );
  });

  it("only closes the form it names", () => {
    const slot = run({ type: "open", key: clause, fingerprint: "fp-1" });
    expect(formSlotReducer(slot, { type: "close", key: "rest" }).key).toBe(
      clause,
    );
    expect(
      formSlotReducer(slot, { type: "close", key: clause }).key,
    ).toBeNull();
  });

  it("names the section to send focus to", () => {
    expect(sectionOfKey(costFormKey(COSTS, "d1"))).toBe("costs");
    expect(sectionOfKey("preset:deal-presets:SPLIT")).toBe("presets");
    expect(sectionOfKey(clause)).toBe("clauses");
    expect(sectionOfKey("rest")).toBe("clauses");
  });
});

describe("cost form keys", () => {
  it("follow the cost's id, so removing an earlier cost leaves the open form on its own row", () => {
    const before = [{ id: "d1" }, { id: "d2" }, { id: "d3" }];
    const slot = run({
      type: "open",
      key: costFormKey(COSTS, "d2"),
      fingerprint: "fp-1",
    });

    // Someone removes d1: d2 is now at index 0.
    const after = before.filter((d) => d.id !== "d1");
    const liveKeys = after.map((d) => costFormKey(COSTS, d.id));
    expect(releasedKey(slot, liveKeys)).toBeNull();
    expect(after.findIndex((d) => costFormKey(COSTS, d.id) === slot.key)).toBe(
      0,
    );
    expect(after[0]?.id).toBe("d2");
  });

  it("release the form when its own cost is removed", () => {
    const slot = run({
      type: "open",
      key: costFormKey(COSTS, "d2"),
      fingerprint: "fp-1",
    });
    const liveKeys = [costFormKey(COSTS, "d1"), costFormKey(COSTS, "d3")];
    expect(releasedKey(slot, liveKeys)).toBe(costFormKey(COSTS, "d2"));
  });

  it("use 'new' for a cost not saved yet", () => {
    expect(costFormKey(COSTS, null)).toBe("cost:deal-costs:new");
    expect(costFormKey(COSTS, undefined)).toBe("cost:deal-costs:new");
    expect(costFormKey(COSTS, "d1")).not.toBe(costFormKey(COSTS, null));
  });
});

describe("a form for something not saved yet (A3)", () => {
  const NEW_CLAUSE = "clause:deal-clause-new-22222222-2222-4222-8222-222222222222";
  const SAVED_CLAUSE = "clause:deal-clause-c-act";

  it("knows a new clause, a new cost and a preset from a saved row's form", () => {
    expect(keepsInputOnChange(NEW_CLAUSE)).toBe(true);
    expect(keepsInputOnChange(costFormKey(COSTS, null))).toBe(true);
    expect(keepsInputOnChange(presetFormKey("deal", "VERSUS"))).toBe(true);
    expect(keepsInputOnChange(SAVED_CLAUSE)).toBe(false);
    expect(keepsInputOnChange(costFormKey(COSTS, "d1"))).toBe(false);
    expect(keepsInputOnChange("rest")).toBe(false);
  });

  it("keeps what the user typed when the deal changes under it: same seed, flagged changed", () => {
    for (const key of [
      NEW_CLAUSE,
      costFormKey(COSTS, null),
      presetFormKey("deal", "GUARANTEE"),
    ]) {
      const opened = run({ type: "open", key, fingerprint: "fp-1" });
      const refreshed = formSlotReducer(opened, {
        type: "refreshed",
        fingerprint: "fp-2",
      });
      expect(refreshed.seed).toBe(opened.seed);
      expect(refreshed.changed).toBe(true);
      // The next save is against the deal now on screen.
      expect(expectedFingerprint(refreshed, "fp-2")).toBe("fp-2");
      expect(isStale(refreshed, "fp-2")).toBe(false);
    }
  });

  it("still re-seeds a saved row's form", () => {
    const opened = run({ type: "open", key: SAVED_CLAUSE, fingerprint: "fp-1" });
    const refreshed = formSlotReducer(opened, {
      type: "refreshed",
      fingerprint: "fp-2",
    });
    expect(refreshed.seed).toBe(opened.seed + 1);
  });

  it("matches the preset picker's own key", () => {
    expect(presetFormKey("ba-deal", "VERSUS")).toBe(
      "preset:ba-deal-presets:VERSUS",
    );
  });
});

describe("the slot outside a deal (A3)", () => {
  const PRESETS = ["GUARANTEE", "VERSUS"] as const;

  it("keeps only the preset forms in the editable empty state", () => {
    expect(liveKeysWithoutDeal("NO_DEAL", "deal", PRESETS, true)).toEqual([
      presetFormKey("deal", "GUARANTEE"),
      presetFormKey("deal", "VERSUS"),
    ]);
  });

  it("releases a clause form when a refetch says there is no deal any more", () => {
    const slot = run({
      type: "open",
      key: "clause:deal-clause-c-act",
      fingerprint: "fp-1",
    });
    const live = liveKeysWithoutDeal("NO_DEAL", "deal", PRESETS, true);
    expect(releasedKey(slot, live)).toBe("clause:deal-clause-c-act");
    const pruned = formSlotReducer(slot, { type: "prune", liveKeys: live });
    expect(pruned.key).toBeNull();
  });

  it("releases every form when the deal belongs to the booking, a refusal, or no terms", () => {
    const slot = run({
      type: "open",
      key: presetFormKey("deal", "VERSUS"),
      fingerprint: null,
    });
    for (const outcome of [
      "OWNED_BY_BOOKING",
      "NO_TERMS",
      "NOT_ALLOWED",
      "ERROR",
    ] as const) {
      const live = liveKeysWithoutDeal(outcome, "deal", PRESETS, true);
      expect(live).toEqual([]);
      expect(releasedKey(slot, live)).not.toBeNull();
    }
  });

  it("keeps nothing in an empty state nobody here can edit", () => {
    expect(liveKeysWithoutDeal("NO_DEAL", "deal", PRESETS, false)).toEqual([]);
  });
});
