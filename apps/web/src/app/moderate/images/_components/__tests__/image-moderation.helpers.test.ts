import { describe, expect, it } from "vitest";

import {
  buildSubjectHref,
  categoryLabelKey,
  severityBucket,
  severityLabelKey,
  severityTone,
} from "../image-moderation.helpers";

describe("severityBucket", () => {
  it("maps the Azure four-severity scale to labelled buckets", () => {
    expect(severityBucket(0)).toBe("none");
    expect(severityBucket(2)).toBe("low");
    expect(severityBucket(4)).toBe("high");
    expect(severityBucket(6)).toBe("severe");
  });

  it("buckets by range so an off-scale value still resolves", () => {
    expect(severityBucket(1)).toBe("none");
    expect(severityBucket(3)).toBe("low");
    expect(severityBucket(5)).toBe("high");
    expect(severityBucket(7)).toBe("severe");
  });
});

describe("severityLabelKey", () => {
  it("returns the matching i18n key for each bucket", () => {
    expect(severityLabelKey(0)).toBe("moderation.imagesSeverityNone");
    expect(severityLabelKey(2)).toBe("moderation.imagesSeverityLow");
    expect(severityLabelKey(4)).toBe("moderation.imagesSeverityHigh");
    expect(severityLabelKey(6)).toBe("moderation.imagesSeveritySevere");
  });
});

describe("severityTone", () => {
  it("keeps zero-severity neutral and escalates with severity", () => {
    expect(severityTone(0)).toBe("neutral");
    expect(severityTone(2)).toBe("warning");
    expect(severityTone(4)).toBe("danger");
    expect(severityTone(6)).toBe("danger");
  });
});

describe("categoryLabelKey", () => {
  it("maps each flagged category to its i18n key", () => {
    expect(categoryLabelKey("SEXUAL")).toBe("moderation.imagesCategorySexual");
    expect(categoryLabelKey("VIOLENCE")).toBe(
      "moderation.imagesCategoryViolence",
    );
    expect(categoryLabelKey("HATE")).toBe("moderation.imagesCategoryHate");
    expect(categoryLabelKey("SELF_HARM")).toBe(
      "moderation.imagesCategorySelfHarm",
    );
  });
});

describe("buildSubjectHref", () => {
  it("links an EVENT subject to the public event route (UUID fallback)", () => {
    expect(buildSubjectHref("EVENT", "evt-123")).toBe("/events/evt-123");
  });

  it("links a PLACE subject (a community page image) to the id-keyed place route", () => {
    expect(buildSubjectHref("PLACE", "p-1")).toBe("/places/id/p-1");
  });

  it("returns null when there is no id", () => {
    expect(buildSubjectHref("EVENT", null)).toBeNull();
  });

  it("returns null for subject types without a clean public link", () => {
    expect(buildSubjectHref("HUMAN", "h-1")).toBeNull();
    expect(buildSubjectHref("ORGANIZATION", "o-1")).toBeNull();
    expect(buildSubjectHref(null, "x-1")).toBeNull();
  });
});
