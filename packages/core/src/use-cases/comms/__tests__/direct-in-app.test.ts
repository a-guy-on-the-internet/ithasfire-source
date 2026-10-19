import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { resaleListingCreatedRenderer } from "../direct-money-safety-renderers";
import { buildDirectInAppNotice } from "../direct-in-app";

const payload = {
  listingId: "l1",
  eventTitle: "Test Concert",
  askPriceCents: 2500,
  currency: "usd",
  listingUrl: "https://ithasfire.com/my/resale",
};

describe("buildDirectInAppNotice", () => {
  it("returns the English row, its kind and the stored template", () => {
    const notice = buildDirectInAppNotice({}, resaleListingCreatedRenderer, payload, {
      useCase: "test",
    });
    expect(notice).toMatchObject({
      variant: "resale.listing-created",
      title: "Ticket listed for resale",
      kind: "INFO",
      template: {
        key: "resale.listing-created",
        version: "1",
        variables: payload,
      },
    });
  });

  it("refuses a definition that is not the registered renderer", () => {
    const copy = { ...resaleListingCreatedRenderer };
    const unknown = {
      variant: "not.registered",
      category: "transactional" as const,
      schema: z.object({}),
      render: resaleListingCreatedRenderer.render as never,
    };
    expect(() =>
      buildDirectInAppNotice({}, copy, payload, { useCase: "test" }),
    ).toThrow(/not registered/);
    expect(() =>
      buildDirectInAppNotice({}, unknown, {}, { useCase: "test" }),
    ).toThrow(/not registered/);
  });

  it("reports an unstorable payload once and survives a throwing reporter", () => {
    const reportError = vi.fn(() => {
      throw new Error("sentry down");
    });
    const warn = vi.fn();
    const notice = buildDirectInAppNotice(
      { reportError, logger: { warn } as never },
      resaleListingCreatedRenderer,
      { ...payload, eventTitle: "T".repeat(20_000) },
      { useCase: "test" },
    );
    expect(notice.template).toBeUndefined();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "comms.direct_in_app.template_skipped",
      expect.objectContaining({ reason: "oversized", useCase: "test" }),
    );
  });
});
