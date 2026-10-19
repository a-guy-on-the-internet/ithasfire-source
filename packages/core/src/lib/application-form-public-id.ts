import { generateRandomShortId } from "./slug-utils";

/**
 * Mint `EventApplicationForm.publicId` (open calls v1, spec FR-003): the short
 * random id behind `/call/<publicId>`, never the event id or slug.
 *
 * Same shape as `Event.shortId` and as the step-1 migration's backfill
 * (`20261005120000_open_calls`): 10 lowercase base-36 characters from a fresh
 * random UUID. The column is `@unique`; at 36^10 values a collision is
 * vanishingly rare, and the DB constraint turns one into a loud failure
 * rather than a shared link.
 *
 * Lives in `core/lib` (not a use case) so every place that creates a form row
 * mints it the same way: the Prisma adapter, the dev seed and the e2e routes.
 */
export function mintApplicationFormPublicId(): string {
  return generateRandomShortId();
}
