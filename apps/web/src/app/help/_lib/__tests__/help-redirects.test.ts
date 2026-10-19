import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { HELP_ARTICLE_REDIRECTS } from "../../../../../config/help-redirects";

const CONTENT_ROOT = join(__dirname, "..", "..", "..", "..", "..", "content", "help");

describe("HELP_ARTICLE_REDIRECTS", () => {
  it("redirects each renamed venue slug permanently to its place slug", () => {
    expect(HELP_ARTICLE_REDIRECTS).toEqual([
      {
        source: "/help/organising-events/claim-your-venue",
        destination: "/help/organising-events/claim-your-place",
        permanent: true,
      },
      {
        source: "/help/organising-events/hidden-venues-and-address-reveal",
        destination: "/help/organising-events/hidden-places-and-address-reveal",
        permanent: true,
      },
      {
        source: "/help/account/following-organisers-and-venues",
        destination: "/help/account/following-organisers-and-places",
        permanent: true,
      },
    ]);
  });

  it("points at article files that exist, and away from ones that do not", () => {
    for (const r of HELP_ARTICLE_REDIRECTS) {
      const file = (url: string) =>
        join(CONTENT_ROOT, `${url.replace("/help/", "")}.md`);
      expect(existsSync(file(r.destination))).toBe(true);
      expect(existsSync(file(r.source))).toBe(false);
    }
  });
});
