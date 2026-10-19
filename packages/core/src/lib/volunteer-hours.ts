/**
 * Volunteer hours-crediting rule — `@th/core` entry point.
 *
 * THE IMPLEMENTATION LIVES A LAYER DOWN, in `@th/types`
 * (`packages/types/src/volunteer-hours.ts`), because `@th/adapters` cannot
 * import `@th/core` (it is a devDependency there, and adapters must not
 * depend on core) — and the Prisma repo is exactly where the rule is
 * applied. `@th/types` is the one module both sides can reach. Same
 * arrangement as `currency-utils` → `@th/types/money`.
 *
 * Do not add logic here; add it to `@th/types/volunteer-hours`.
 */

export {
  creditedHours,
  scheduledHoursBetween,
} from "@th/types/volunteer-hours";
