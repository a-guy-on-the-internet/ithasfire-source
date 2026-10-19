import { describe, expect, it } from "vitest";

import {
  assertWriteAllowed,
  parseBackfillArgs,
  resolveDbHost,
} from "../src/scripts/backfill/backfill-category-slugs-args";

describe("backfill-category-slugs arguments and remote-host guard", () => {
  it("is a dry run unless --apply is passed", () => {
    expect(parseBackfillArgs([])).toEqual({
      apply: false,
      confirmRemoteHost: undefined,
    });
    expect(
      parseBackfillArgs(["--apply", "--confirm-remote-host=db.example.com"]),
    ).toEqual({ apply: true, confirmRemoteHost: "db.example.com" });
  });

  it("refuses an unknown flag instead of ignoring it", () => {
    expect(() => parseBackfillArgs(["--aply"])).toThrow();
  });

  it("a dry run is allowed on any host", () => {
    expect(() =>
      assertWriteAllowed({ apply: false }, "ep-prod.neon.tech"),
    ).not.toThrow();
  });

  it("--apply is allowed on a local host without confirmation", () => {
    for (const host of ["localhost", "127.0.0.1", "::1", "[::1]"]) {
      expect(() => assertWriteAllowed({ apply: true }, host)).not.toThrow();
    }
  });

  it("--apply on a remote host needs the matching --confirm-remote-host", () => {
    const host = "ep-prod.neon.tech";
    expect(() => assertWriteAllowed({ apply: true }, host)).toThrow(
      /Refusing to --apply/,
    );
    expect(() =>
      assertWriteAllowed(
        { apply: true, confirmRemoteHost: "other.example.com" },
        host,
      ),
    ).toThrow(/Refusing to --apply/);
    expect(() =>
      assertWriteAllowed({ apply: true, confirmRemoteHost: host }, host),
    ).not.toThrow();
  });

  it("resolves the host from DATABASE_URL and rejects a missing or bad one", () => {
    expect(resolveDbHost("postgresql://u:p@db.example.com:5432/x")).toBe(
      "db.example.com",
    );
    expect(() => resolveDbHost(undefined)).toThrow(/not set/);
    expect(() => resolveDbHost("nope")).toThrow(/parseable/);
  });
});
