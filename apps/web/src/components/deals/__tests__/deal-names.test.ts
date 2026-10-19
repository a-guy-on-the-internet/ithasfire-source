import { describe, expect, it } from "vitest";

import { joinNames, namesToTell } from "../deal-names";

/**
 * Who "Saving tells …" names (freeze-the-deal FR-006): everyone the notice
 * reaches, which is every payee before or after the change less the person
 * making it. A group stays, since its other members are told.
 */
describe("namesToTell", () => {
  const me = { humanId: "h-me", name: "Paper Moth" };

  it("leaves out the actor when they are a person on the deal", () => {
    expect(
      namesToTell(
        [
          { kind: "human", id: "h-me", name: "Paper Moth" },
          { kind: "org", id: "o-act", name: "June Bug" },
          { kind: "human", id: "h-other", name: "Sam Ortiz" },
        ],
        me,
      ),
    ).toEqual(["June Bug", "Sam Ortiz"]);
  });

  it("keeps a group even when the actor is in it, and a namesake with another id", () => {
    expect(
      namesToTell(
        [
          { kind: "org", id: "h-me", name: "Paper Moth" },
          { kind: "human", id: "h-twin", name: "Paper Moth" },
        ],
        me,
      ),
    ).toEqual(["Paper Moth"]);
  });

  it("matches a resale recipient (no id) by name, and dedupes", () => {
    expect(
      namesToTell(
        [
          { kind: "human", name: "Paper Moth" },
          { kind: "org", name: "June Bug" },
          { kind: "org", id: "o-act", name: "June Bug" },
        ],
        me,
      ),
    ).toEqual(["June Bug"]);
  });

  it("names everyone while the viewer is unknown", () => {
    expect(
      namesToTell([{ kind: "human", id: "h-me", name: "Paper Moth" }], null),
    ).toEqual(["Paper Moth"]);
  });

  it("joins in the reader's language", () => {
    expect(joinNames(["A", "B", "C"], "en")).toBe("A, B, and C");
    expect(joinNames(["A", "B"], "es")).toBe("A y B");
  });
});
