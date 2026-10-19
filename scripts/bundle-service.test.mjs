// node --test scripts/bundle-service.test.mjs
//
// Fixture tests for `bundle-service.mjs --prune`: what the keep set follows,
// and the two guards that stop it from deleting something the bundle needs.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "bundle-service.mjs");
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// A deploy tree: <root>/app/dist/bundle.meta.json naming the externals, and
// <root>/deploy/{dist,node_modules}. `packages` maps a node_modules-relative
// path to its package.json fields, plus an optional `code` for index.js.
const fixture = (externals, packages) => {
  const root = mkdtempSync(join(tmpdir(), "bundle-service-test-"));
  roots.push(root);
  mkdirSync(join(root, "app", "dist"), { recursive: true });
  writeFileSync(
    join(root, "app", "dist", "bundle.meta.json"),
    JSON.stringify({
      outputs: { "dist/bundle/index.js": { imports: externals.map((path) => ({ path, external: true })) } },
    }),
  );
  mkdirSync(join(root, "deploy", "dist"), { recursive: true });
  for (const [rel, { code, ...manifest }] of Object.entries(packages)) {
    const dir = join(root, "deploy", "node_modules", rel);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: rel.split("/node_modules/").pop(), ...manifest }));
    writeFileSync(join(dir, "index.js"), code ?? "module.exports = {};\n");
  }
  return root;
};
const prune = (root) =>
  spawnSync(process.execPath, [SCRIPT, join(root, "app"), "--prune", join(root, "deploy", "dist")], {
    encoding: "utf8",
  });
const has = (root, rel) => existsSync(join(root, "deploy", "node_modules", rel, "package.json"));

test("keeps externals and what they depend on; drops the rest", () => {
  const root = fixture(["a", "a/sub"], {
    a: {
      dependencies: { b: "1" },
      optionalDependencies: { o: "1" },
      peerDependencies: { p: "1", c: "1", typescript: "5" },
      peerDependenciesMeta: { c: { optional: true } },
    },
    b: {},
    o: {},
    p: {},
    c: {}, // optional peer: not kept
    typescript: {}, // type-only peer: not kept
    unreached: {},
  });
  const run = prune(root);
  assert.equal(run.status, 0, run.stderr);
  for (const kept of ["a", "b", "o", "p"]) assert.ok(has(root, kept), `${kept} kept`);
  for (const gone of ["c", "typescript", "unreached"]) assert.ok(!has(root, gone), `${gone} pruned`);
});

test("resolves the way node does: a nested copy wins over the top-level one", () => {
  const root = fixture(["a"], {
    a: { dependencies: { n: "2" } },
    "a/node_modules/n": { version: "2.0.0" },
    n: { version: "1.0.0" }, // nobody resolves to this copy
  });
  const run = prune(root);
  assert.equal(run.status, 0, run.stderr);
  assert.ok(has(root, "a/node_modules/n"), "nested n kept");
  assert.ok(!has(root, "n"), "top-level n pruned");
});

test("fails, deleting nothing, when kept code loads a package it does not declare", () => {
  const root = fixture(["a"], {
    a: { code: 'const x = require("phantom");\nmodule.exports = () => import("lazy-peer");\n' },
    phantom: {},
    "lazy-peer": {},
    unreached: {},
  });
  const run = prune(root);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /a -> phantom/);
  assert.match(run.stderr, /a -> lazy-peer/);
  for (const still of ["phantom", "lazy-peer", "unreached"]) assert.ok(has(root, still), `${still} not deleted`);
});

test("ignores references in test and benchmark trees and in builtins", () => {
  const root = fixture(["a"], {
    a: { code: 'require("node:fs"); require("buffer");\n' },
    unreached: {},
  });
  const dir = join(root, "deploy", "node_modules", "a");
  mkdirSync(join(dir, "test"), { recursive: true });
  writeFileSync(join(dir, "test", "x.test.js"), 'require("unreached");\n');
  mkdirSync(join(dir, "benchmark"), { recursive: true });
  writeFileSync(join(dir, "benchmark", "b.js"), 'import "unreached";\n');
  const run = prune(root);
  assert.equal(run.status, 0, run.stderr);
  assert.ok(!has(root, "unreached"));
});

test("refuses to drop a package that contains a kept one", () => {
  const root = fixture(["a"], {
    a: { dependencies: { g: "1" } },
    dropped: {},
    "dropped/node_modules/g": {},
  });
  // node_modules/g is a link into the dropped package's tree, so the kept g's
  // real path is inside a directory the prune would delete.
  symlinkSync(join(root, "deploy", "node_modules", "dropped", "node_modules", "g"), join(root, "deploy", "node_modules", "g"));
  const run = prune(root);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /cannot prune .*dropped: it contains the kept .*dropped\/node_modules\/g/);
});
