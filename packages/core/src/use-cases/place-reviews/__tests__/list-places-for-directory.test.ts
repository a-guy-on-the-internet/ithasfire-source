import { describe, expect, it, vi } from "vitest";

import { listPlacesForDirectory } from "../list-places-for-directory";
import type { ListPlacesForDirectoryDeps } from "../list-places-for-directory";
import type {
  MultiSearchAutocompleteInput,
  MultiSearchAutocompleteOutput,
} from "@th/ports/search/multi-index.types";
import { ok, err, SearchPortError } from "@th/ports/search";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makePlaceSuggestion(overrides: Record<string, unknown> = {}) {
  return {
    type: "place" as const,
    id: "place_00000000-0000-4000-8000-00000000000a",
    placeId: "00000000-0000-4000-8000-00000000000a",
    title: "The Basement East",
    subtitle: "123 Main St, Nashville, TN",
    helper: null,
    confidence: 0.9,
    slug: "the-basement-east",
    city: "Nashville",
    capacity: null,
    ...overrides,
  };
}

function makeDeps(
  result: MultiSearchAutocompleteOutput | { error: SearchPortError } = {
    suggestions: [],
    latencyMs: 5,
  },
): ListPlacesForDirectoryDeps {
  return {
    search: {
      autocomplete: vi.fn(async (_input: MultiSearchAutocompleteInput) => {
        if ("error" in result) return err(result.error);
        return ok(result);
      }),
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("listPlacesForDirectory", () => {
  it("returns mapped places from Meilisearch suggestions", async () => {
    const deps = makeDeps({
      suggestions: [
        makePlaceSuggestion(),
        makePlaceSuggestion({
          id: "place_00000000-0000-4000-8000-00000000000b",
          placeId: "00000000-0000-4000-8000-00000000000b",
          title: "Exit/In",
          city: "Nashville",
        }),
      ],
      latencyMs: 5,
    });

    const result = await listPlacesForDirectory(deps, { query: "Basement" });

    expect(result.places).toHaveLength(2);
    expect(result.places[0]).toEqual({
      id: "00000000-0000-4000-8000-00000000000a",
      name: "The Basement East",
      city: "Nashville",
      region: null,
      countryCode: null,
    });
  });

  it("calls autocomplete with types=['place'] and listedInDirectoryOnly=true", async () => {
    const deps = makeDeps({ suggestions: [], latencyMs: 5 });

    await listPlacesForDirectory(deps, { query: "basement" });

    expect(deps.search.autocomplete).toHaveBeenCalledWith({
      query: "basement",
      limit: 20,
      filters: {
        types: ["place"],
        listedInDirectoryOnly: true,
      },
    });
  });

  it("throws invalid_input when query is too short (schema guard)", async () => {
    const deps = makeDeps();

    await expect(
      listPlacesForDirectory(deps, { query: "a" }),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(deps.search.autocomplete).not.toHaveBeenCalled();
  });

  it("returns empty array when no query is provided", async () => {
    const deps = makeDeps();

    const result = await listPlacesForDirectory(deps);

    expect(result.places).toEqual([]);
    expect(deps.search.autocomplete).not.toHaveBeenCalled();
  });

  it("throws transient error when search adapter fails", async () => {
    const searchError = Object.assign(new Error("Meilisearch down"), {
      code: "dependency_failed",
    });
    const deps = makeDeps({ error: searchError as unknown as SearchPortError });

    await expect(
      listPlacesForDirectory(deps, { query: "Nashville" }),
    ).rejects.toMatchObject({
      code: "transient",
    });
  });

  describe("swallowed search-backend failure reporting", () => {
    // Note: the "throws transient error when search adapter fails" test above
    // already covers the reportError-not-wired path (deps carry no reporter).

    it("reports the underlying backend error and still throws the typed transient error", async () => {
      // The typed `transient` throw hides the underlying backend failure from
      // operators, so the raw error must be forwarded to the reporter first.
      const searchError = new SearchPortError(
        "dependency_failed",
        "Meilisearch down",
      );
      const reportError = vi.fn();
      const deps = {
        ...makeDeps({ error: searchError }),
        reportError,
      };

      await expect(
        listPlacesForDirectory(deps, { query: "Nashville" }),
      ).rejects.toMatchObject({
        code: "transient",
        message: "Meilisearch down",
      });

      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(searchError, {
        tags: { useCase: "listPlacesForDirectory" },
        extra: { query: "Nashville" },
      });
    });

    it("a throwing reporter never pre-empts the typed transient throw", async () => {
      const deps = {
        ...makeDeps({
          error: new SearchPortError("dependency_failed", "Meilisearch down"),
        }),
        reportError: vi.fn(() => {
          throw new Error("sentry is down too");
        }),
      };

      // The rejection must still be the typed transient error, not the
      // reporter's own throw.
      await expect(
        listPlacesForDirectory(deps, { query: "Nashville" }),
      ).rejects.toMatchObject({
        code: "transient",
        message: "Meilisearch down",
      });
      expect(deps.reportError).toHaveBeenCalledTimes(1);
    });

    it("does not call reportError on the success path", async () => {
      const reportError = vi.fn();
      const deps = {
        ...makeDeps({ suggestions: [makePlaceSuggestion()], latencyMs: 5 }),
        reportError,
      };

      const result = await listPlacesForDirectory(deps, { query: "Basement" });

      expect(result.places).toHaveLength(1);
      expect(reportError).not.toHaveBeenCalled();
    });
  });

  it("handles null city gracefully", async () => {
    const deps = makeDeps({
      suggestions: [makePlaceSuggestion({ city: null })],
      latencyMs: 5,
    });

    const result = await listPlacesForDirectory(deps, { query: "Basement" });

    expect(result.places[0]).toEqual({
      id: "00000000-0000-4000-8000-00000000000a",
      name: "The Basement East",
      city: null,
      region: null,
      countryCode: null,
    });
  });
});
