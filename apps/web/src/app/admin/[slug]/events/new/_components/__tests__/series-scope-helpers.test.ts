import { describe, expect, it } from "vitest";

import {
  arrivalAreasSyncField,
  composeSyncToastMessage,
  includeArrivalAreasForSave,
  offersArrivalAreaSync,
  SERIES_EDIT_SCOPES,
  shouldOfferScopeDialog,
  syncScopeForChoice,
} from "../series-scope-helpers";

describe("syncScopeForChoice", () => {
  it("maps 'this' to null — no syncSeriesDrafts call at all", () => {
    expect(syncScopeForChoice("this")).toBeNull();
  });

  it("maps 'following' to the procedure's 'future' scope", () => {
    expect(syncScopeForChoice("following")).toBe("future");
  });

  it("maps 'all' to the procedure's 'all' scope", () => {
    expect(syncScopeForChoice("all")).toBe("all");
  });

  it("covers every dialog choice (guards against a new scope silently falling through)", () => {
    for (const scope of SERIES_EDIT_SCOPES) {
      // Each choice must resolve deliberately: null or a valid procedure arg.
      expect([null, "future", "all"]).toContain(syncScopeForChoice(scope));
    }
  });
});

describe("shouldOfferScopeDialog", () => {
  it("asks for events that already belong to a series", () => {
    expect(shouldOfferScopeDialog({ seriesId: "series-1" })).toBe(true);
  });

  it("never asks for non-series events (covers the convert flow — no siblings yet)", () => {
    expect(shouldOfferScopeDialog({ seriesId: null })).toBe(false);
    expect(shouldOfferScopeDialog({ seriesId: undefined })).toBe(false);
  });
});

describe("composeSyncToastMessage", () => {
  // Recording translate stub: returns "key{json}" so assertions can pin both
  // the key AND the ICU params without a locale provider.
  const translate = (key: string, params?: Record<string, number>) =>
    `${key}${params ? JSON.stringify(params) : ""}`;

  it("reports the updated-draft count alone when nothing published was skipped", () => {
    const message = composeSyncToastMessage(translate, {
      updatedDraftCount: 3,
      skippedPublishedCount: 0,
      skippedPastCount: 1,
    });
    expect(message).toBe('admin.ebScopeSyncedMessage{"count":3}');
  });

  it("appends the published-dates note when published dates were skipped", () => {
    const message = composeSyncToastMessage(translate, {
      updatedDraftCount: 2,
      skippedPublishedCount: 4,
      skippedPastCount: 0,
    });
    expect(message).toBe(
      'admin.ebScopeSyncedMessage{"count":2} admin.ebScopeSyncedPublishedNote{"count":4}',
    );
  });

  it("still reports a zero-update sync (ICU =0 branch carries the copy)", () => {
    const message = composeSyncToastMessage(translate, {
      updatedDraftCount: 0,
      skippedPublishedCount: 0,
      skippedPastCount: 0,
    });
    expect(message).toBe('admin.ebScopeSyncedMessage{"count":0}');
  });
});

describe("arrival-area sync option (owner ruling Q13)", () => {
  it("is offered only for scopes that sync, and only with the gate on", () => {
    expect(offersArrivalAreaSync("this", true)).toBe(false);
    expect(offersArrivalAreaSync("following", true)).toBe(true);
    expect(offersArrivalAreaSync("all", true)).toBe(true);
    expect(offersArrivalAreaSync("all", false)).toBe(false);
  });

  it("sends includeArrivalAreas only when offered AND ticked", () => {
    expect(
      includeArrivalAreasForSave({ scope: "all", arrivalAreasGateOn: true, ticked: true }),
    ).toBe(true);
    expect(
      includeArrivalAreasForSave({ scope: "all", arrivalAreasGateOn: true, ticked: false }),
    ).toBe(false);
    // A tick left behind after switching back to "this", or with the gate
    // turned off, never reaches the server.
    expect(
      includeArrivalAreasForSave({ scope: "this", arrivalAreasGateOn: true, ticked: true }),
    ).toBe(false);
    expect(
      includeArrivalAreasForSave({ scope: "following", arrivalAreasGateOn: false, ticked: true }),
    ).toBe(false);
  });
});

describe("arrivalAreasSyncField", () => {
  // An API older than the field rejects an unknown key under its strict
  // schema, so an unticked sync must not carry the key at all.
  it("adds no key when the box is not ticked", () => {
    const input = { seriesId: "s", ...arrivalAreasSyncField(false) };
    expect(input).toEqual({ seriesId: "s" });
    expect("includeArrivalAreas" in input).toBe(false);
  });

  it("sends includeArrivalAreas: true when ticked", () => {
    expect(arrivalAreasSyncField(true)).toEqual({ includeArrivalAreas: true });
  });
});

