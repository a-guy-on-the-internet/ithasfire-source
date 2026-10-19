import { describe, expect, it } from "vitest";

import { extractOwnWithheldPlaceMeta } from "../own-withheld-place-error";

const trpcError = (appCode: string, meta?: unknown) =>
  Object.assign(new Error(appCode), { data: { appCode, meta } });

describe("extractOwnWithheldPlaceMeta", () => {
  it("reads the venue the refused address belongs to", () => {
    expect(
      extractOwnWithheldPlaceMeta(
        trpcError("EVENT_ADDRESS_IS_OWN_WITHHELD_PLACE", {
          placeId: "p-1",
          placeName: " The Bat Cave ",
        }),
      ),
    ).toEqual({ placeId: "p-1", placeName: "The Bat Cave" });
  });

  it("ignores every other code, even with the same meta shape", () => {
    expect(
      extractOwnWithheldPlaceMeta(
        trpcError("EVENT_LOCATION_REQUIRED", {
          placeId: "p-1",
          placeName: "The Bat Cave",
        }),
      ),
    ).toBeNull();
  });

  it("offers nothing when the meta can't name a venue", () => {
    for (const meta of [
      undefined,
      null,
      "p-1",
      { placeId: "p-1" },
      { placeName: "The Bat Cave" },
      { placeId: "", placeName: "The Bat Cave" },
      { placeId: "p-1", placeName: "   " },
    ]) {
      expect(
        extractOwnWithheldPlaceMeta(
          trpcError("EVENT_ADDRESS_IS_OWN_WITHHELD_PLACE", meta),
        ),
      ).toBeNull();
    }
  });

  it("tolerates non-error values", () => {
    expect(extractOwnWithheldPlaceMeta(null)).toBeNull();
    expect(extractOwnWithheldPlaceMeta("boom")).toBeNull();
  });
});
