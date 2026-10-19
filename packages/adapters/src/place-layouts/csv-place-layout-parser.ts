/**
 * CSV-format adapter for PlaceLayoutGeometryParserPort.
 *
 * Fetches raw CSV content from object storage (via signed URL) and delegates
 * to the pure `parsePlaceLayoutCsv` function. This adapter handles the I/O
 * boundary; the parsing logic is fully testable in isolation.
 */
import type { LoggerPort } from "@th/ports/logger";
import type { FileStoragePort } from "@th/ports/file-storage";
import type {
  PlaceLayoutGeometryParserPort,
  PlaceLayoutGeometryParserInput,
  PlaceLayoutGeometryParserResult,
} from "@th/ports/place-layouts";

import {
  parsePlaceLayoutCsv,
  type ParsePlaceLayoutCsvOptions,
} from "./parse-place-layout-csv";

export type CsvPlaceLayoutParserOptions = {
  storage: FileStoragePort;
  logger?: LoggerPort;
  /** Options forwarded to the pure CSV parser. */
  parserOptions?: ParsePlaceLayoutCsvOptions;
};

export class CsvPlaceLayoutParser implements PlaceLayoutGeometryParserPort {
  private readonly storage: FileStoragePort;
  private readonly logger?: LoggerPort;
  private readonly parserOptions?: ParsePlaceLayoutCsvOptions;

  constructor(options: CsvPlaceLayoutParserOptions) {
    this.storage = options.storage;
    this.logger = options.logger;
    this.parserOptions = options.parserOptions;
  }

  async parse(
    input: PlaceLayoutGeometryParserInput,
  ): Promise<PlaceLayoutGeometryParserResult> {
    if (input.format !== "csv") {
      return {
        glyphs: [],
        sections: [],
        issues: [
          {
            code: "unsupported_format",
            message: `CsvPlaceLayoutParser only supports "csv" format, got "${input.format}"`,
            severity: "error",
          },
        ],
      };
    }

    this.logger?.info("csv_parser_fetching_upload", {
      placeId: input.placeId,
      uploadRef: input.uploadRef,
      source: input.source,
    });

    // Fetch the raw CSV content from storage via signed URL
    const csvText = await this.fetchCsvContent(input.uploadRef);

    this.logger?.info("csv_parser_parsing", {
      placeId: input.placeId,
      contentLength: csvText.length,
    });

    const result = parsePlaceLayoutCsv(csvText, this.parserOptions);

    this.logger?.info("csv_parser_complete", {
      placeId: input.placeId,
      glyphCount: result.glyphs.length,
      sectionCount: result.sections.length,
      issueCount: result.issues.length,
    });

    return result;
  }

  /**
   * Fetch CSV content from object storage.
   *
   * Gets a signed URL for the upload ref key, then fetches the content.
   * Enforces a 5 MB hard cap on response body size to prevent memory
   * exhaustion — this mirrors the presign limit.
   */
  private async fetchCsvContent(uploadRef: string): Promise<string> {
    const MAX_CSV_BYTES = 5 * 1024 * 1024; // 5 MB — matches presign cap

    const { url } = await this.storage.getObjectUrl({
      key: uploadRef,
      options: { expiresSec: 300 },
    });

    const response = await fetch(url);
    if (!response.ok) {
      throw Object.assign(
        new Error(`Failed to fetch CSV from storage: HTTP ${response.status}`),
        {
          code: "dependency_failed",
          uploadRef,
          httpStatus: response.status,
        },
      );
    }

    // Guard against oversized bodies (e.g. storage object replaced after presign)
    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > MAX_CSV_BYTES) {
      throw Object.assign(
        new Error(
          `CSV content exceeds ${MAX_CSV_BYTES} byte limit (content-length: ${contentLength})`,
        ),
        { code: "file_too_large", uploadRef },
      );
    }

    const text = await response.text();
    if (text.length > MAX_CSV_BYTES) {
      throw Object.assign(
        new Error(
          `CSV content exceeds ${MAX_CSV_BYTES} byte limit (actual: ${text.length})`,
        ),
        { code: "file_too_large", uploadRef },
      );
    }

    return text;
  }
}
