import { describe, expect, it } from "vitest";

import { MEDIA_EMBED_PROVIDER_IDS as SCHEMA_IDS } from "@th/schema";

import { MEDIA_EMBED_PROVIDER_IDS, MEDIA_EMBED_PROVIDERS } from "./providers";

describe("media embed providers", () => {
  it("schema and core agree on the provider allowlist", () => {
    expect([...SCHEMA_IDS].sort()).toEqual(
      [...MEDIA_EMBED_PROVIDER_IDS].sort(),
    );
  });

  it("every provider id has metadata", () => {
    for (const id of MEDIA_EMBED_PROVIDER_IDS) {
      expect(MEDIA_EMBED_PROVIDERS[id]).toBeDefined();
      expect(MEDIA_EMBED_PROVIDERS[id].id).toBe(id);
      expect(MEDIA_EMBED_PROVIDERS[id].displayName.length).toBeGreaterThan(0);
      if (MEDIA_EMBED_PROVIDERS[id].renderMode === "iframe") {
        expect(MEDIA_EMBED_PROVIDERS[id].cspFrameSrc.length).toBeGreaterThan(0);
      }
    }
  });

  it("keeps Bandcamp explicit as link-card-only until oEmbed resolves player ids", () => {
    expect(MEDIA_EMBED_PROVIDERS.bandcamp.renderMode).toBe("link");
    expect(MEDIA_EMBED_PROVIDERS.bandcamp.cspFrameSrc).toEqual([]);
  });
});
