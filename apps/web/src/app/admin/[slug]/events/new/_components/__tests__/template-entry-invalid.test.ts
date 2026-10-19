import { describe, expect, it, vi } from "vitest";

// The dialog module pulls in the design system and tRPC; this test is only
// about the pure error reader it exports.
vi.mock("@th/ui", () => ({}));
vi.mock("@/trpc", () => ({ trpc: {} }));

import { templateEntryInvalidName } from "../ApplyTicketTypeTemplateDialog";

describe("templateEntryInvalidName — naming the entry a template apply was refused for", () => {
  it("reads the entry name off the wire's data.meta", () => {
    expect(
      templateEntryInvalidName({
        message: "template_entry_invalid",
        data: { meta: { entryName: "Sliding scale", reason: "…" } },
      }),
    ).toBe("Sliding scale");
  });

  it("anything else falls through to the generic message", () => {
    expect(templateEntryInvalidName({ message: "invalid_input" })).toBeNull();
    expect(
      templateEntryInvalidName({ message: "template_entry_invalid", data: {} }),
    ).toBeNull();
    expect(templateEntryInvalidName(null)).toBeNull();
  });
});
