/**
 * Events per page on the plain category page (`/events/category/[slug]`).
 *
 * Read by BOTH the server loader (`loadCategoryPageEvents`, which seeds the
 * first page into the HTML) and the client component (`useCategoryEvents`).
 * The seed answers exactly the query input the client issues, so the two must
 * be one number: a mismatch puts the seed on a different query key and the
 * client fetches page one again.
 *
 * Both procedures cap `limit`: search (`discoverEventsByCategory`) at 50, the
 * DB list (`eventsByCategory`) at 100. Above 50, search answers BAD_REQUEST on
 * every view; `server/__tests__/category-page-events.test.ts` pins the bound.
 */
export const CATEGORY_PAGE_SIZE = 40;
