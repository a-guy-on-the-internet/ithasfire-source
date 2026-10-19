import { describe, it, expect } from "vitest";
import {
  getExportGuardStatus,
  rowsToCsv,
  EXPORT_WARN_THRESHOLD,
  EXPORT_BACKGROUND_THRESHOLD,
} from "../csv-export";

describe("getExportGuardStatus", () => {
  it('returns "ok" when total is below warn threshold', () => {
    expect(getExportGuardStatus(0)).toBe("ok");
    expect(getExportGuardStatus(100)).toBe("ok");
    expect(getExportGuardStatus(EXPORT_WARN_THRESHOLD)).toBe("ok");
  });

  it('returns "warn" when total exceeds warn but not background threshold', () => {
    expect(getExportGuardStatus(EXPORT_WARN_THRESHOLD + 1)).toBe("warn");
    expect(getExportGuardStatus(EXPORT_BACKGROUND_THRESHOLD)).toBe("warn");
  });

  it('returns "background" when total exceeds background threshold', () => {
    expect(getExportGuardStatus(EXPORT_BACKGROUND_THRESHOLD + 1)).toBe(
      "background",
    );
    expect(getExportGuardStatus(100_000)).toBe("background");
  });
});

describe("rowsToCsv", () => {
  it("produces correct CSV with header and rows", () => {
    const rows = [
      { name: "Alice", age: 30 },
      { name: "Bob", age: 25 },
    ];
    const columns = [
      { header: "Name", value: (r: (typeof rows)[0]) => r.name },
      { header: "Age", value: (r: (typeof rows)[0]) => r.age },
    ];

    const csv = rowsToCsv(rows, columns);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("Name,Age");
    expect(lines[1]).toBe("Alice,30");
    expect(lines[2]).toBe("Bob,25");
  });

  it("escapes commas and quotes in values", () => {
    const rows = [{ val: 'has "quotes" and, comma' }];
    const columns = [
      { header: "Value", value: (r: (typeof rows)[0]) => r.val },
    ];

    const csv = rowsToCsv(rows, columns);
    expect(csv).toContain('"has ""quotes"" and, comma"');
  });

  it("handles null/undefined values as empty string", () => {
    const rows = [{ val: null as string | null }];
    const columns = [
      { header: "Value", value: (r: (typeof rows)[0]) => r.val },
    ];

    const csv = rowsToCsv(rows, columns);
    const lines = csv.split("\n");
    expect(lines[1]).toBe("");
  });
});
