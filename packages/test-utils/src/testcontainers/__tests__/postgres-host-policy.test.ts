import { describe, expect, it } from "vitest";

import {
  SHARED_PG_DEFAULT_PORT,
  SWEEP_INTERVAL_MS,
  POSTGIS_TEST_IMAGE,
  SHARED_PG_CONFIG_VERSION,
  classifyDockerInspectError,
  describeSharedContainerDrift,
  formatSweepComment,
  formatTemplateComment,
  isDockerNameConflict,
  isSweepDue,
  parseDockerPort,
  parseTemplateComment,
  resolveHostPgMode,
  selectLeakedTestDatabases,
  selectTemplatesToRetire,
  sharedPgPort,
  sharedPgUrl,
} from "../postgres-host-policy";

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);

describe("resolveHostPgMode", () => {
  it("an explicit reuse URL wins everywhere, CI included", () => {
    expect(
      resolveHostPgMode({
        TESTCONTAINERS_REUSE_DATABASE_URL: " postgresql://x@h:1/db ",
        CI: "true",
        DATABASE_URL: "postgresql://ci@h:2/dev",
      }),
    ).toEqual({ kind: "reuse", url: "postgresql://x@h:1/db" });
  });

  it("CI with DATABASE_URL reuses it, as before", () => {
    for (const CI of ["true", "TRUE", "1"]) {
      expect(
        resolveHostPgMode({ CI, DATABASE_URL: "postgresql://ci@h:2/dev" }),
      ).toEqual({ kind: "reuse", url: "postgresql://ci@h:2/dev" });
    }
  });

  it("CI without DATABASE_URL keeps a container per file, never the shared server", () => {
    expect(resolveHostPgMode({ CI: "true" })).toEqual({ kind: "container" });
  });

  it("a local run ignores DATABASE_URL (it can be Neon) and uses the shared server", () => {
    expect(
      resolveHostPgMode({ DATABASE_URL: "postgresql://neon.example/prod" }),
    ).toEqual({ kind: "shared", port: SHARED_PG_DEFAULT_PORT });
    expect(resolveHostPgMode({ CI: "false" })).toEqual({
      kind: "shared",
      port: SHARED_PG_DEFAULT_PORT,
    });
  });

  it("TESTCONTAINERS_SHARED_PG=0 opts out to a container per file", () => {
    expect(resolveHostPgMode({ TESTCONTAINERS_SHARED_PG: "0" })).toEqual({
      kind: "container",
    });
  });

  it("honours a port override", () => {
    expect(
      resolveHostPgMode({ TESTCONTAINERS_SHARED_PG_PORT: "55000" }),
    ).toEqual({ kind: "shared", port: 55000 });
  });
});

describe("sharedPgPort", () => {
  it("rejects a port that is not a valid unprivileged integer", () => {
    for (const bad of ["abc", "80", "70000", "5432.5", "5432"]) {
      expect(() =>
        sharedPgPort({ TESTCONTAINERS_SHARED_PG_PORT: bad }),
      ).toThrow(/TESTCONTAINERS_SHARED_PG_PORT/);
    }
  });
});

describe("sharedPgUrl", () => {
  it("binds 127.0.0.1 on the given port", () => {
    expect(sharedPgUrl(54329)).toBe(
      "postgresql://postgres:postgres@127.0.0.1:54329/postgres",
    );
    expect(sharedPgUrl(54329, "test_abc")).toBe(
      "postgresql://postgres:postgres@127.0.0.1:54329/test_abc",
    );
  });
});

describe("docker output parsing", () => {
  it("reads the host port from `docker port`", () => {
    expect(parseDockerPort("127.0.0.1:54329\n")).toBe(54329);
    expect(parseDockerPort("0.0.0.0:54329\n[::]:54329\n")).toBe(54329);
    expect(parseDockerPort("")).toBeUndefined();
  });

  it("recognises a name conflict as someone else's claim", () => {
    expect(
      isDockerNameConflict(
        'docker: Error response from daemon: Conflict. The container name "/th-test-pg" is already in use by container "abc". You have to remove (or rename) that container to be able to reuse that name.',
      ),
    ).toBe(true);
    expect(
      isDockerNameConflict("Bind for 127.0.0.1:54329 failed: port is already allocated"),
    ).toBe(false);
  });
});

describe("classifyDockerInspectError", () => {
  it("reads only an explicit no-such-object as missing", () => {
    expect(
      classifyDockerInspectError("Error: No such object: th-test-pg"),
    ).toBe("missing");
    expect(
      classifyDockerInspectError(
        "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
      ),
    ).toBe("daemon");
    expect(classifyDockerInspectError("")).toBe("daemon");
  });
});

describe("describeSharedContainerDrift", () => {
  it("is clean for the current image and config version", () => {
    expect(
      describeSharedContainerDrift({
        image: POSTGIS_TEST_IMAGE,
        config: SHARED_PG_CONFIG_VERSION,
      }),
    ).toEqual([]);
  });

  it("flags a server from before the config label, and a foreign image", () => {
    expect(
      describeSharedContainerDrift({ image: POSTGIS_TEST_IMAGE, config: "" }),
    ).toHaveLength(1);
    expect(
      describeSharedContainerDrift({
        image: "postgis/postgis:16-3.4",
        config: "1",
      }),
    ).toHaveLength(2);
  });
});

describe("isSweepDue", () => {
  it("is due when never stamped or the stamp is foreign", () => {
    expect(isSweepDue(null, NOW)).toBe(true);
    expect(isSweepDue("default administrative connection database", NOW)).toBe(
      true,
    );
  });

  it("waits out the interval, and is due exactly at it", () => {
    expect(isSweepDue(formatSweepComment(NOW - 10 * 60 * 1000), NOW)).toBe(
      false,
    );
    expect(isSweepDue(formatSweepComment(NOW - SWEEP_INTERVAL_MS), NOW)).toBe(
      true,
    );
  });

  it("is due when the stamp is in the future (clock moved back)", () => {
    expect(isSweepDue(formatSweepComment(NOW + HOUR), NOW)).toBe(true);
  });
});

describe("template last-used comment", () => {
  it("round-trips", () => {
    expect(parseTemplateComment(formatTemplateComment(NOW))).toBe(NOW);
  });

  it("ignores foreign or missing comments", () => {
    expect(parseTemplateComment(null)).toBeUndefined();
    expect(parseTemplateComment("hello")).toBeUndefined();
  });
});

describe("selectTemplatesToRetire", () => {
  const current = "test_template_cur";

  it("keeps another session's recently used template (no thrash between trees)", () => {
    expect(
      selectTemplatesToRetire(
        [
          { name: current, lastUsedMs: undefined },
          { name: "test_template_peer", lastUsedMs: NOW - 2 * HOUR },
        ],
        current,
        NOW,
      ),
    ).toEqual([]);
  });

  it("retires templates idle past the limit, and ones of unknown age", () => {
    expect(
      selectTemplatesToRetire(
        [
          { name: "test_template_old", lastUsedMs: NOW - 25 * HOUR },
          { name: "test_template_unknown", lastUsedMs: undefined },
          { name: "test_template_recent", lastUsedMs: NOW - HOUR },
        ],
        current,
        NOW,
      ).sort(),
    ).toEqual(["test_template_old", "test_template_unknown"]);
  });

  it("caps the total, current included, dropping the least recently used", () => {
    const templates = Array.from({ length: 5 }, (_, i) => ({
      name: `test_template_t${i}`,
      lastUsedMs: NOW - i * HOUR,
    }));
    expect(
      selectTemplatesToRetire(templates, current, NOW, { keepMax: 3 }),
    ).toEqual(["test_template_t2", "test_template_t3", "test_template_t4"]);
  });

  it("keeps a template idle exactly 24 h, retires one just past it", () => {
    expect(
      selectTemplatesToRetire(
        [
          { name: "test_template_edge", lastUsedMs: NOW - 24 * HOUR },
          { name: "test_template_past", lastUsedMs: NOW - 24 * HOUR - 1 },
        ],
        current,
        NOW,
      ),
    ).toEqual(["test_template_past"]);
  });

  it("keeps a template stamped in the future (clock skew) as fresh", () => {
    expect(
      selectTemplatesToRetire(
        [{ name: "test_template_future", lastUsedMs: NOW + HOUR }],
        current,
        NOW,
      ),
    ).toEqual([]);
  });

  it("never retires the current template or a non-template database", () => {
    const retire = selectTemplatesToRetire(
      [
        { name: current, lastUsedMs: NOW - 100 * HOUR },
        { name: "test_abc123", lastUsedMs: NOW - 100 * HOUR },
        { name: "postgres", lastUsedMs: undefined },
      ],
      current,
      NOW,
    );
    expect(retire).toEqual([]);
  });
});

describe("selectLeakedTestDatabases", () => {
  it("selects only old, unconnected per-file test databases", () => {
    expect(
      selectLeakedTestDatabases(
        [
          { name: "test_leaked", createdMs: NOW - 30 * HOUR, connections: 0 },
          { name: "test_live_old", createdMs: NOW - 30 * HOUR, connections: 2 },
          { name: "test_fresh", createdMs: NOW - HOUR, connections: 0 },
          { name: "test_unknown_age", createdMs: undefined, connections: 0 },
          {
            name: "test_template_abc",
            createdMs: NOW - 30 * HOUR,
            connections: 0,
          },
          { name: "postgres", createdMs: NOW - 30 * HOUR, connections: 0 },
          { name: "testdb", createdMs: NOW - 30 * HOUR, connections: 0 },
          { name: "test_Upper", createdMs: NOW - 30 * HOUR, connections: 0 },
          { name: "test_edge_24h", createdMs: NOW - 24 * HOUR, connections: 0 },
          { name: "test_future", createdMs: NOW + HOUR, connections: 0 },
        ],
        NOW,
      ),
    ).toEqual(["test_leaked"]);
  });
});
