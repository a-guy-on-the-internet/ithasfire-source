import { describe, expect, it } from "vitest";

import { createFailClosedModerationAdapter } from "./fail-closed-moderation-adapter";

describe("createFailClosedModerationAdapter", () => {
  it("returns a degraded FLAGGED result for every image (no auto-approve)", async () => {
    const adapter = createFailClosedModerationAdapter();

    const result = await adapter.moderateImage({
      imageBytes: new Uint8Array([1, 2, 3, 4]),
      contentType: "image/jpeg",
      imageId: "img_123",
    });

    expect(result.verdict).toBe("FLAGGED");
    expect(result.degraded).toBe(true);
    expect(result.maxSeverity).toBe(6);
    expect(result.categories).toEqual([]);
    expect(result.provider).toBe("unconfigured-fail-closed");
    expect(result.rawSeverityScale).toBe("four");
  });
});
