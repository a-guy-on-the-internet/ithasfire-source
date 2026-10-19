import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";

import { exportSignupIcs } from "./export-signup-ics";
import type { ExportSignupIcsDeps } from "./export-signup-ics";

// ── Constants ────────────────────────────────────────────────────────────────

const VOLUNTEER_ID = "00000000-0000-4000-8000-000000000001";
const OWNER_ID = "00000000-0000-4000-8000-000000000002";
const COORDINATOR_ID = "00000000-0000-4000-8000-000000000003";
const STRANGER_ID = "00000000-0000-4000-8000-000000000004";
const ORG_ID = "00000000-0000-4000-8000-000000000005";
const ASK_ID = "00000000-0000-4000-8000-000000000006";
const GROUP_ID = "00000000-0000-4000-8000-000000000007";
const SIGNUP_ID = "00000000-0000-4000-8000-000000000008";
const ROLE_ID = "00000000-0000-4000-8000-000000000009";
const SHIFT_ID = "00000000-0000-4000-8000-00000000000a";
const EVENT_ID = "00000000-0000-4000-8000-00000000000b";
const NOW = new Date("2026-07-02T12:00:00.000Z");

// ── Fixtures ─────────────────────────────────────────────────────────────────

const baseAsk = {
  id: ASK_ID,
  subjectType: "ORG" as const,
  subjectId: ORG_ID,
  orgId: ORG_ID,
  title: "Standing bar crew",
  description: null,
  status: "OPEN" as const,
  cadence: "ONGOING" as const,
  startsAt: new Date("2026-08-01T18:00:00.000Z"),
  endsAt: new Date("2026-08-01T23:00:00.000Z"),
  capacity: null,
  autoApprove: false,
  waiverRequired: false,
  smsOptInEnabled: false,
  formSchema: {},
  createdAt: NOW,
  updatedAt: NOW,
};

const baseGroup = {
  id: GROUP_ID,
  askId: ASK_ID,
  name: "Door team",
  description: null,
  capacity: null,
  coordinatorHumanId: COORDINATOR_ID,
  createdAt: NOW,
  updatedAt: NOW,
};

const askSignup = {
  id: SIGNUP_ID,
  eventId: null,
  askId: ASK_ID,
  roleId: ROLE_ID,
  shiftId: null,
  groupId: GROUP_ID,
  humanId: VOLUNTEER_ID,
  contactEmail: "volunteer@example.com",
  contactName: "Volunteer User",
  contactPhone: null,
  smsOptIn: false,
  status: "APPROVED" as const,
  hoursWorked: null,
  answers: {},
  reviewerHumanId: null,
  reviewedAt: null,
  checkedInAt: null,
  waiverAcceptedAt: null,
  notes: null,
  metadata: {},
  createdAt: NOW,
  updatedAt: NOW,
};

const eventSignup = {
  ...askSignup,
  eventId: EVENT_ID,
  shiftId: SHIFT_ID,
};

const shift = {
  id: SHIFT_ID,
  roleId: ROLE_ID,
  label: "Evening doors",
  startsAt: new Date("2026-08-02T00:00:00.000Z"),
  endsAt: new Date("2026-08-02T04:30:00.000Z"),
  capacity: null,
  notes: null,
  sortOrder: 0,
  createdAt: NOW,
  updatedAt: NOW,
};

// EXPLICITLY EXACT with no venue: LOCATION goes through the holder-address
// gate, which fails closed on a missing `locationMode`.
const event = {
  id: EVENT_ID,
  orgId: ORG_ID,
  title: "Night Market",
  slug: "night-market",
  locationMode: "EXACT",
  placeId: null,
  addressRevealAt: null,
  addressRevealPreset: null,
  addressText: "123 Main St, Somewhere",
  startsAt: new Date("2026-08-02T00:00:00.000Z"),
  endsAt: new Date("2026-08-02T06:00:00.000Z"),
};

const role = {
  id: ROLE_ID,
  eventId: null,
  askId: ASK_ID,
  templateId: null,
  name: "Door",
  description: null,
  capacity: null,
  autoApprove: null,
  defaultHours: null,
  sortOrder: 0,
  createdAt: NOW,
  updatedAt: NOW,
  shifts: [],
};

// ── Mock builder ─────────────────────────────────────────────────────────────

function makeDeps(txOverrides: Record<string, unknown> = {}) {
  const txRepos = {
    authz: {
      // Default: no org membership — the humanId-match path decides.
      getOrgMembership: vi.fn(async () => null),
    },
    events: { getById: vi.fn(async () => event) },
    // The coordinator seat needs a verified email (B2); every actor here is
    // verified unless a test says otherwise.
    humans: {
      getByIdWithIdentity: vi.fn(async () => ({
        identity: { emailVerified: true },
      })),
    },
    volunteering: {
      getSignup: vi.fn(async () => askSignup),
      getAsk: vi.fn(async () => baseAsk),
      getGroup: vi.fn(async () => baseGroup),
      getShift: vi.fn(async () => shift),
      getEventRole: vi.fn(async () => role),
    },
    ...txOverrides,
  };
  const deps: ExportSignupIcsDeps = {
    repos: {
      tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
        fn(txRepos as unknown as TxRepos),
      ),
    } as unknown as Repos,
    clock: { now: () => NOW },
    appBaseUrl: "https://test.local",
  };
  return { deps, txRepos };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("exportSignupIcs", () => {
  it("the signup's own volunteer exports a shift-window .ics with event details", async () => {
    const { deps, txRepos } = makeDeps();
    (txRepos.volunteering as any).getSignup = vi.fn(async () => eventSignup);

    const result = await exportSignupIcs(deps, {
      actorHumanId: VOLUNTEER_ID,
      signupId: SIGNUP_ID,
    });

    expect(result.filename).toBe("night-market-volunteering.ics");
    expect(result.icsBody).toContain("BEGIN:VCALENDAR");
    expect(result.icsBody).toContain(
      `UID:volunteer-signup-${SIGNUP_ID}@ithasfire.com`,
    );
    expect(result.icsBody).toContain("DTSTART:20260802T000000Z");
    expect(result.icsBody).toContain("DTEND:20260802T043000Z");
    expect(result.icsBody).toContain("SUMMARY:Night Market — Door");
    expect(result.icsBody).toContain("LOCATION:123 Main St\\, Somewhere");
    expect(result.icsBody).toContain("Shift: Evening doors");
    expect(result.icsBody).toContain(
      "URL:https://test.local/events/night-market",
    );
    // Own-signup path never consults org membership.
    expect((txRepos.authz as any).getOrgMembership).not.toHaveBeenCalled();
  });

  it("shiftless ask-path signup falls back to the ask window and title", async () => {
    const { deps } = makeDeps();

    const result = await exportSignupIcs(deps, {
      actorHumanId: VOLUNTEER_ID,
      signupId: SIGNUP_ID,
    });

    expect(result.icsBody).toContain("DTSTART:20260801T180000Z");
    expect(result.icsBody).toContain("DTEND:20260801T230000Z");
    expect(result.icsBody).toContain("SUMMARY:Standing bar crew — Door");
    expect(result.filename).toBe("standing-bar-crew-volunteering.ics");
  });

  it("ask owner may export any signup on the ask", async () => {
    const { deps, txRepos } = makeDeps({
      authz: { getOrgMembership: vi.fn(async () => ({ role: "ADMIN" })) },
    });

    const result = await exportSignupIcs(deps, {
      actorHumanId: OWNER_ID,
      signupId: SIGNUP_ID,
    });

    expect(result.icsBody).toContain("BEGIN:VEVENT");
    expect((txRepos.authz as any).getOrgMembership).toHaveBeenCalled();
  });

  it("the signup's group coordinator may export", async () => {
    const { deps } = makeDeps();

    const result = await exportSignupIcs(deps, {
      actorHumanId: COORDINATOR_ID,
      signupId: SIGNUP_ID,
    });

    expect(result.icsBody).toContain("BEGIN:VEVENT");
  });

  it("a stranger gets the uniform ownership denial", async () => {
    const { deps } = makeDeps();

    await expect(
      exportSignupIcs(deps, { actorHumanId: STRANGER_ID, signupId: SIGNUP_ID }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("a coordinator of a DIFFERENT group gets the same denial (pool/other-group rule)", async () => {
    const { deps, txRepos } = makeDeps();
    (txRepos.volunteering as any).getSignup = vi.fn(async () => ({
      ...askSignup,
      groupId: null, // pool signup — owner only
    }));

    await expect(
      exportSignupIcs(deps, {
        actorHumanId: COORDINATOR_ID,
        signupId: SIGNUP_ID,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("legacy event signup without an askId authorizes via EVENT ownership", async () => {
    const { deps, txRepos } = makeDeps({
      authz: { getOrgMembership: vi.fn(async () => ({ role: "EDITOR" })) },
    });
    (txRepos.volunteering as any).getSignup = vi.fn(async () => ({
      ...eventSignup,
      askId: null,
      humanId: null,
    }));

    const result = await exportSignupIcs(deps, {
      actorHumanId: OWNER_ID,
      signupId: SIGNUP_ID,
    });

    expect(result.icsBody).toContain("SUMMARY:Night Market — Door");
  });

  it("CONFLICTs when neither a shift nor an ask window exists", async () => {
    const { deps, txRepos } = makeDeps();
    (txRepos.volunteering as any).getAsk = vi.fn(async () => ({
      ...baseAsk,
      startsAt: null,
      endsAt: null,
    }));

    await expect(
      exportSignupIcs(deps, {
        actorHumanId: VOLUNTEER_ID,
        signupId: SIGNUP_ID,
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "signup_not_time_bound",
    });
  });

  it.each(["REJECTED", "WITHDRAWN"] as const)(
    "refuses to export a %s signup",
    async (status) => {
      const { deps, txRepos } = makeDeps();
      (txRepos.volunteering as any).getSignup = vi.fn(async () => ({
        ...askSignup,
        status,
      }));

      await expect(
        exportSignupIcs(deps, {
          actorHumanId: VOLUNTEER_ID,
          signupId: SIGNUP_ID,
        }),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        message: "signup_not_active",
      });
    },
  );

  it("404s missing signups and container-less rows uniformly", async () => {
    const missing = makeDeps();
    (missing.txRepos.volunteering as any).getSignup = vi.fn(async () => null);
    await expect(
      exportSignupIcs(missing.deps, {
        actorHumanId: VOLUNTEER_ID,
        signupId: SIGNUP_ID,
      }),
    ).rejects.toMatchObject({ code: "SIGNUP_NOT_FOUND" });

    const containerless = makeDeps();
    (containerless.txRepos.volunteering as any).getSignup = vi.fn(
      async () => ({ ...askSignup, askId: null, eventId: null, humanId: null }),
    );
    await expect(
      exportSignupIcs(containerless.deps, {
        actorHumanId: STRANGER_ID,
        signupId: SIGNUP_ID,
      }),
    ).rejects.toMatchObject({ code: "SIGNUP_NOT_FOUND" });
  });
});

// ── LOCATION goes through the holder-address gate ───────────────────────────
//
// This file is downloaded once and never refreshed, so what it says at
// download time is what the volunteer's calendar keeps.

describe("exportSignupIcs — address gate", () => {
  const PLACE_ID = "00000000-0000-4000-8000-00000000000c";
  const HOUR = 60 * 60 * 1000;

  /** Owned by ORG_ID, which also owns the fixture event (its own show). */
  const withheldPlace = {
    id: PLACE_ID,
    orgIdsWithAccess: [ORG_ID],
    humanIdsWithAccess: [],
    acceptsCommunityListings: true,
    name: "The Blue Door House",
    formattedAddress: "901 Porter Rd",
    city: "Nashville",
    region: "TN",
    locationMode: "OBSCURED",
    locationRadiusMeters: 800,
  };

  async function icsFor(
    eventOverrides: Record<string, unknown>,
    place: unknown = null,
    signupOverrides: Record<string, unknown> = {},
  ) {
    const getPlace = vi.fn(async () => place);
    const { deps, txRepos } = makeDeps({
      events: {
        getById: vi.fn(async () => ({
          ...event,
          locality: "Nashville",
          region: "TN",
          ...eventOverrides,
        })),
      },
      places: { getById: getPlace },
    });
    (txRepos.volunteering as any).getSignup = vi.fn(async () => ({
      ...eventSignup,
      ...signupOverrides,
    }));
    const result = await exportSignupIcs(deps, {
      actorHumanId: VOLUNTEER_ID,
      signupId: SIGNUP_ID,
    });
    return { ics: result.icsBody, getPlace };
  }

  it("EXACT: unchanged, no venue read", async () => {
    const { ics, getPlace } = await icsFor({});
    expect(ics).toContain("LOCATION:123 Main St\\, Somewhere");
    expect(getPlace).not.toHaveBeenCalled();
  });

  it("NEVER: the coarse area, never the street", async () => {
    const { ics } = await icsFor({
      locationMode: "OBSCURED",
      addressRevealPreset: "NEVER",
      addressRevealAt: null,
    });
    expect(ics).toContain("LOCATION:Nashville\\, TN");
    expect(ics).not.toContain("123 Main St");
  });

  it("before the reveal: the coarse area, never the street", async () => {
    const { ics } = await icsFor({
      locationMode: "OBSCURED",
      addressRevealPreset: "DAY_BEFORE",
      addressRevealAt: new Date(NOW.getTime() + HOUR),
    });
    expect(ics).toContain("LOCATION:Nashville\\, TN");
    expect(ics).not.toContain("123 Main St");
  });

  it("after the reveal at a withheld venue: the Place's street, not the Event projection", async () => {
    const { ics, getPlace } = await icsFor(
      {
        placeId: PLACE_ID,
        locationMode: "OBSCURED",
        addressRevealPreset: "DAY_BEFORE",
        addressRevealAt: new Date(NOW.getTime() - HOUR),
        addressText: "East Nashville",
      },
      withheldPlace,
    );
    expect(getPlace).toHaveBeenCalledWith(PLACE_ID);
    expect(ics).toContain("LOCATION:901 Porter Rd");
    expect(ics).not.toContain("LOCATION:East Nashville");
  });

  const revealedAtHouse = {
    placeId: PLACE_ID,
    locationMode: "OBSCURED",
    addressRevealPreset: "IMMEDIATELY",
    addressRevealAt: new Date(NOW.getTime() - HOUR),
    addressText: "East Nashville",
  };

  it("C1: a stranger's UNCONFIRMED event at the house: the coarse area, never the street", async () => {
    const { ics } = await icsFor(
      { ...revealedAtHouse, orgId: "99999999-9999-4999-8999-999999999999" },
      withheldPlace,
    );
    expect(ics).toContain("LOCATION:Nashville\\, TN");
    expect(ics).not.toContain("Porter");
  });

  it("M1: a PENDING signup's file carries NO location — and reads no venue", async () => {
    const { ics, getPlace } = await icsFor(revealedAtHouse, withheldPlace, {
      status: "PENDING",
    });
    expect(ics).not.toContain("LOCATION");
    expect(ics).not.toContain("Porter");
    expect(getPlace).not.toHaveBeenCalled();
  });

  it("M1: a PENDING signup gets no location even for a public EXACT event", async () => {
    const { ics } = await icsFor({}, null, { status: "PENDING" });
    expect(ics).not.toContain("LOCATION");
    expect(ics).not.toContain("123 Main St");
  });
});
