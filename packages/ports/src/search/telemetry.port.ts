import type {
  Result,
  SearchPortError,
  SearchTelemetryInteractionInput,
  SearchTelemetryInteractionResult,
} from "./types";

/** Logs ranking interactions for downstream learning-to-rank jobs. */
export interface SearchTelemetryPort {
  recordInteraction(
    input: SearchTelemetryInteractionInput,
  ): Promise<Result<SearchTelemetryInteractionResult, SearchPortError>>;
}
