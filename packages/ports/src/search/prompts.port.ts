import type {
  Result,
  SearchPortError,
  SearchPromptListInput,
  SearchPromptListResult,
} from "./types";

/** Exposes curated prompt metadata used to seed search autocomplete UI. */
export interface SearchPromptPort {
  listPrompts(
    input: SearchPromptListInput,
  ): Promise<Result<SearchPromptListResult, SearchPortError>>;
}
