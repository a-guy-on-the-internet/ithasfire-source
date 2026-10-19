import { describe, expect, it } from "vitest";

import type { OwnerEntityWithSlug } from "@/hooks/useEventOwnerEntities";
import {
  adminAgreementHref,
  adminBookingHref,
  agreementMayRedirect,
  findAgreementPartyOwner,
  performerBookingRequestsHref,
  resolveAgreementAdminRedirect,
  resolveAgreementsListRedirect,
  standaloneAgreementHref,
} from "../agreement-routes";

const ORG: OwnerEntityWithSlug = {
  kind: "org",
  orgId: "org-1",
  orgName: "Greek Theatre",
  orgSlug: "greek",
  role: "ADMIN",
  avatarUrl: null,
  adminSlug: "greek",
};

const HUMAN: OwnerEntityWithSlug = {
  kind: "human",
  humanId: "hum-1",
  humanName: "Alice",
  humanUsername: "alice",
  avatarUrl: null,
  adminSlug: "@alice",
};

const agreement = {
  proposerType: "organization" as const,
  proposerId: "org-1",
  counterpartyType: "human" as const,
  counterpartyId: "act-9",
};

describe("agreement route builders", () => {
  it("builds the three hrefs", () => {
    expect(standaloneAgreementHref("ag-1")).toBe("/agreements/ag-1");
    expect(adminAgreementHref("greek", "ag-1")).toBe(
      "/admin/greek/bookings/agreement/ag-1",
    );
    expect(adminBookingHref("greek", "req-1")).toBe(
      "/admin/greek/bookings?request=req-1",
    );
    expect(adminBookingHref("greek", null)).toBe("/admin/greek/bookings");
  });
});

describe("agreementMayRedirect", () => {
  it("is true for the editor, and for any org party; false for a human act", () => {
    expect(
      agreementMayRedirect({
        viewerSide: "editor",
        actorSide: "proposer",
        agreement,
      }),
    ).toBe(true);
    expect(
      agreementMayRedirect({
        viewerSide: "act",
        actorSide: "counterparty",
        agreement: { ...agreement, counterpartyType: "organization" },
      }),
    ).toBe(true);
    expect(
      agreementMayRedirect({
        viewerSide: "act",
        actorSide: "counterparty",
        agreement,
      }),
    ).toBe(false);
  });
});

describe("findAgreementPartyOwner", () => {
  it("returns the viewer's entity for the actor's party, never the other party's", () => {
    expect(
      findAgreementPartyOwner({ actorSide: "proposer", agreement }, [
        HUMAN,
        ORG,
      ]),
    ).toBe(ORG);
    expect(
      findAgreementPartyOwner({ actorSide: "counterparty", agreement }, [
        HUMAN,
        ORG,
      ]),
    ).toBeNull();
    expect(
      findAgreementPartyOwner({ actorSide: "proposer", agreement }, undefined),
    ).toBeNull();
  });
});

describe("resolveAgreementAdminRedirect", () => {
  it("sends the editor party to its own admin shell", () => {
    expect(
      resolveAgreementAdminRedirect({
        agreementId: "ag-1",
        viewerSide: "editor",
        actorSide: "proposer",
        agreement,
        owners: [HUMAN, ORG],
      }),
    ).toBe("/admin/greek/bookings/agreement/ag-1");
  });

  it("matches a HUMAN editor party by human id, under the @ shell", () => {
    expect(
      resolveAgreementAdminRedirect({
        agreementId: "ag-1",
        viewerSide: "editor",
        actorSide: "counterparty",
        agreement: {
          ...agreement,
          counterpartyType: "human",
          counterpartyId: "hum-1",
        },
        owners: [HUMAN],
      }),
    ).toBe("/admin/@alice/bookings/agreement/ag-1");
  });

  it("moves an ORGANIZATION acting as the performer into its own admin", () => {
    expect(
      resolveAgreementAdminRedirect({
        agreementId: "ag-1",
        viewerSide: "act",
        actorSide: "counterparty",
        agreement: {
          ...agreement,
          proposerType: "human",
          proposerId: "venue-owner",
          counterpartyType: "organization",
          counterpartyId: "org-1",
        },
        owners: [HUMAN, ORG],
      }),
    ).toBe("/admin/greek/bookings/agreement/ag-1");
  });

  it("keeps a HUMAN acting as the performer on the standalone page", () => {
    expect(
      resolveAgreementAdminRedirect({
        agreementId: "ag-1",
        viewerSide: "act",
        actorSide: "counterparty",
        agreement: { ...agreement, counterpartyId: "hum-1" },
        owners: [HUMAN, ORG],
      }),
    ).toBeNull();
  });

  it("keeps an act with no matching entity on the standalone page", () => {
    expect(
      resolveAgreementAdminRedirect({
        agreementId: "ag-1",
        viewerSide: "act",
        actorSide: "counterparty",
        agreement,
        owners: [HUMAN, ORG],
      }),
    ).toBeNull();
  });

  it("keeps a HUMAN party of a request-less agreement (viewerSide null) where it is", () => {
    expect(
      resolveAgreementAdminRedirect({
        agreementId: "ag-1",
        viewerSide: null,
        actorSide: "counterparty",
        agreement: { ...agreement, counterpartyId: "hum-1" },
        owners: [HUMAN],
      }),
    ).toBeNull();
  });

  it("stays put when the editor's party has no owner entity (place grant, no membership)", () => {
    expect(
      resolveAgreementAdminRedirect({
        agreementId: "ag-1",
        viewerSide: "editor",
        actorSide: "proposer",
        agreement,
        owners: [HUMAN],
      }),
    ).toBeNull();
  });

  it("never matches the OTHER party's entity", () => {
    // The viewer is the counterparty (act-9) but an org with the proposer's
    // id is in their list — that is the venue's slug, not theirs.
    expect(
      resolveAgreementAdminRedirect({
        agreementId: "ag-1",
        viewerSide: "editor",
        actorSide: "counterparty",
        agreement,
        owners: [ORG],
      }),
    ).toBeNull();
  });

  it("does not decide while owners are unknown", () => {
    expect(
      resolveAgreementAdminRedirect({
        agreementId: "ag-1",
        viewerSide: "editor",
        actorSide: "proposer",
        agreement,
        owners: undefined,
      }),
    ).toBeNull();
  });
});

describe("resolveAgreementsListRedirect", () => {
  it("sends a single-org viewer straight to that org's booking inbox", () => {
    expect(resolveAgreementsListRedirect([HUMAN, ORG])).toBe(
      "/admin/greek/bookings",
    );
  });

  it("sends a multi-org viewer to the /admin chooser", () => {
    const org2: OwnerEntityWithSlug = {
      ...ORG,
      orgId: "org-2",
      orgSlug: "fox",
      adminSlug: "fox",
    };
    expect(resolveAgreementsListRedirect([HUMAN, ORG, org2])).toBe("/admin");
  });

  it("sends a human performer (no org) to settings → Booking requests", () => {
    expect(resolveAgreementsListRedirect([HUMAN])).toBe(
      "/account/settings/booking-requests",
    );
    expect(resolveAgreementsListRedirect([])).toBe(
      "/account/settings/booking-requests",
    );
    expect(resolveAgreementsListRedirect(undefined)).toBe(
      "/account/settings/booking-requests",
    );
    expect(performerBookingRequestsHref()).toBe(
      "/account/settings/booking-requests",
    );
  });
});
