import type { PlaceLayoutGeometryParserResult } from "./types";

export type PlaceLayoutGeometryParserInput = {
  placeId: string;
  uploadRef: string;
  format: "cad" | "svg" | "csv" | string;
  source: "admin_wizard" | "api" | "import_job" | string;
};

export interface PlaceLayoutGeometryParserPort {
  parse(
    input: PlaceLayoutGeometryParserInput,
  ): Promise<PlaceLayoutGeometryParserResult>;
}
