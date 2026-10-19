import { describe, expect, it } from "vitest";

import { resolveEntityPageEditorMode } from "../editor-mode";

describe("resolveEntityPageEditorMode", () => {
  it("is edit-only whenever the entityPageEditor gate is off, for every layout", () => {
    for (const effectiveLayout of ["standard", "stack", "grid"]) {
      expect(
        resolveEntityPageEditorMode({ editorGateOn: false, effectiveLayout }),
      ).toBe("edit-only");
    }
  });

  it("is edit-only on the standard layout even when the gate is on", () => {
    expect(
      resolveEntityPageEditorMode({
        editorGateOn: true,
        effectiveLayout: "standard",
      }),
    ).toBe("edit-only");
  });

  it("is full only when the gate is on AND the layout is freeform", () => {
    expect(
      resolveEntityPageEditorMode({
        editorGateOn: true,
        effectiveLayout: "stack",
      }),
    ).toBe("full");
    expect(
      resolveEntityPageEditorMode({
        editorGateOn: true,
        effectiveLayout: "grid",
      }),
    ).toBe("full");
  });
});
