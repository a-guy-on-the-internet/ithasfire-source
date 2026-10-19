/**
 * Help articles whose URL slug changed. Each old URL keeps working with a
 * permanent (308) redirect, so inbound links and search results survive.
 * Help routes carry no locale prefix, so one entry per article is enough.
 *
 * A config redirect drops every `headers()` rule (Next returns
 * `resHeaders: null`), so the 308 carries no Cache-Control and a browser may
 * keep it. Never give a new article an old slug listed here.
 */
const RENAMED_HELP_ARTICLES: ReadonlyArray<readonly [string, string]> = [
  [
    "organising-events/claim-your-venue",
    "organising-events/claim-your-place",
  ],
  [
    "organising-events/hidden-venues-and-address-reveal",
    "organising-events/hidden-places-and-address-reveal",
  ],
  [
    "account/following-organisers-and-venues",
    "account/following-organisers-and-places",
  ],
];

export const HELP_ARTICLE_REDIRECTS = RENAMED_HELP_ARTICLES.map(
  ([from, to]) => ({
    source: `/help/${from}`,
    destination: `/help/${to}`,
    permanent: true as const,
  }),
);
