/**
 * The builder's admin-level action gates, as a table. Each row is what the
 * server would allow: `unpublishEvent` (admin bar, PUBLISHED, not community),
 * `cancelEvent` (admin bar, DRAFT or PUBLISHED, not community — community
 * takedown is Take down listing's) and `regenerateEventSlug` (DRAFT or
 * PUBLISHED, not community; edit roles on a draft, the admin bar once
 * published). `cancelEvent` on a community listing is
 * platform-ADMIN only: Take down listing on DRAFT or PUBLISHED, nothing once
 * it has ended (owner ruling 2026-10-16).
 *
 * EDITOR = `canEdit` without `canManageEvent`; ADMIN = both.
 */
import { describe, expect, it } from "vitest";

import { builderAdminActionGates } from "../builder-admin-action-gates";

const EDITOR = { canEdit: true, canManageEvent: false };
const ADMIN = { canEdit: true, canManageEvent: true };

type Gates = {
  showUnpublish: boolean;
  showCancel: boolean;
  showTakeDownListing: boolean;
  canRegenerateSlug: boolean;
};
const NONE: Gates = {
  showUnpublish: false,
  showCancel: false,
  showTakeDownListing: false,
  canRegenerateSlug: false,
};

type Row = [
  label: string,
  who: { canEdit: boolean; canManageEvent: boolean },
  isCommunity: boolean,
  eventStatus: string,
  expected: Partial<Gates>,
];

const ROWS: Row[] = [
  // Owned events
  ["EDITOR, DRAFT", EDITOR, false, "DRAFT", { canRegenerateSlug: true }],
  ["EDITOR, PUBLISHED", EDITOR, false, "PUBLISHED", {}],
  ["EDITOR, CANCELLED", EDITOR, false, "CANCELLED", {}],
  ["ADMIN, DRAFT", ADMIN, false, "DRAFT", { showCancel: true, canRegenerateSlug: true }],
  ["ADMIN, PUBLISHED", ADMIN, false, "PUBLISHED", { showUnpublish: true, showCancel: true, canRegenerateSlug: true }],
  ["ADMIN, CANCELLED", ADMIN, false, "CANCELLED", {}],
  ["ADMIN, COMPLETED", ADMIN, false, "COMPLETED", {}],
  ["ADMIN, ARCHIVED", ADMIN, false, "ARCHIVED", {}],
  // Community listings, viewer NOT a platform ADMIN: none of them from the
  // builder, whoever asks — the use cases refuse an ownerless row.
  ["community EDITOR, DRAFT", EDITOR, true, "DRAFT", {}],
  ["community EDITOR, PUBLISHED", EDITOR, true, "PUBLISHED", {}],
  ["community ADMIN, DRAFT", ADMIN, true, "DRAFT", {}],
  ["community ADMIN, PUBLISHED", ADMIN, true, "PUBLISHED", {}],
  ["community ADMIN, CANCELLED", ADMIN, true, "CANCELLED", {}],
];

describe("builderAdminActionGates", () => {
  it.each(ROWS)("%s", (_label, who, isCommunity, eventStatus, expected) => {
    expect(
      builderAdminActionGates({
        ...who,
        isCommunity,
        isPlatformAdmin: false,
        eventStatus,
      }),
    ).toEqual({ ...NONE, ...expected });
  });

  it.each(["DRAFT", "PUBLISHED", "CANCELLED"])(
    "a viewer who cannot edit gets nothing on %s, even with the admin bar",
    (eventStatus) => {
      expect(
        builderAdminActionGates({
          canEdit: false,
          canManageEvent: true,
          isCommunity: false,
          isPlatformAdmin: false,
          eventStatus,
        }),
      ).toEqual(NONE);
    },
  );

  describe("a community listing viewed by a platform ADMIN", () => {
    // `canEdit` is false once a listing has ended (read-only builder), and the
    // server decides on the role alone, so the gate must not need it.
    const gates = (eventStatus: string, canEdit = true) =>
      builderAdminActionGates({
        canEdit,
        canManageEvent: false,
        isCommunity: true,
        isPlatformAdmin: true,
        eventStatus,
      });

    it.each(["DRAFT", "PUBLISHED"])("offers Take down listing on %s only", (status) => {
      expect(gates(status)).toEqual({ ...NONE, showTakeDownListing: true });
    });

    it.each(["CANCELLED", "COMPLETED"])(
      "offers nothing on a %s listing",
      (status) => {
        expect(gates(status, false)).toEqual(NONE);
      },
    );

    it("offers nothing on an ARCHIVED listing", () => {
      expect(gates("ARCHIVED", false)).toEqual(NONE);
    });

    it("never offers the owned-event Cancel or Unpublish", () => {
      const live = gates("PUBLISHED");
      expect(live.showCancel).toBe(false);
      expect(live.showUnpublish).toBe(false);
    });
  });

  it("platform ADMIN changes nothing on an owned event", () => {
    expect(
      builderAdminActionGates({
        ...ADMIN,
        isCommunity: false,
        isPlatformAdmin: true,
        eventStatus: "PUBLISHED",
      }),
    ).toEqual({
      ...NONE,
      showUnpublish: true,
      showCancel: true,
      canRegenerateSlug: true,
    });
  });
});
