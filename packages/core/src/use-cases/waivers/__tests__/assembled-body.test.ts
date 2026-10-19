import { describe, expect, it } from "vitest";

import {
  composeAssembledWaiverBody,
  type AssemblableClause,
} from "../assembled-body";

const clause = (
  overrides: Partial<AssemblableClause> & Pick<AssemblableClause, "slug">,
): AssemblableClause => ({
  id: `id-${overrides.slug}`,
  version: 1,
  body: `BODY OF ${overrides.slug.toUpperCase()}.`,
  sortOrder: 0,
  ...overrides,
});

describe("composeAssembledWaiverBody", () => {
  it("sorts clauses by sortOrder and joins bodies with a blank line", () => {
    const { body } = composeAssembledWaiverBody([
      clause({ slug: "footer", sortOrder: 999 }),
      clause({ slug: "definitions", sortOrder: 10 }),
      clause({ slug: "release", sortOrder: 20 }),
    ]);

    expect(body).toBe(
      "BODY OF DEFINITIONS.\n\nBODY OF RELEASE.\n\nBODY OF FOOTER.",
    );
  });

  it("emits a manifest in body order with id, slug, and version", () => {
    const { assembledFromClauses } = composeAssembledWaiverBody([
      clause({ slug: "b", sortOrder: 20, version: 3 }),
      clause({ slug: "a", sortOrder: 10 }),
    ]);

    expect(assembledFromClauses).toEqual([
      { clauseId: "id-a", clauseSlug: "a", clauseVersion: 1 },
      { clauseId: "id-b", clauseSlug: "b", clauseVersion: 3 },
    ]);
  });

  it("does not mutate the input array", () => {
    const input = [
      clause({ slug: "b", sortOrder: 20 }),
      clause({ slug: "a", sortOrder: 10 }),
    ];
    composeAssembledWaiverBody(input);
    expect(input.map((c) => c.slug)).toEqual(["b", "a"]);
  });

  it("returns empty body and manifest for zero clauses", () => {
    expect(composeAssembledWaiverBody([])).toEqual({
      body: "",
      assembledFromClauses: [],
    });
  });
});
