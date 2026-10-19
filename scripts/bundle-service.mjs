#!/usr/bin/env node
// Bundles a Node service (apps/api, apps/jobs) into plain JS for its image.
//
//   node scripts/bundle-service.mjs apps/api
//   node scripts/bundle-service.mjs apps/api --prune /opt/api/dist
//   node scripts/bundle-service.mjs apps/api --check-externals /opt/api/dist
//
// The first form writes <app>/dist/bundle/ (index.js + chunks + source maps)
// and <app>/dist/bundle.meta.json (the esbuild metafile, outside the bundle so
// it is not shipped).
//
// The second form builds nothing. It reads that metafile and resolves every
// external package the bundle imports, with node's own ESM resolver, from the
// given directory, i.e. from where the bundle will run in the image. It
// fails when one is missing, and when a workspace package carries its own
// nested copy of a package it declares and the bundle imports
// (node_modules/@th/*/node_modules/<pkg>): the inlined code
// used to load that nested copy and now loads the top-level one, which may be
// a different version. The Dockerfiles run it on the `pnpm deploy`
// output, because a dependency that only a workspace package declared (and
// that pnpm therefore nested or dropped) would otherwise surface as a crash
// on the first request that reaches the import.
//
// The --prune form (the Dockerfiles run it between two --check-externals
// runs) deletes every package in the deploy output's node_modules that the
// bundle cannot reach: the externals in the metafile, then each package's
// dependencies, optionalDependencies and
// non-optional peerDependencies, resolved the way node resolves them. Why:
// `pnpm deploy --legacy` also installs the workspace ROOT package.json's prod
// dependencies (expo, react-native: the hoisted mobile apps need them there)
// and auto-installed optional peers (better-auth -> vitest -> vite), and it
// copies the raw @th/* sources the bundle has already inlined. Pruning took
// the API's runtime node_modules from 668 MB to 250 MB (2026-10-16). The keep
// set is derived from the bundle itself, so it stays right whatever the root
// manifest or pnpm's peer handling does next.
//
// Why: the containers used to run `node --import tsx src/index.ts`, which
// transpiles every module of the app and the raw-TS workspace packages at boot
// and keeps the compiler resident. On a 1 GiB Cloud Run instance that meant a
// 56 s cold boot and repeated OOM kills (owner ruling 2026-10-15: "we need to
// run the pre built code").
//
// Shape of the bundle:
// - Every `@th/*` workspace package is INLINED. They export raw `src/*.ts`, so
//   plain node cannot load them from node_modules. The app's tsconfig is applied
//   to all inlined packages (fine while no server-side package ships .tsx).
// - Every other bare specifier stays EXTERNAL and resolves at runtime from the
//   `pnpm deploy` node_modules next to dist/. Native addons, Prisma's generated
//   client and the Sentry/OpenTelemetry hooks all depend on that.
// - `splitting: true` keeps each dynamic `import()` in its own chunk. Both
//   entrypoints import `./instrument` statically and only then `await import()`
//   the app, so Sentry.init runs before fastify/pg/prisma/ioredis are loaded and
//   its import hooks can wrap them. Without splitting, esbuild would hoist
//   those imports to the top of index.js, ahead of Sentry.init, and tracing
//   would go silently dead. The check below fails the build if that happens.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";

const [appArg, flag, checkDirArg] = process.argv.slice(2);
if (
  !appArg ||
  (flag && (!["--check-externals", "--prune"].includes(flag) || !checkDirArg))
) {
  console.error(
    "usage: node scripts/bundle-service.mjs <app-dir> " +
      "[--prune <runtime-dist-dir> | --check-externals <runtime-dist-dir>]",
  );
  process.exit(2);
}

const appDir = resolve(appArg);
const outdir = join(appDir, "dist", "bundle");
const metaPath = join(appDir, "dist", "bundle.meta.json");
const entry = join(appDir, "src", "index.ts");

const builtins = new Set(builtinModules);
const isBuiltin = (spec) =>
  spec.startsWith("node:") || builtins.has(spec.split("/")[0]);

const externalPackages = (metafile) => {
  const specs = new Set();
  for (const out of Object.values(metafile.outputs)) {
    for (const imp of out.imports) {
      if (imp.external && !isBuiltin(imp.path)) specs.add(imp.path);
    }
  }
  return [...specs].sort();
};

// "lodash/fp" -> "lodash", "@scope/pkg/sub" -> "@scope/pkg"
const packageName = (spec) =>
  spec
    .split("/")
    .slice(0, spec.startsWith("@") ? 2 : 1)
    .join("/");

const readVersion = (pkgDir) => {
  try {
    return JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version;
  } catch {
    return "absent";
  }
};

// Externals that may be absent from the deploy output on purpose. Each is
// reached only through a dynamic import behind an opt-in env var, and is a
// devDependency of the workspace package that imports it, so `pnpm deploy
// --prod` leaves it out. The check reports them but does not fail on them.
// Add an entry only with the same justification; anything else that is
// missing must be declared as a dependency instead.
const OPTIONAL_EXTERNALS = new Set([
  // packages/adapters/src/infra/otel-bootstrap.ts: loaded only when
  // OTEL_EXPORTER_OTLP_ENDPOINT is set, which no deployed env sets. Sentry
  // carries its own OpenTelemetry setup.
  "@opentelemetry/sdk-node",
  "@opentelemetry/exporter-trace-otlp-http",
]);

// The nearest directory at or above `dir` that has a node_modules.
const findDeployRoot = (dir) => {
  let root = dir;
  while (!existsSync(join(root, "node_modules")) && dirname(root) !== root) {
    root = dirname(root);
  }
  return root;
};

// Peers that a package declares for its type declarations only. A peer named
// here does not keep the package in the pruned output. Verified 2026-10-16 by
// grepping the deploy output for require/import of "typescript": only
// @expo/require-utils loads it, and that is pruned (@trpc/server and
// @prisma/client declare it for their .d.ts files).
const TYPE_ONLY_PEERS = new Set(["typescript"]);

if (flag === "--prune") {
  const runtimeDir = resolve(checkDirArg);
  const deployRoot = findDeployRoot(runtimeDir);
  const nodeModules = join(deployRoot, "node_modules");
  const specs = externalPackages(JSON.parse(readFileSync(metaPath, "utf8")));

  // node's lookup: <dir>/node_modules/<name>, then each parent's.
  const findPackage = (fromDir, name) => {
    for (let dir = fromDir; ; dir = dirname(dir)) {
      const candidate = join(dir, "node_modules", name);
      if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
      if (dirname(dir) === dir) return null;
    }
  };
  const readManifest = (pkgDir) => {
    try {
      return JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
    } catch {
      return {};
    }
  };

  const keep = new Set();
  const queue = [];
  const reach = (fromDir, name) => {
    const dir = findPackage(fromDir, name);
    if (dir && !keep.has(dir)) {
      keep.add(dir);
      queue.push(dir);
    }
    return dir;
  };
  for (const spec of new Set(specs.map(packageName))) {
    // A missing external is reported by --check-externals, which runs next.
    reach(runtimeDir, spec);
  }
  while (queue.length > 0) {
    const dir = queue.pop();
    const pkg = readManifest(dir);
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
      reach(dir, name);
    }
    for (const name of Object.keys(pkg.peerDependencies ?? {})) {
      if (pkg.peerDependenciesMeta?.[name]?.optional || TYPE_ONLY_PEERS.has(name)) continue;
      reach(dir, name);
    }
  }

  // Kept code that names a package the prune is about to delete. The keep set
  // follows manifests, so it misses a package that a kept one loads without
  // declaring it (a phantom that only worked because pnpm hoisted it) and an
  // optional peer that a kept one loads lazily. Either would pass both
  // --check-externals runs and throw ERR_MODULE_NOT_FOUND on the first request
  // that reaches it. So, before deleting anything: every string-literal
  // require()/import()/from in a kept package's runtime files must not resolve
  // to a package that is about to go. Test, benchmark and example trees are
  // skipped; nothing loads them at runtime.
  const NOT_RUNTIME =
    /\/(test|tests|__tests__|benchmark|benchmarks|bench|example|examples|experiment|scripts|docs|fixtures|test-utils)\//;
  const SPEC = /(?:\brequire\s*\(\s*|\bimport\s*\(\s*|\bfrom\s+|\bimport\s+)["']([^"'./#][^"'\s]*)["']/g;
  const VALID_NAME = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;
  const builtins = new Set(builtinModules);
  // "<kept package> -> <pruned package>" references that are allowed to go
  // dead, each with the reason nothing loads it at runtime. Add an entry only
  // with the same kind of justification; anything else must be kept (declare
  // it in the app's package.json) instead.
  const DEAD_REFERENCES = new Map([
    // integrations/tracing/connect.js: the require("connect") is a usage
    // example in a JSDoc comment. Sentry patches connect only if the app loads
    // it, and nothing does.
    ["@sentry/node -> connect", "doc comment"],
    // debug/src/node.js requires supports-color inside try/catch ("Optional
    // dependency" in its source); without it DEBUG output is uncoloured.
    ["debug -> supports-color", "optional, inside try/catch"],
    // prettier/internal/legacy-cli.mjs: prettier's own CLI. The app reaches
    // prettier only through @react-email/render's formatter, never the CLI.
    ["prettier -> tinybench", "CLI-only code"],
  ]);
  const dead = new Map();
  let scannedFiles = 0;
  const scanForDeadReferences = (pkgDir) => {
    const owner = readManifest(pkgDir).name ?? relative(nodeModules, pkgDir);
    const stack = [pkgDir];
    while (stack.length > 0) {
      const d = stack.pop();
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, entry.name);
        // Nested node_modules hold separate packages, scanned when kept.
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules") stack.push(full);
          continue;
        }
        if (!/\.(c|m)?js$/.test(entry.name) || NOT_RUNTIME.test(`${full.slice(pkgDir.length)}`)) {
          continue;
        }
        scannedFiles += 1;
        for (const match of readFileSync(full, "utf8").matchAll(SPEC)) {
          const spec = match[1];
          if (isBuiltin(spec) || builtins.has(spec)) continue;
          const name = packageName(spec);
          if (!VALID_NAME.test(name)) continue;
          const target = findPackage(dirname(full), name);
          if (!target || keep.has(target)) continue;
          const key = `${owner} -> ${name}`;
          if (!dead.has(key)) dead.set(key, relative(nodeModules, full));
        }
      }
    }
  };
  for (const dir of keep) scanForDeadReferences(dir);
  const unexplained = [...dead].filter(([key]) => !DEAD_REFERENCES.has(key));
  if (unexplained.length > 0) {
    console.error(
      "bundle-service: kept packages load packages the prune would delete:\n  " +
        unexplained.map(([key, file]) => `${key}  (${file})`).join("\n  ") +
        "\nDeclare each in the app's package.json dependencies, or, if nothing " +
        "loads it at runtime, add it to DEAD_REFERENCES with the reason.",
    );
    process.exit(1);
  }
  console.log(
    `bundle-service: ${scannedFiles} runtime files in ${keep.size} kept packages ` +
      `reference no pruned package (${dead.size} allowed by DEAD_REFERENCES)`,
  );

  // Every installed package directory, top-level and nested.
  const installed = [];
  const scan = (nmDir) => {
    for (const entry of readdirSync(nmDir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(nmDir, entry.name);
      if (entry.name.startsWith("@")) {
        for (const sub of readdirSync(full)) visit(join(full, sub));
      } else {
        visit(full);
      }
    }
  };
  const visit = (dir) => {
    if (!existsSync(join(dir, "package.json"))) return;
    installed.push(dir);
    if (existsSync(join(dir, "node_modules"))) scan(join(dir, "node_modules"));
  };
  scan(nodeModules);

  const dirBytes = (dir) => {
    let bytes = 0;
    const stack = [dir];
    while (stack.length > 0) {
      const d = stack.pop();
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        if (entry.isDirectory()) stack.push(join(d, entry.name));
        else if (entry.isFile()) bytes += statSync(join(d, entry.name)).size;
      }
    }
    return bytes;
  };
  const before = dirBytes(nodeModules);
  const keptDirs = [...keep];
  const removed = [];
  for (const dir of installed) {
    if (!existsSync(dir)) continue; // went with a dropped parent
    const real = realpathSync(dir);
    if (keep.has(real)) continue;
    // A kept package nested under a dropped one would go with it.
    const inside = keptDirs.find((k) => k.startsWith(`${real}/`));
    if (inside) {
      console.error(`bundle-service: cannot prune ${dir}: it contains the kept ${inside}`);
      process.exit(1);
    }
    rmSync(dir, { recursive: true, force: true });
    removed.push(relative(nodeModules, dir));
  }
  // Links to the dropped CLIs; nothing at runtime runs them.
  rmSync(join(nodeModules, ".bin"), { recursive: true, force: true });
  // Empty scope directories left behind.
  for (const entry of readdirSync(nodeModules)) {
    const full = join(nodeModules, entry);
    if (entry.startsWith("@") && readdirSync(full).length === 0) rmSync(full, { recursive: true });
  }
  const after = dirBytes(nodeModules);
  const mb = (b) => (b / 1024 / 1024).toFixed(0);
  console.log(
    `bundle-service: pruned ${removed.length} of ${installed.length} packages ` +
      `from ${nodeModules} (${mb(before)} MB -> ${mb(after)} MB); kept ${keep.size} ` +
      `reachable from ${specs.length} externals`,
  );
  if (process.env.BUNDLE_PRUNE_VERBOSE) console.log(removed.sort().join("\n"));
  process.exit(0);
}

if (flag === "--check-externals") {
  const runtimeDir = resolve(checkDirArg);
  const specs = externalPackages(JSON.parse(readFileSync(metaPath, "utf8")));
  const optional = specs.filter((spec) => OPTIONAL_EXTERNALS.has(spec));

  // Nested copies under workspace packages. Before bundling, code in
  // @th/<ws> resolved <pkg> to node_modules/@th/<ws>/node_modules/<pkg> when
  // pnpm nested one there (a version conflict with the top-level copy). Now
  // that code is inlined into dist/ and resolves the top-level copy instead.
  const deployRoot = findDeployRoot(runtimeDir);
  const wsRoot = join(deployRoot, "node_modules", "@th");
  const imported = new Set(specs.map(packageName));
  const shadowed = [];
  const listDir = (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  };
  if (!existsSync(wsRoot)) {
    // After --prune there are no @th copies to compare against, so this half
    // of the check has nothing to look at. The Dockerfiles run the check once
    // on the unpruned deploy output for exactly this reason.
    console.log(`bundle-service: no ${wsRoot}, nested-copy check skipped (pruned output)`);
  }
  for (const ws of listDir(wsRoot)) {
    const nested = join(wsRoot, ws, "node_modules");
    // Only what @th/<ws> declares itself: its source is what got inlined. A
    // nested copy that belongs to one of its dependencies (htmlparser2's
    // `entities` under @th/ui-email) was never loaded by the inlined code.
    let declared;
    try {
      const pkg = JSON.parse(readFileSync(join(wsRoot, ws, "package.json"), "utf8"));
      declared = new Set(
        Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies }),
      );
    } catch {
      continue;
    }
    const names = listDir(nested).flatMap((entry) =>
      entry.startsWith("@")
        ? listDir(join(nested, entry)).map((sub) => `${entry}/${sub}`)
        : [entry],
    );
    for (const name of names) {
      if (!imported.has(name) || !declared.has(name)) continue;
      shadowed.push(
        `${name}: @th/${ws} loaded its nested ${readVersion(join(nested, name))}, ` +
          `the bundle loads top-level ${readVersion(join(deployRoot, "node_modules", name))}`,
      );
    }
  }
  if (shadowed.length > 0) {
    console.error(
      "bundle-service: workspace packages carry nested copies of packages the " +
        "bundle imports. The inlined code now loads the top-level copy instead:\n  " +
        shadowed.join("\n  ") +
        "\nAlign the version ranges across the workspace so pnpm hoists one copy, " +
        "or declare the needed version in the app's package.json.",
    );
  }
  // A probe module placed in the runtime dir, so import.meta.resolve walks the
  // same node_modules chain the bundle's chunks will.
  const probe = join(runtimeDir, `.resolve-probe-${process.pid}.mjs`);
  writeFileSync(
    probe,
    `const optional = new Set(${JSON.stringify(optional)});
const missing = [];
const skipped = [];
for (const spec of ${JSON.stringify(specs)}) {
  try { import.meta.resolve(spec); } catch (err) {
    (optional.has(spec) ? skipped : missing).push(spec + " (" + err.code + ")");
  }
}
if (skipped.length) console.log("bundle-service: optional externals absent (allowed): " + skipped.join(", "));
if (missing.length) { console.error("unresolvable: " + missing.join(", ")); process.exit(1); }
console.log("bundle-service: " + (${specs.length} - skipped.length) + " of ${specs.length} external packages resolve from ${runtimeDir}");
`,
  );
  let unresolved = false;
  try {
    execFileSync(process.execPath, [probe], { stdio: "inherit" });
  } catch {
    unresolved = true;
    console.error(
      "bundle-service: the bundle imports packages that are missing from the " +
        "deploy output. Declare them in the app's package.json dependencies.",
    );
  } finally {
    rmSync(probe, { force: true });
  }
  process.exit(unresolved || shadowed.length > 0 ? 1 : 0);
}

// esbuild is pinned at 0.25.12 in the root package.json: the hoisted copy the
// bundle was built and verified with (2026-10-15). tsx brings its own 0.28.0,
// nested under node_modules/tsx, and does not affect this one; moving to 0.28
// is an upgrade to make on purpose, with the guards and a boot check rerun.
const esbuild = await import("esbuild");

// Inline workspace code, externalize everything else.
const externalizeThirdParty = {
  name: "externalize-third-party",
  setup(build) {
    build.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path.startsWith("@th/")) return undefined;
      return { path: args.path, external: true };
    });
  },
};

rmSync(outdir, { recursive: true, force: true });

const result = await esbuild.build({
  entryPoints: { index: entry },
  absWorkingDir: appDir,
  tsconfig: join(appDir, "tsconfig.json"),
  outdir,
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node22",
  // Maps without embedded sources: enough to resolve frames to src/*.ts lines,
  // at a fraction of the file size. In the images they are only uploaded to
  // Sentry (debug IDs injected by the Dockerfile; the image runs without
  // --enable-source-maps and ships no .map). "linked" keeps the
  // sourceMappingURL comment for local `pnpm start`, which still passes the
  // flag. chunkNames keeps [hash]: shared chunks are all named "chunk", so
  // [name] alone collides, and Sentry matches maps by debug ID, not file name.
  sourcemap: "linked",
  sourcesContent: false,
  // Not minified: function names stay readable in stack traces and logs even
  // when a frame is reported without its source map.
  minify: false,
  keepNames: true,
  chunkNames: "chunks/[name]-[hash]",
  metafile: true,
  logLevel: "warning",
  plugins: [externalizeThirdParty],
});

writeFileSync(metaPath, JSON.stringify(result.metafile));

// --- Instrumentation-order guard ------------------------------------------
// Everything the entry chunk loads through static imports is evaluated before
// a single line of index.ts runs, so it is loaded before Sentry.init. Walk the
// static import graph from index.js and fail on any external that is not on
// this ALLOWLIST. An allowlist, not a list of instrumented libraries: Sentry's
// set of auto-instrumented packages grows, and a library missing from a
// blocklist would load untraced without a word.
// Node builtins are allowed too. To load anything else early, either move it
// behind the `await import()` of the app or add it here deliberately, knowing
// Sentry will not instrument it.
const ENTRY_ALLOWLIST = [
  /^@sentry\/node(\/|$)/,
  /^isbot$/,
  /^@trpc\/server(\/|$)/,
  /^zod(\/|$)/,
];

const outputs = result.metafile.outputs;
const outKey = (abs) => relative(appDir, abs).split("\\").join("/");
const entryKey = outKey(join(outdir, "index.js"));
if (!outputs[entryKey]) {
  console.error(`bundle-service: entry chunk ${entryKey} missing from metafile`);
  process.exit(1);
}

// esbuild's ESM output turns a require() of an external into a `__require`
// shim that throws "Dynamic require of X is not supported" at runtime. Fail
// on it in any chunk, not just the entry graph.
const requires = [];
for (const [key, out] of Object.entries(outputs)) {
  for (const imp of out.imports) {
    if (imp.kind === "require-call" || imp.kind === "require-resolve") {
      requires.push(`${key}: ${imp.kind} ${imp.path}`);
    }
  }
}
if (requires.length > 0) {
  console.error(
    "bundle-service: the ESM bundle contains require() calls, which throw at " +
      "runtime:\n  " +
      requires.join("\n  ") +
      "\nUse an import, or createRequire(import.meta.url) in the source.",
  );
  process.exit(1);
}

const staticExternals = new Set();
const seen = new Set();
const queue = [entryKey];
while (queue.length > 0) {
  const key = queue.pop();
  if (seen.has(key)) continue;
  seen.add(key);
  for (const imp of outputs[key].imports) {
    if (imp.kind !== "import-statement") continue;
    if (imp.external) {
      staticExternals.add(imp.path);
    } else if (outputs[imp.path]) {
      queue.push(imp.path);
    } else {
      // A shared chunk the walk cannot find would be skipped silently and the
      // guard would pass without having looked at it.
      console.error(
        `bundle-service: ${key} imports ${imp.path}, which is not a key in the ` +
          "metafile outputs. The load-order guard cannot walk the entry graph.",
      );
      process.exit(1);
    }
  }
}

// Proof the walk sees the entry graph at all: instrument.ts imports Sentry
// statically, so it must be here.
if (!staticExternals.has("@sentry/node")) {
  console.error(
    "bundle-service: @sentry/node is not among the entry chunk's static " +
      `imports (found: ${[...staticExternals].sort().join(", ") || "none"}). ` +
      "Either instrument.ts stopped importing it or the guard's walk is broken.",
  );
  process.exit(1);
}

const early = [...staticExternals].filter(
  (spec) => !isBuiltin(spec) && !ENTRY_ALLOWLIST.some((re) => re.test(spec)),
);
if (early.length > 0) {
  console.error(
    "bundle-service: the entry chunk statically imports " +
      `${early.join(", ")}. Static imports reachable from index.js load before ` +
      "Sentry.init, so Sentry cannot instrument them. Load them after " +
      "Sentry.init (through the app's `await import()`), or extend " +
      "ENTRY_ALLOWLIST in scripts/bundle-service.mjs deliberately.",
  );
  process.exit(1);
}

const externals = externalPackages(result.metafile);

const jsBytes = Object.entries(outputs)
  .filter(([k]) => k.endsWith(".js"))
  .reduce((sum, [, o]) => sum + o.bytes, 0);

console.log(
  `bundle-service: ${outKey(outdir)} ${(jsBytes / 1024 / 1024).toFixed(1)} MB js, ` +
    `${Object.keys(outputs).filter((k) => k.endsWith(".js")).length} chunks, ` +
    `${externals.length} external packages; entry chunk static externals: ` +
    `${[...staticExternals].sort().join(", ")}`,
);
