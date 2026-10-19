import { describe, expect, it } from "vitest";

import {
  formatRelativeAge,
  isReportAlreadyReviewedError,
  reasonLabelKey,
  subjectHref,
  subjectTypeLabelKey,
  type ReportReason,
  type ReportSubjectType,
} from "../entity-report-queue.helpers";

describe("reasonLabelKey", () => {
  const cases: Array<[ReportReason, string]> = [
    ["CLOSED_OR_GONE", "moderation.reportsReasonClosedOrGone"],
    ["INCORRECT_INFO", "moderation.reportsReasonIncorrectInfo"],
    ["DUPLICATE", "moderation.reportsReasonDuplicate"],
    ["INAPPROPRIATE", "moderation.reportsReasonInappropriate"],
    ["SPAM", "moderation.reportsReasonSpam"],
    ["IMPERSONATION", "moderation.reportsReasonImpersonation"],
    ["OTHER", "moderation.reportsReasonOther"],
  ];

  it.each(cases)("%s → %s", (reason, key) => {
    expect(reasonLabelKey(reason)).toBe(key);
  });
});

describe("subjectTypeLabelKey", () => {
  const cases: Array<[ReportSubjectType, string]> = [
    ["PLACE", "moderation.reportsSubjectPlace"],
    ["HUMAN", "moderation.reportsSubjectHuman"],
    ["ORGANIZATION", "moderation.reportsSubjectOrganization"],
  ];

  it.each(cases)("%s → %s", (subjectType, key) => {
    expect(subjectTypeLabelKey(subjectType)).toBe(key);
  });
});

describe("subjectHref", () => {
  it("maps each subject type to its typed public route", () => {
    expect(subjectHref("PLACE", "velvet-room")).toBe("/places/velvet-room");
    expect(subjectHref("HUMAN", "jane-doe")).toBe("/humans/jane-doe");
    expect(subjectHref("ORGANIZATION", "dev-qa-collective")).toBe(
      "/orgs/dev-qa-collective",
    );
  });

  it("returns null when the slug is unresolvable", () => {
    expect(subjectHref("PLACE", null)).toBeNull();
    expect(subjectHref("HUMAN", "")).toBeNull();
  });

  it("stays same-origin for hostile-shaped slugs (safeHref)", () => {
    // The route base pins the href to a same-origin path; a scheme-ish slug
    // ends up inert path content, never a javascript:/protocol-relative URL.
    const href = subjectHref("PLACE", "javascript:alert(1)");
    expect(href?.startsWith("/places/")).toBe(true);
  });
});

describe("formatRelativeAge", () => {
  const now = new Date("2026-08-17T12:00:00.000Z");
  const minutesAgo = (n: number) => new Date(now.getTime() - n * 60_000);

  it("formats sub-hour ages in minutes (en)", () => {
    expect(formatRelativeAge(minutesAgo(5), now, "en")).toBe("5 minutes ago");
  });

  it("rolls to hours under a day", () => {
    expect(formatRelativeAge(minutesAgo(90), now, "en")).toBe("2 hours ago");
  });

  it("uses numeric:auto day phrasing", () => {
    expect(formatRelativeAge(minutesAgo(24 * 60), now, "en")).toBe(
      "yesterday",
    );
  });

  it("rolls to months past 30 days", () => {
    expect(formatRelativeAge(minutesAgo(45 * 24 * 60), now, "en")).toBe(
      "2 months ago",
    );
  });

  it("is locale-aware (es)", () => {
    expect(formatRelativeAge(minutesAgo(5), now, "es")).toBe(
      "hace 5 minutos",
    );
  });
});

describe("isReportAlreadyReviewedError", () => {
  it("matches the review CAS conflict message", () => {
    expect(
      isReportAlreadyReviewedError(new Error("report_already_reviewed")),
    ).toBe(true);
    expect(
      isReportAlreadyReviewedError({ message: "report_already_reviewed" }),
    ).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isReportAlreadyReviewedError(new Error("CONFLICT"))).toBe(false);
    expect(
      isReportAlreadyReviewedError({ message: "entity_report_not_found" }),
    ).toBe(false);
    expect(isReportAlreadyReviewedError(null)).toBe(false);
    expect(isReportAlreadyReviewedError(undefined)).toBe(false);
    expect(isReportAlreadyReviewedError("report_already_reviewed")).toBe(
      false,
    );
  });
});

describe("ARRIVAL_AREA reports (arrival-areas FR-011)", () => {
  it("labels the area by its kind, with a generic label when the kind is unknown", () => {
    expect(subjectTypeLabelKey("ARRIVAL_AREA", "PARKING")).toBe(
      "moderation.reportsSubjectArrivalAreaParking",
    );
    expect(subjectTypeLabelKey("ARRIVAL_AREA", "ACCESSIBLE_DROP_OFF")).toBe(
      "moderation.reportsSubjectArrivalAreaDropOff",
    );
    expect(subjectTypeLabelKey("ARRIVAL_AREA", "LOAD_IN")).toBe(
      "moderation.reportsSubjectArrivalAreaLoadIn",
    );
    expect(subjectTypeLabelKey("ARRIVAL_AREA", null)).toBe(
      "moderation.reportsSubjectArrivalArea",
    );
  });

  it("links the page the area was reported from: the place's or the event's", () => {
    expect(subjectHref("ARRIVAL_AREA", "velvet-room", "PLACE")).toBe(
      "/places/velvet-room",
    );
    expect(subjectHref("ARRIVAL_AREA", "open-mic-night", "EVENT")).toBe(
      "/events/open-mic-night",
    );
  });

  it("no parent type or no slug → no link", () => {
    expect(subjectHref("ARRIVAL_AREA", "velvet-room", null)).toBeNull();
    expect(subjectHref("ARRIVAL_AREA", "velvet-room")).toBeNull();
    expect(subjectHref("ARRIVAL_AREA", null, "EVENT")).toBeNull();
  });

  it("stays same-origin for hostile-shaped slugs", () => {
    const href = subjectHref("ARRIVAL_AREA", "javascript:alert(1)", "EVENT");
    expect(href?.startsWith("/events/")).toBe(true);
  });
});
