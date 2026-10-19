import { describe, expect, it, vi } from "vitest";

import type { NotificationRecord } from "@th/ports/repos/notifications";

import {
  IN_APP_TEMPLATE_MAX_CHARS,
  IN_APP_TEMPLATE_VERSION,
  buildInAppTemplateRef,
  renderStoredNotification,
  renderStoredNotifications,
} from "../render-stored-notification";
import { isLocalizedVariant } from "../copy";
import { listNotificationRendererVariants } from "../renderers";

/** Any registered variant not (yet) in LOCALIZED_VARIANTS; none = all done. */
const UNLISTED_VARIANT = listNotificationRendererVariants().find(
  (v) => !isLocalizedVariant(v),
);

const RSVP_PAYLOAD = {
  eventId: "3f1c8d2e-4b5a-4c6d-8e7f-9a0b1c2d3e4f",
  eventTitle: "Open Mic Night",
  startsAtIso: "2026-11-14T01:30:00.000Z",
  timezone: "America/Chicago",
  venueName: "The Hall",
  addressText: "123 Main St",
  eventUrl: "https://ithas.fire/e/open-mic-night",
  manageRsvpsUrl: "https://ithas.fire/my-rsvps",
};

/** A row as `notify` stores an rsvp.confirmed today (English text). */
function storedRsvpRow(
  overrides: Partial<NotificationRecord> = {},
): NotificationRecord {
  const createdAt = new Date("2026-11-01T12:00:00Z");
  return {
    id: "a1b2c3d4-0000-4000-8000-000000000001",
    humanId: "8d96bcf3-75bb-4e6b-9bea-9891e093cf3e",
    title: "You're going to Open Mic Night",
    body: "Your RSVP for Open Mic Night is confirmed. It starts Fri, Nov 13, 2026, 7:30 PM CST.",
    kind: "SUCCESS",
    metadata: { eventId: RSVP_PAYLOAD.eventId, variant: "rsvp.confirmed" },
    tags: ["rsvp", "confirmed"],
    expiresAt: null,
    readAt: null,
    action: { label: "View event", route: "/e/open-mic-night", href: null },
    templateKey: "rsvp.confirmed",
    templateVersion: "1",
    templateVariables: { ...RSVP_PAYLOAD },
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

describe("renderStoredNotification", () => {
  it("re-renders title, body and action label in Spanish and keeps the stored route", () => {
    const reportError = vi.fn();
    const row = storedRsvpRow();

    const out = renderStoredNotification({ reportError }, row, "es");

    expect(out.title).toBe("Vas a ir a Open Mic Night");
    expect(out.body).toMatch(
      /^Tu asistencia a Open Mic Night está confirmada\. Empieza el viernes 13 de noviembre de 2026 a las 19:30 \(/u,
    );
    expect(out.action).toEqual({
      label: "Ver evento",
      route: "/e/open-mic-night",
      href: null,
    });
    // Everything else is the stored row.
    expect(out.id).toBe(row.id);
    expect(out.kind).toBe("SUCCESS");
    expect(out.readAt).toBeNull();
    expect(out.createdAt).toBe(row.createdAt);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("keeps the STORED route even when the payload's URL would derive another", () => {
    const row = storedRsvpRow({
      action: { label: "View event", route: "/e/renamed-slug", href: null },
    });
    const out = renderStoredNotification({}, row, "es");
    expect(out.action).toEqual({
      label: "Ver evento",
      route: "/e/renamed-slug",
      href: null,
    });
  });

  it("is a no-op for English (returns the stored row itself)", () => {
    const row = storedRsvpRow();
    expect(renderStoredNotification({}, row, "en")).toBe(row);
  });

  it("is a no-op for a row without a template (old rows)", () => {
    const reportError = vi.fn();
    const row = storedRsvpRow({
      templateKey: null,
      templateVersion: null,
      templateVariables: null,
    });
    expect(renderStoredNotification({ reportError }, row, "es")).toBe(row);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("does not re-render a row from another contract version, and does not report it", () => {
    const reportError = vi.fn();
    const row = storedRsvpRow({ templateVersion: "2" });
    expect(renderStoredNotification({ reportError }, row, "es")).toBe(row);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("does not re-render a template whose key is not the row's variant", () => {
    const reportError = vi.fn();
    const row = storedRsvpRow({
      metadata: { variant: "notification.generic" },
    });
    expect(renderStoredNotification({ reportError }, row, "es")).toBe(row);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("falls back to the stored text and reports once when the payload no longer parses", () => {
    const reportError = vi.fn();
    const row = storedRsvpRow({
      templateVariables: { eventTitle: "Open Mic Night" },
    });

    const out = renderStoredNotification({ reportError }, row, "es");

    expect(out).toBe(row);
    expect(reportError).toHaveBeenCalledTimes(1);
    const [, context] = reportError.mock.calls[0]!;
    expect(context).toMatchObject({
      tags: {
        useCase: "comms.renderStoredNotification",
        locale: "es",
        templateKey: "rsvp.confirmed",
        templateVersion: "1",
      },
      extra: {
        notificationId: row.id,
        templateKey: "rsvp.confirmed",
        templateVersion: "1",
        affectedRows: 1,
      },
    });
  });

  it("reports a parse failure as an Error naming the variant, with issue paths and never the stored values", () => {
    const reportError = vi.fn();
    const row = storedRsvpRow({
      templateVariables: {
        ...RSVP_PAYLOAD,
        eventId: "SECRET-not-a-uuid",
        addressText: 42,
      },
    });

    renderStoredNotification({ reportError }, row, "es");

    expect(reportError).toHaveBeenCalledTimes(1);
    const [error, context] = reportError.mock.calls[0]!;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('"rsvp.confirmed"');
    expect(context.extra.issuePaths).toEqual(
      expect.arrayContaining(["eventId", "addressText"]),
    );
    const reported = JSON.stringify([String(error), context]);
    expect(reported).not.toContain("SECRET");
    expect(reported).not.toContain("123 Main St");
    expect(reported).not.toContain("Open Mic Night");
  });

  it("reports at most once per template key per call, with the number of rows it hit", () => {
    const reportError = vi.fn();
    const bad = (id: string) =>
      storedRsvpRow({ id, templateVariables: { nope: true } });
    const good = storedRsvpRow({ id: "a1b2c3d4-0000-4000-8000-000000000009" });

    const out = renderStoredNotifications(
      { reportError },
      [bad("a1b2c3d4-0000-4000-8000-000000000002"), good, bad("a1b2c3d4-0000-4000-8000-000000000003")],
      "es",
    );

    expect(out.map((r) => r.title)).toEqual([
      "You're going to Open Mic Night",
      "Vas a ir a Open Mic Night",
      "You're going to Open Mic Night",
    ]);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![1]).toMatchObject({
      extra: {
        notificationId: "a1b2c3d4-0000-4000-8000-000000000002",
        affectedRows: 2,
      },
    });
  });

  // Delete this test, and the `UNLISTED_VARIANT` gate, once every variant is
  // localized: there will be no unlisted variant left to pick.
  it.skipIf(!UNLISTED_VARIANT)(
    "does not re-render (or report) a variant that is not in LOCALIZED_VARIANTS",
    () => {
      const reportError = vi.fn();
      const row = storedRsvpRow({
        templateKey: UNLISTED_VARIANT!,
        metadata: { variant: UNLISTED_VARIANT! },
        templateVariables: { anything: true },
      });
      expect(renderStoredNotification({ reportError }, row, "es")).toBe(row);
      expect(reportError).not.toHaveBeenCalled();
    },
  );

  it("still returns the stored text when the reporter itself throws", () => {
    const reportError = vi.fn(() => {
      throw new Error("sentry down");
    });
    const row = storedRsvpRow({ templateVariables: { nope: true } });

    expect(() =>
      renderStoredNotification({ reportError }, row, "es"),
    ).not.toThrow();
    expect(renderStoredNotification({ reportError }, row, "es")).toBe(row);
    expect(reportError).toHaveBeenCalled();
  });

  it("keeps a null action null", () => {
    const row = storedRsvpRow({ action: null });
    const out = renderStoredNotification({}, row, "es");
    expect(out.action).toBeNull();
    expect(out.title).toBe("Vas a ir a Open Mic Night");
  });
});

describe("buildInAppTemplateRef", () => {
  it("stores the variant, the contract version and a JSON copy of the payload", () => {
    const built = buildInAppTemplateRef("rsvp.confirmed", {
      ...RSVP_PAYLOAD,
      endsAtIso: undefined,
    });
    expect(built).toEqual({
      template: {
        key: "rsvp.confirmed",
        version: IN_APP_TEMPLATE_VERSION,
        variables: RSVP_PAYLOAD,
      },
      skipped: null,
    });
    expect(
      built.template?.variables && "endsAtIso" in built.template.variables,
    ).toBe(false);
  });

  it("keeps nulls and nested objects", () => {
    const built = buildInAppTemplateRef("x.y", {
      a: null,
      nested: { list: [1, "two", null] },
    });
    expect(built.template?.variables).toEqual({
      a: null,
      nested: { list: [1, "two", null] },
    });
  });

  it("stores an empty object for an absent payload", () => {
    expect(buildInAppTemplateRef("x.y", undefined).template?.variables).toEqual(
      {},
    );
  });

  it("stores nothing for the generic variant, and that is not a skip", () => {
    expect(buildInAppTemplateRef("notification.generic", { body: "x" })).toEqual(
      { template: null, skipped: null },
    );
  });

  it("names why a payload could not be stored", () => {
    expect(buildInAppTemplateRef("x.y", ["a"])).toEqual({
      template: null,
      skipped: "not_plain_object",
    });
    expect(buildInAppTemplateRef("x.y", "text").skipped).toBe(
      "not_plain_object",
    );
    expect(buildInAppTemplateRef("x.y", { n: 10n }).skipped).toBe(
      "unserializable",
    );
    const oversized = buildInAppTemplateRef("x.y", {
      blob: "a".repeat(IN_APP_TEMPLATE_MAX_CHARS),
    });
    expect(oversized).toMatchObject({ template: null, skipped: "oversized" });
    expect("chars" in oversized && oversized.chars).toBeGreaterThan(
      IN_APP_TEMPLATE_MAX_CHARS,
    );
  });
});
