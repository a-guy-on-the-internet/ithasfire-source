import { describe, expect, it, vi } from "vitest";

import type { MailerPort } from "@th/ports/comms/mailer";
import type { Repos } from "@th/ports/repos";

import { notifyClaimOpened } from "../../resale/notify-resale-events";
import { renderNotification } from "../renderers";

// Dates in the direct renderers are pinned to UTC for every locale, so a
// reader's language never changes which day a date falls on. 02:00Z is still
// the 13th in a US zone: run under `TZ=America/Chicago` to see the pin work.
//
// The resale claim-opened notice used to carry the pin's date (the seller's
// reply deadline). There is no reply deadline any more (owner rulings Q8 +
// Q9, 2026-10-06), so the pin is exercised through the dispute notice's
// evidence-due date, and the claim notice is checked for showing no date.

const NEAR_MIDNIGHT = "2026-03-14T02:00:00Z";

function disputeOpenedBody(locale: "en" | "es"): string {
  const result = renderNotification(
    "dispute.risk-owner-notice",
    {
      disputeId: "d1",
      notice: "opened",
      eventTitle: "Test Concert",
      isMembership: false,
      evidenceDueIso: NEAR_MIDNIGHT,
      lostOutcome: null,
    },
    { now: new Date("2026-03-10T12:00:00Z"), locale },
  );
  return result.inApp?.body ?? "";
}

function claimOpenedBody(locale: "en" | "es"): string {
  const result = renderNotification(
    "resale.claim-opened",
    {
      claimId: "claim-1",
      eventTitle: "Test Concert",
      claimKind: "entry_denied",
      deadlineIso: NEAR_MIDNIGHT,
      claimUrl: "https://ithasfire.com/my/resale/claims/claim-1",
    },
    { now: new Date("2026-03-10T12:00:00Z"), locale },
  );
  return result.inApp?.body ?? "";
}

describe("direct notice dates are pinned to UTC", () => {
  it("en and es show the same day for a near-midnight instant", () => {
    const en = disputeOpenedBody("en");
    const es = disputeOpenedBody("es");
    expect(en).toContain("Mar 14, 2026");
    expect(es).toMatch(/\b14\b/);
    expect(es).not.toMatch(/\b13\b/);
  });
});

describe("resale claim-opened names no reply deadline", () => {
  it("the in-app body shows no date in either locale", () => {
    for (const locale of ["en", "es"] as const) {
      const body = claimOpenedBody(locale);
      expect(body).not.toBe("");
      expect(body).not.toMatch(/\b1[34]\b|2026|deadline|until|hasta/i);
    }
  });

  it("the email shows no deadline", async () => {
    const send = vi.fn(async (_m: { text: string }) => ({
      result: { id: "m", status: "sent" },
    }));
    const repos = {
      humans: {
        getByIdWithIdentity: vi.fn(async (id: string) => ({
          human: { id, name: "Seller" },
          identity: { email: "seller@example.com" },
        })),
      },
      events: { getById: vi.fn(async () => ({ id: "e", title: "Test Concert" })) },
      notifications: {
        create: vi.fn(async () => ({ id: "n", createdAt: new Date() })),
      },
    } as unknown as Repos;
    await notifyClaimOpened(
      { repos, mailer: { send } as unknown as MailerPort },
      {
        claimId: "claim-1",
        respondentId: "seller",
        eventId: "e",
        kind: "entry_denied",
        deadline: NEAR_MIDNIGHT,
        publicAppUrl: "https://ithasfire.com",
      },
    );
    const text = send.mock.calls[0]![0].text;
    expect(text).not.toMatch(/deadline|Mar 1[34]|2026/i);
    expect(text).toContain("You can reply until support decides the claim");
  });
});
