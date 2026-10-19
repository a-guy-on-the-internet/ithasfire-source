import { describe, expect, it } from "vitest";

import { ADMIN_BOTTOM_NAV_HEIGHT_VAR } from "@th/ui";

import { selectionBarStyle } from "../seat-price-layout";

describe("the phone selection bar", () => {
  it("docks above the admin bottom nav, by the height the shell publishes", () => {
    // If the shell stops exporting the variable this import is undefined and
    // the bar would sit under the nav, where its button takes no taps.
    expect(ADMIN_BOTTOM_NAV_HEIGHT_VAR).toBe("--admin-bottom-nav-height");
    expect(selectionBarStyle.position).toBe("sticky");
    expect(selectionBarStyle.bottom).toBe(
      `var(${ADMIN_BOTTOM_NAV_HEIGHT_VAR}, 0px)`,
    );
  });
});
