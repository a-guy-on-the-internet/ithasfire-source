/**
 * Client-side aliases for the support chat DTOs.
 *
 * These mirror the typed tRPC output shapes (`supportThreadSchema` /
 * `supportMessageSchema`) so widget + inbox components share one vocabulary.
 * Sourced from the core schemas — never hand-rolled.
 */
export type {
  SupportThreadDto,
  SupportMessageDto,
} from "@th/core/use-cases/support";

export type {
  SupportThreadStatus,
  SupportAuthorType,
} from "@th/types/repos/support";
