import { describe, expect, it } from "vitest";

import type { OrgRole } from "@th/types";

// Deep import rather than the `@th/ui` barrel (same as the platform nav test):
// the barrel drags the whole Tamagui component graph into a unit test for one
// pure function.
import { filterSections } from "../../../../../../../../packages/ui/src/ui/shell/NavigationShell.hooks";

import {
  buildEventNavSections,
  parseEventAdminPath,
} from "../event-nav-sections";

const t = (key: string) => key;

describe("parseEventAdminPath (event-context detection, FR-202)", () => {
  it("matches the event base route and sub-routes", () => {
    expect(parseEventAdminPath("/admin/acme-co/events/evt-1")).toEqual({
      eventId: "evt-1",
      subRoute: null,
    });
    expect(parseEventAdminPath("/admin/acme-co/events/evt-1/edit")).toEqual({
      eventId: "evt-1",
      subRoute: "edit",
    });
    expect(
      parseEventAdminPath("/admin/acme-co/events/evt-1/comp-tickets"),
    ).toEqual({ eventId: "evt-1", subRoute: "comp-tickets" });
  });

  it("ignores query strings and hashes", () => {
    expect(
      parseEventAdminPath("/admin/acme-co/events/evt-1/edit?section=lineup"),
    ).toEqual({ eventId: "evt-1", subRoute: "edit" });
  });

  it("returns null for the events list and the create flow (FR-301)", () => {
    expect(parseEventAdminPath("/admin/acme-co/events")).toBeNull();
    expect(parseEventAdminPath("/admin/acme-co/events/new")).toBeNull();
    expect(
      parseEventAdminPath("/admin/acme-co/events/new/community"),
    ).toBeNull();
  });

  it("returns null for non-event admin paths and non-admin paths", () => {
    expect(parseEventAdminPath("/admin/acme-co/orders")).toBeNull();
    expect(parseEventAdminPath("/events/some-event")).toBeNull();
    expect(parseEventAdminPath(null)).toBeNull();
  });

  it("handles encoded personal-workspace slugs", () => {
    expect(
      parseEventAdminPath("/admin/%40steve-mcqueen/events/evt-1/attendees"),
    ).toEqual({ eventId: "evt-1", subRoute: "attendees" });
  });
});

describe("buildEventNavSections (Build + Manage groups, FR-202/FR-203)", () => {
  const build = (
    overrides?: Partial<Parameters<typeof buildEventNavSections>[0]>,
  ) =>
    buildEventNavSections({
      eventId: "evt-1",
      status: undefined,
      activeSection: null,
      onEditSurface: false,
      t,
      ...overrides,
    });

  it("produces Build anchors with ?section deep links, hidden from the bottom bar", () => {
    const [buildGroup] = build();
    expect(buildGroup?.id).toBe("event-build");
    expect(buildGroup?.items.map((i) => i.route)).toEqual([
      "events/evt-1/edit?section=essentials",
      "events/evt-1/edit?section=details",
      "events/evt-1/edit?section=tickets",
      "events/evt-1/edit?section=lineup",
      "events/evt-1/edit?section=splits",
      "events/evt-1/edit?section=settings",
    ]);
    expect(buildGroup?.items.every((i) => i.hideInBottomBar)).toBe(true);
    // Build group is gated to edit-capable roles (FR-203).
    expect(buildGroup?.rbac).toEqual(["OWNER", "ADMIN", "EDITOR"]);
  });

  // A COMMUNITY listing renders only Essentials, Details and Lineup in the
  // builder. The rail was NOT gated with it, so Tickets / Revenue splits /
  // Settings kept deep-linking into panels that are not there and whose writes
  // the server refuses. MEASURED in a browser on a draft listing.
  it("drops the Build anchors a COMMUNITY listing has no panel for", () => {
    const [buildGroup] = build({ stewardship: "COMMUNITY" });
    expect(buildGroup?.items.map((i) => i.id)).toEqual([
      "build-essentials",
      "build-details",
      "build-lineup",
    ]);
  });

  it("keeps the full Build group for an OWNED event and while stewardship is unknown", () => {
    const owned = build({ stewardship: "OWNED" })[0]?.items.map((i) => i.id);
    const unknown = build({ stewardship: null })[0]?.items.map((i) => i.id);
    const absent = build()[0]?.items.map((i) => i.id);
    const full = [
      "build-essentials",
      "build-details",
      "build-tickets",
      "build-lineup",
      "build-splits",
      "build-settings",
    ];
    // Unknown must render the ticketed shape: the rail paints before the edit
    // surface has published anything, and an event is OWNED unless told.
    expect(owned).toEqual(full);
    expect(unknown).toEqual(full);
    expect(absent).toEqual(full);
  });

  // Owner ruling 2026-10-07: no comps on a COMMUNITY listing (`comp.list` /
  // `comp.issue` refuse it). Attendees (an org-scoped ORDER read), volunteers
  // (`updateSettings` refuses COMMUNITY rows) and feedback (refuses an
  // ownerless event) serve nothing on one either, whoever asks.
  it("keeps only suggestions in the Manage group of a community listing", () => {
    const [, manage] = build({ stewardship: "COMMUNITY" });
    expect(manage?.items.map((i) => i.id)).toEqual(["suggestions"]);
  });

  it("keeps the whole Manage group for an OWNED event and while stewardship is unknown", () => {
    const all = [
      "attendees",
      "volunteers",
      "comp-tickets",
      "suggestions",
      "feedback",
    ];
    expect(build({ stewardship: "OWNED" })[1]?.items.map((i) => i.id)).toEqual(
      all,
    );
    expect(build({ stewardship: null })[1]?.items.map((i) => i.id)).toEqual(
      all,
    );
    expect(build()[1]?.items.map((i) => i.id)).toEqual(all);
  });

  it("marks the scroll-spy section active only on the edit surface", () => {
    const [onEdit] = build({ onEditSurface: true, activeSection: "lineup" });
    expect(onEdit?.items.find((i) => i.id === "build-lineup")?.active).toBe(
      true,
    );
    expect(onEdit?.items.filter((i) => i.active).map((i) => i.id)).toEqual([
      "build-lineup",
    ]);

    const [offEdit] = build({ onEditSurface: false, activeSection: "lineup" });
    expect(offEdit?.items.some((i) => i.active)).toBe(false);
  });

  it("routes Manage items to the FR-201 surfaces", () => {
    const [, manage] = build();
    expect(manage?.items.map((i) => [i.id, i.route])).toEqual([
      ["attendees", "events/evt-1/attendees"],
      ["volunteers", "events/evt-1/volunteers"],
      ["comp-tickets", "events/evt-1/comp-tickets"],
      ["suggestions", "events/evt-1/suggestions"],
      ["feedback", "events/evt-1/feedback"],
    ]);
  });

  it("disables comps + suggestions with a post-pub note until PUBLISHED", () => {
    const [, manage] = build({ status: "DRAFT" });
    const comp = manage?.items.find((i) => i.id === "comp-tickets");
    const suggestions = manage?.items.find((i) => i.id === "suggestions");
    expect(comp?.disabled).toBe(true);
    expect(comp?.note).toBe("admin.evNavPostPub");
    expect(suggestions?.disabled).toBe(true);

    const [, managePublished] = build({ status: "PUBLISHED" });
    expect(
      managePublished?.items.find((i) => i.id === "comp-tickets")?.disabled,
    ).toBe(false);
    expect(
      managePublished?.items.find((i) => i.id === "comp-tickets")?.note,
    ).toBeUndefined();
  });

  // Attendees is no longer ungated: the rail used to offer it to VIEWER and
  // SCANNER, who then hit a 403 from `searchEventAttendees`. The item's rbac
  // must stay in lock-step with that use case's role set.
  it("gates attendees to edit-or-finance", () => {
    const [, manage] = build();
    const attendees = manage?.items.find((i) => i.id === "attendees");
    expect(attendees?.rbac).toEqual(["OWNER", "ADMIN", "EDITOR", "FINANCE"]);
    expect(attendees?.rbac).not.toContain("VIEWER");
    expect(attendees?.rbac).not.toContain("SCANNER");
    expect(attendees?.disabled).toBeUndefined();
  });

  // Comps became a LEDGER (Phase 10): its read contract is `listCompOrders`'
  // ORG_EDIT_OR_FINANCE_ROLES, so the rail must offer it to FINANCE — the
  // old EDIT-only rbac dated from when the page was nothing but the
  // admin-only issue form, and it made the widened route unreachable in
  // practice. Suggestions and feedback stay edit-only.
  it("gates comp-tickets to edit-or-finance; suggestions/feedback stay edit-only", () => {
    const [, manage] = build();
    const comp = manage?.items.find((i) => i.id === "comp-tickets");
    const suggestions = manage?.items.find((i) => i.id === "suggestions");
    const feedback = manage?.items.find((i) => i.id === "feedback");
    expect(comp?.rbac).toEqual(["OWNER", "ADMIN", "EDITOR", "FINANCE"]);
    expect(comp?.rbac).not.toContain("VIEWER");
    expect(comp?.rbac).not.toContain("SCANNER");
    expect(suggestions?.rbac).toEqual(["OWNER", "ADMIN", "EDITOR"]);
    expect(feedback?.rbac).toEqual(["OWNER", "ADMIN", "EDITOR"]);
  });

  // Roles / signups / rewards were tab panels behind the single /volunteers
  // URL. As routes they hang off the rail as children.
  it("lists the volunteer sub-routes as nav children", () => {
    const [, manage] = build();
    const volunteers = manage?.items.find((i) => i.id === "volunteers");

    expect(volunteers?.children?.map((c) => [c.id, c.route])).toEqual([
      ["volunteers-roles", "events/evt-1/volunteers/roles"],
      ["volunteers-signups", "events/evt-1/volunteers/signups"],
      // Badges is a printable document, not a management screen, so its route
      // ends at the print surface rather than a tab. It sits after signups
      // because badges only exist once a signup is approved.
      ["volunteers-badges", "events/evt-1/volunteers/badges/print"],
      ["volunteers-rewards", "events/evt-1/volunteers/rewards"],
    ]);
  });

  // Rewards reads a finance-gated ledger, but only after resolving the
  // event's ask and roles through edit-gated reads, so it needs BOTH.
  it("gates the rewards child to roles holding edit AND finance", () => {
    const [, manage] = build();
    const children = manage?.items.find((i) => i.id === "volunteers")?.children;

    const rewards = children?.find((c) => c.id === "volunteers-rewards");
    expect(rewards?.rbac).toEqual(["OWNER", "ADMIN"]);

    // The other three ride the parent's edit gate.
    for (const id of [
      "volunteers-roles",
      "volunteers-signups",
      "volunteers-badges",
    ]) {
      expect(children?.find((c) => c.id === id)?.rbac).toBeUndefined();
    }
  });
});

/**
 * What each org role ACTUALLY sees, through the same `filterSections` the
 * rail renders with — not a restatement of the rbac arrays. The expected sets
 * are the server's: every volunteer read (`getEventForEdit`,
 * `volunteer.roles.list`, `volunteer.signups.list`/`counts`, EVENT-subject
 * `asks.listBySubject`) is ORG_EDIT_ROLES; the rewards ledger is
 * ORG_FINANCE_ROLES on top of those.
 */
describe("event rail volunteer visibility per role (server parity)", () => {
  const sectionsFor = (
    role: OrgRole,
    overrides?: Partial<Parameters<typeof buildEventNavSections>[0]>,
  ) =>
    filterSections(
      buildEventNavSections({
        eventId: "evt-1",
        status: "PUBLISHED",
        activeSection: null,
        onEditSurface: false,
        t,
        ...overrides,
      }),
      [role],
    );
  const volunteersFor = (
    role: OrgRole,
    overrides?: Partial<Parameters<typeof buildEventNavSections>[0]>,
  ) =>
    sectionsFor(role, overrides)
      .flatMap((section) => section.items)
      .find((item) => item.id === "volunteers");

  it.each<OrgRole>(["VIEWER", "FINANCE", "SCANNER"])(
    "hides the whole volunteers group from %s (every read is edit-gated)",
    (role) => {
      expect(volunteersFor(role)).toBeUndefined();
    },
  );

  it("shows EDITOR setup, roles, signups and badges but not rewards", () => {
    const volunteers = volunteersFor("EDITOR");
    expect(volunteers).toBeDefined();
    expect(volunteers?.children?.map((c) => c.id)).toEqual([
      "volunteers-roles",
      "volunteers-signups",
      "volunteers-badges",
    ]);
  });

  it.each<OrgRole>(["OWNER", "ADMIN"])(
    "shows %s every volunteer child including rewards",
    (role) => {
      expect(volunteersFor(role)?.children?.map((c) => c.id)).toEqual([
        "volunteers-roles",
        "volunteers-signups",
        "volunteers-badges",
        "volunteers-rewards",
      ]);
    },
  );

  // A person's event: roles / signups / badges / rewards all throw
  // EVENT_NOT_ORG_OWNED for everyone, the owner included. Setup is the one
  // volunteer page whose calls (`getEventForEdit`, `updateSettings`) serve it.
  it("keeps only the setup page on a person's event", () => {
    const [, manage] = buildEventNavSections({
      eventId: "evt-1",
      status: "PUBLISHED",
      activeSection: null,
      onEditSurface: false,
      orgOwned: false,
      t,
    });
    const volunteers = manage?.items.find((i) => i.id === "volunteers");
    expect(volunteers?.route).toBe("events/evt-1/volunteers");
    expect(volunteers?.children).toBeUndefined();
    // A personal workspace carries no roles and the filter errs open, so the
    // structural drop is what hides them there — rbac could not.
    const personalRail = filterSections(
      buildEventNavSections({
        eventId: "evt-1",
        status: "PUBLISHED",
        activeSection: null,
        onEditSurface: false,
        orgOwned: false,
        t,
      }),
      [],
    );
    expect(
      personalRail
        .flatMap((section) => section.items)
        .find((item) => item.id === "volunteers")?.children,
    ).toBeUndefined();
  });

  it("keeps the children on an org event and while ownership is unknown", () => {
    expect(volunteersFor("OWNER", { orgOwned: true })?.children).toHaveLength(
      4,
    );
    expect(
      volunteersFor("OWNER", { orgOwned: undefined })?.children,
    ).toHaveLength(4);
  });
});

// Ownerless events (2026-10-07): the rail's rights come from the server's
// answer about the EVENT (`getEventTitle.viewerCan*`), not the URL
// workspace's role. Acceptance bar: a community moderator who is ADMIN of the
// URL's org sees no item whose page the server refuses.
describe("event rail rights for an ownerless event (event-derived, not URL role)", () => {
  /** What `getEventTitle` answers a community moderator on a COMMUNITY listing. */
  const MODERATOR = {
    canEdit: true,
    canEditOrFinance: true,
    canFinance: false,
  };
  /** A viewer the server grants nothing (not reachable today: it 403s). */
  const NOTHING = {
    canEdit: false,
    canEditOrFinance: false,
    canFinance: false,
  };

  const railFor = (
    urlRoles: string[],
    overrides?: Partial<Parameters<typeof buildEventNavSections>[0]>,
  ) =>
    filterSections(
      buildEventNavSections({
        eventId: "evt-1",
        status: "PUBLISHED",
        activeSection: null,
        onEditSurface: false,
        t,
        ...overrides,
      }),
      urlRoles as OrgRole[],
    );
  const ids = (sections: ReturnType<typeof railFor>) =>
    sections.flatMap((section) =>
      section.items.flatMap((item) => [
        item.id,
        ...(item.children ?? []).map((c) => c.id),
      ]),
    );

  it("shows a moderator who is ADMIN of the URL org only the community surfaces the server admits", () => {
    const rail = railFor(["ADMIN"], {
      stewardship: "COMMUNITY",
      orgOwned: false,
      eventRights: MODERATOR,
    });
    expect(ids(rail)).toEqual([
      "build-essentials",
      "build-details",
      "build-lineup",
      "suggestions",
    ]);
  });

  it("gives the same rail whatever the URL role is (VIEWER, SCANNER, personal)", () => {
    const expected = ids(
      railFor(["ADMIN"], {
        stewardship: "COMMUNITY",
        orgOwned: false,
        eventRights: MODERATOR,
      }),
    );
    for (const roles of [["VIEWER"], ["SCANNER"], []]) {
      expect(
        ids(
          railFor(roles, {
            stewardship: "COMMUNITY",
            orgOwned: false,
            eventRights: MODERATOR,
          }),
        ),
      ).toEqual(expected);
    }
  });

  it("leaves no rbac behind for the URL role to act on", () => {
    const sections = buildEventNavSections({
      eventId: "evt-1",
      status: "PUBLISHED",
      activeSection: null,
      onEditSurface: false,
      stewardship: "COMMUNITY",
      eventRights: MODERATOR,
      t,
    });
    for (const section of sections) {
      expect(section.rbac).toBeUndefined();
      for (const item of section.items) {
        expect(item.rbac).toBeUndefined();
        for (const child of item.children ?? []) {
          expect(child.rbac).toBeUndefined();
        }
      }
    }
  });

  it("shows nothing when the server grants nothing, even to an ADMIN URL role", () => {
    expect(
      railFor(["ADMIN"], { stewardship: "COMMUNITY", eventRights: NOTHING }),
    ).toEqual([]);
  });

  it("gates each item by the event right matching its role set", () => {
    // Stewardship left unknown so every item is in play; only the rights act.
    const editOnly = ids(
      railFor(["VIEWER"], {
        eventRights: {
          canEdit: true,
          canEditOrFinance: false,
          canFinance: false,
        },
      }),
    );
    expect(editOnly).toContain("build-essentials");
    expect(editOnly).toContain("suggestions");
    expect(editOnly).toContain("feedback");
    expect(editOnly).toContain("volunteers");
    expect(editOnly).not.toContain("attendees");
    expect(editOnly).not.toContain("comp-tickets");
    // Rewards needs edit AND finance.
    expect(editOnly).not.toContain("volunteers-rewards");

    const editAndFinance = ids(
      railFor(["VIEWER"], {
        eventRights: {
          canEdit: true,
          canEditOrFinance: true,
          canFinance: true,
        },
      }),
    );
    expect(editAndFinance).toContain("attendees");
    expect(editAndFinance).toContain("comp-tickets");
    expect(editAndFinance).toContain("volunteers-rewards");
  });

  it("keeps today's URL-role filtering while the event's rights are unknown", () => {
    // No eventRights (getEventTitle not answered, or an owned event): a
    // VIEWER URL role still hides the edit-gated groups, exactly as before.
    const viewer = ids(railFor(["VIEWER"], { eventRights: null }));
    expect(viewer).toEqual([]);
    const admin = ids(railFor(["ADMIN"], { eventRights: undefined }));
    expect(admin).toContain("comp-tickets");
    expect(admin).toContain("attendees");
  });
});

describe("buildEventNavSections: Seat prices", () => {
  const build = (
    overrides?: Partial<Parameters<typeof buildEventNavSections>[0]>,
  ) =>
    buildEventNavSections({
      eventId: "evt-1",
      status: "PUBLISHED",
      activeSection: null,
      onEditSurface: false,
      t,
      ...overrides,
    });

  it("is absent unless the seating gate is on", () => {
    expect(build()[1]?.items.some((i) => i.id === "seat-prices")).toBe(false);
  });

  it("routes to the page, before comps, open whatever the status", () => {
    for (const status of ["DRAFT", "PUBLISHED", undefined]) {
      const [, manage] = build({ seatPricesEnabled: true, status });
      const ids = manage?.items.map((i) => i.id) ?? [];
      const item = manage?.items.find((i) => i.id === "seat-prices");
      expect(item?.route).toBe("events/evt-1/seat-prices");
      expect(item?.disabled).toBeFalsy();
      expect(ids.indexOf("seat-prices")).toBe(ids.indexOf("comp-tickets") - 1);
    }
  });

  it("follows the edit gate and stays off a community listing", () => {
    const ownerless = build({
      seatPricesEnabled: true,
      eventRights: { canEdit: false, canEditOrFinance: true, canFinance: true },
    });
    expect(
      ownerless.flatMap((s) => s.items).some((i) => i.id === "seat-prices"),
    ).toBe(false);
    const community = build({ seatPricesEnabled: true, stewardship: "COMMUNITY" });
    expect(
      community.flatMap((s) => s.items).some((i) => i.id === "seat-prices"),
    ).toBe(false);
  });
});
