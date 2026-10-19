import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

// The nav model builds React elements (icons, the empty-state block) but this
// suite never renders them — it asserts the DATA: which groups exist, which
// items are in them, and which sections the user may open. Style engines are
// stubbed so the module imports cheaply.
vi.mock("tamagui", () => ({
  YStack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@th/ui", () => ({
  NextLinkAnchor: ({
    href,
    children,
  }: {
    href: string;
    children?: ReactNode;
  }) => <a href={href}>{children}</a>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

vi.mock("lucide-react", () => {
  const Icon = () => null;
  return {
    AlertTriangle: Icon,
    Bell: Icon,
    Briefcase: Icon,
    Building2: Icon,
    CalendarCheck: Icon,
    CreditCard: Icon,
    Inbox: Icon,
    Lock: Icon,
    Mail: Icon,
    Mic: Icon,
    Pencil: Icon,
    User: Icon,
  };
});

import {
  buildSettingsGroups,
  hasBookingRequestHistory,
  hasPersonalWork,
  type SettingsWorkSummary,
} from "../settings-sections";

/** Echoes the key back, so assertions name the i18n key, not a translation. */
const t = (key: string) => key;

type FullSummary = SettingsWorkSummary;

const summary = (overrides: Partial<FullSummary> = {}): FullSummary => ({
  degraded: false,
  performerEnabled: false,
  acceptsBookingRequests: false,
  hasWorkRoles: false,
  sentBookingRequestCount: 0,
  receivedBookingRequestCount: 0,
  pendingReceivedBookingRequestCount: 0,
  placeClaimCount: 0,
  editSuggestionCount: 0,
  ...overrides,
});

const groupIds = (s: FullSummary | null) =>
  buildSettingsGroups(s, { t }).groups.map((g) => g.id);

const itemIds = (s: FullSummary | null, groupId: string) =>
  buildSettingsGroups(s, { t })
    .groups.find((g) => g.id === groupId)
    ?.items.map((i) => i.id) ?? null;

describe("buildSettingsGroups — Account group", () => {
  it("is always present, in slot order, with Security above Notifications", () => {
    // Nothing security-critical should sit below a booking form; the order is
    // the product decision, so pin it.
    expect(itemIds(summary(), "account")).toEqual([
      "profile",
      "email",
      "security",
      "notifications",
      "billing",
    ]);
  });

  it("routes every account item at its own URL", () => {
    const account = buildSettingsGroups(summary(), { t }).groups[0]!;
    expect(account.items.map((i) => i.href)).toEqual([
      "/account/settings/profile",
      "/account/settings/email",
      "/account/settings/security",
      "/account/settings/notifications",
      "/account/settings/billing",
    ]);
  });

  it("entitles every account section plus roles and danger, always", () => {
    const { entitled } = buildSettingsGroups(summary(), { t });
    for (const slug of [
      "profile",
      "email",
      "security",
      "notifications",
      "billing",
      "roles",
      "danger",
    ] as const) {
      expect(entitled.has(slug)).toBe(true);
    }
  });
});

describe("buildSettingsGroups — Your work group", () => {
  it("is empty (with a prompt) for someone who does no work", () => {
    const built = buildSettingsGroups(summary(), { t });
    const work = built.groups.find((g) => g.id === "work")!;

    expect(work.items).toHaveLength(0);
    // The empty state links to Roles, so Roles must stay openable.
    expect(work.emptyState).toBeTruthy();
    expect(built.entitled.has("roles")).toBe(true);
    for (const slug of [
      "performer",
      "booking-defaults",
      "booking-requests",
    ] as const) {
      expect(built.entitled.has(slug)).toBe(false);
    }
  });

  it("appears when the human has picked job roles", () => {
    const s = summary({ hasWorkRoles: true });
    expect(itemIds(s, "work")).toEqual(["roles"]);
    expect(itemIds(s, "booking")).toEqual([
      "performer",
      "booking-defaults",
      "booking-requests",
    ]);
  });

  it("appears when performer mode is on even with no job roles", () => {
    // Nothing requires job roles to enable performer mode — set-performer-mode
    // never touches `jobs` — so this is an ordinary state, not an edge case.
    const s = summary({ performerEnabled: true });
    expect(itemIds(s, "work")).toEqual(["roles"]);
    expect(itemIds(s, "booking")).toEqual([
      "performer",
      "booking-defaults",
      "booking-requests",
    ]);
  });

  it("splits Booking out as its own group, directly after Your work", () => {
    // Roles & craft is about WHO you are; Performer, Booking defaults and
    // Booking requests are about GETTING BOOKED. Same entitlement predicate,
    // separate headers.
    expect(groupIds(summary({ hasWorkRoles: true }))).toEqual([
      "account",
      "work",
      "booking",
    ]);
  });

  it("omits the Booking group entirely (no orphaned header) when work is empty", () => {
    // The work group's empty state already prompts "tell us what you do";
    // an empty BOOKING header above nothing would be chrome on top of it.
    expect(groupIds(summary())).toEqual(["account", "work"]);
    expect(itemIds(summary(), "booking")).toBeNull();
  });

  // ── The ratchet ──────────────────────────────────────────────────────────
  // Once you have pitched or been pitched, the work scope stays yours. Without
  // this, a `jobs: []` performer who switched performer mode OFF lost the
  // group containing the toggle that turns it back on — and any open booking
  // request went with it.

  it("survives turning performer mode off when the acceptance gate is still stored", () => {
    const justToggledOff = summary({
      performerEnabled: false,
      hasWorkRoles: false,
      acceptsBookingRequests: true,
    });

    expect(hasPersonalWork(justToggledOff)).toBe(true);
    expect(itemIds(justToggledOff, "booking")).toContain("performer");
  });

  it.each([
    ["a received request", { receivedBookingRequestCount: 1 }],
    ["a sent pitch", { sentBookingRequestCount: 1 }],
  ])(
    "survives turning everything off when there is %s on file",
    (_label, counts) => {
      const s = summary({
        performerEnabled: false,
        hasWorkRoles: false,
        acceptsBookingRequests: false,
        ...counts,
      });

      expect(hasPersonalWork(s)).toBe(true);
      expect(itemIds(s, "work")).toEqual(["roles"]);
      expect(itemIds(s, "booking")).toEqual([
        "performer",
        "booking-defaults",
        "booking-requests",
      ]);
    },
  );

  it("counts HISTORY, not just open requests", () => {
    // BookingRequestsSection renders every status; a settled inbox is still an
    // inbox, and a withdrawn pitch is still yours to look at.
    const allAnswered = summary({
      receivedBookingRequestCount: 5,
      pendingReceivedBookingRequestCount: 0,
    });

    expect(hasPersonalWork(allAnswered)).toBe(true);
  });

  it("entitles the work sections only when the group is populated", () => {
    const { entitled } = buildSettingsGroups(summary({ hasWorkRoles: true }), {
      t,
    });
    expect(entitled.has("performer")).toBe(true);
    expect(entitled.has("booking-defaults")).toBe(true);
    expect(entitled.has("booking-requests")).toBe(true);
  });

  it("stays HIDDEN for a plain ticket buyer", () => {
    // The gating still has to gate: no jobs, no performer mode, no request
    // history means no work group.
    const buyer = summary({ placeClaimCount: 3, editSuggestionCount: 4 });

    expect(hasPersonalWork(buyer)).toBe(false);
    expect(hasBookingRequestHistory(buyer)).toBe(false);

    const built = buildSettingsGroups(buyer, { t });
    expect(built.groups.find((g) => g.id === "work")!.items).toEqual([]);
    for (const slug of [
      "performer",
      "booking-defaults",
      "booking-requests",
    ] as const) {
      expect(built.entitled.has(slug)).toBe(false);
    }
  });

  it("stays HIDDEN for someone who only administers organizations", () => {
    // The hard product rule: org performer mode, org booking defaults and the
    // org inbox live in /admin/[slug]/settings. There is no `adminOrgCount`
    // here to widen on — `humans.getMyWorkSummary` stopped returning one, and
    // its booking counts are scoped to the actor's OWN identity rather than
    // unioned with administered orgs, precisely so org activity cannot leak in
    // through the ratchet above.
    const orgAdminOnly = summary();

    expect(hasPersonalWork(orgAdminOnly)).toBe(false);
    expect(itemIds(orgAdminOnly, "work")).toEqual([]);
    const { entitled } = buildSettingsGroups(orgAdminOnly, { t });
    expect(entitled.has("performer")).toBe(false);
    expect(entitled.has("booking-requests")).toBe(false);
  });
});

describe("buildSettingsGroups — booking-requests deep link", () => {
  // The organizer-request notification email links straight at
  // /account/settings/booking-requests, and ReceivedBookingRequestsList
  // owner={{ownerType:"human"}} is mounted nowhere else in the app. If that
  // route ever redirects, the request is unreachable and the organizer waits
  // forever.
  it.each([
    ["received", { receivedBookingRequestCount: 1 }],
    ["sent", { sentBookingRequestCount: 1 }],
  ])("is entitled off %s history alone", (_label, counts) => {
    const { entitled } = buildSettingsGroups(summary(counts), { t });
    expect(entitled.has("booking-requests")).toBe(true);
  });

  it("is entitled even if the broader work rule were to stop covering it", () => {
    // `hasBookingRequestHistory` entitles the section independently of
    // `hasPersonalWork`, so the deep link survives future changes to the work
    // rule. Asserted directly on the predicate that guards it.
    const s = summary({ receivedBookingRequestCount: 2 });
    expect(hasBookingRequestHistory(s)).toBe(true);
  });

  it("is NOT entitled for someone who has never sent or received one", () => {
    const { entitled } = buildSettingsGroups(summary(), { t });
    expect(entitled.has("booking-requests")).toBe(false);
  });
});

describe("buildSettingsGroups — booking-requests badge", () => {
  it("passes the PENDING count through as the badge", () => {
    const items = buildSettingsGroups(
      summary({ hasWorkRoles: true, pendingReceivedBookingRequestCount: 7 }),
      { t },
    ).groups.find((g) => g.id === "booking")!.items;

    expect(items.find((i) => i.id === "booking-requests")?.count).toBe(7);
  });

  it("gives the badged row a spoken accessible name", () => {
    // The badge is a bare numeral inside the anchor, so without this the link
    // announces "Booking requests 3" — a number with no unit.
    const row = buildSettingsGroups(
      summary({ hasWorkRoles: true, pendingReceivedBookingRequestCount: 3 }),
      { t },
    )
      .groups.find((g) => g.id === "booking")!
      .items.find((i) => i.id === "booking-requests")!;

    expect(row.ariaLabel).toBe("account.settingsNavPendingAria");
  });

  it("leaves the accessible name alone when there is no badge", () => {
    const row = buildSettingsGroups(summary({ hasWorkRoles: true }), { t })
      .groups.find((g) => g.id === "booking")!
      .items.find((i) => i.id === "booking-requests")!;

    expect(row.ariaLabel).toBeUndefined();
  });

  it("carries no badge at zero pending, even with answered requests on file", () => {
    const items = buildSettingsGroups(
      summary({
        hasWorkRoles: true,
        receivedBookingRequestCount: 20,
        pendingReceivedBookingRequestCount: 0,
      }),
      { t },
    ).groups.find((g) => g.id === "booking")!.items;

    const row = items.find((i) => i.id === "booking-requests")!;
    expect(row.count).toBeUndefined();
    // The row itself still exists — a settled inbox is not a hidden inbox.
    expect(row.href).toBe("/account/settings/booking-requests");
  });
});

describe("buildSettingsGroups — Submissions group", () => {
  it("is absent entirely when nothing has been filed", () => {
    expect(groupIds(summary())).toEqual(["account", "work"]);
  });

  it("shows only place claims when only claims exist", () => {
    const s = summary({ placeClaimCount: 2 });
    expect(groupIds(s)).toContain("submissions");
    expect(itemIds(s, "submissions")).toEqual(["venues"]);

    const { entitled } = buildSettingsGroups(s, { t });
    expect(entitled.has("venues")).toBe(true);
    expect(entitled.has("contributions")).toBe(false);
  });

  it("shows only contributions when only suggestions exist", () => {
    const s = summary({ editSuggestionCount: 1 });
    expect(itemIds(s, "submissions")).toEqual(["contributions"]);

    const { entitled } = buildSettingsGroups(s, { t });
    expect(entitled.has("contributions")).toBe(true);
    expect(entitled.has("venues")).toBe(false);
  });

  it("shows both, venues first", () => {
    const s = summary({ placeClaimCount: 1, editSuggestionCount: 5 });
    expect(itemIds(s, "submissions")).toEqual(["venues", "contributions"]);
  });
});

describe("buildSettingsGroups — danger footer", () => {
  it("pins exactly one danger-toned item outside every group", () => {
    const { groups, footerItems } = buildSettingsGroups(summary(), { t });

    expect(footerItems).toHaveLength(1);
    expect(footerItems[0]).toMatchObject({
      id: "danger",
      href: "/account/settings/danger",
      tone: "danger",
    });
    // And never inside a group.
    for (const group of groups) {
      expect(group.items.some((i) => i.id === "danger")).toBe(false);
    }
  });
});

describe("buildSettingsGroups — unresolved summary", () => {
  it("omits the work group entirely rather than emitting an orphaned header", () => {
    const built = buildSettingsGroups(null, { t });

    // Not `items: []` with no empty state — SettingsNav would render the
    // "YOUR WORK" label above a divider with nothing under it, on every single
    // settings load. And deliberately not the empty-state prompt either:
    // flashing "tell us what you do" at a working performer is worse than the
    // group arriving a beat late.
    expect(built.groups.map((g) => g.id)).toEqual(["account"]);
  });

  it("never entitles a gated section before the summary resolves", () => {
    const { entitled } = buildSettingsGroups(undefined, { t });
    for (const slug of [
      "performer",
      "booking-defaults",
      "booking-requests",
      "venues",
      "contributions",
    ] as const) {
      expect(entitled.has(slug)).toBe(false);
    }
  });

  it("still offers the always-available sections and the danger footer", () => {
    const built = buildSettingsGroups(null, { t });

    expect(built.groups[0]!.items.map((i) => i.id)).toEqual([
      "profile",
      "email",
      "security",
      "notifications",
      "billing",
    ]);
    expect(built.footerItems.map((i) => i.id)).toEqual(["danger"]);
  });
});

describe("buildSettingsGroups — entitlementDecidable", () => {
  // The ONLY thing `entitled` drives is a redirect away from a page the user
  // asked for, so it must never fire on a guess.

  it("is false while the summary is unresolved", () => {
    expect(buildSettingsGroups(null, { t }).entitlementDecidable).toBe(false);
    expect(buildSettingsGroups(undefined, { t }).entitlementDecidable).toBe(
      false,
    );
  });

  it("is false when the summary came back degraded", () => {
    // A degraded read substitutes 0 for whatever failed, and a substituted 0
    // is indistinguishable from a real one here — so a partial outage would
    // otherwise bounce a claimant off their own venue-claims page.
    const built = buildSettingsGroups(
      summary({ degraded: true, placeClaimCount: 0 }),
      { t },
    );

    expect(built.entitlementDecidable).toBe(false);
    // The nav still renders normally; only the redirect is suppressed.
    expect(built.groups.map((g) => g.id)).toEqual(["account", "work"]);
  });

  it("is true for a clean, resolved summary", () => {
    expect(buildSettingsGroups(summary(), { t }).entitlementDecidable).toBe(
      true,
    );
  });

  it("still reports groups correctly when degraded", () => {
    // Degraded means "counts may be understated", not "show nothing" — the
    // rows we DO know about must stay reachable.
    const built = buildSettingsGroups(
      summary({ degraded: true, hasWorkRoles: true, placeClaimCount: 2 }),
      { t },
    );

    expect(built.groups.map((g) => g.id)).toEqual([
      "account",
      "work",
      "booking",
      "submissions",
    ]);
    expect(built.entitled.has("venues")).toBe(true);
  });
});
