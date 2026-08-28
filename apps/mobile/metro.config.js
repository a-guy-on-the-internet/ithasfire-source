const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");
const fs = require("fs");

const config = getDefaultConfig(__dirname);

const rootDir = path.resolve(__dirname, "..", "..");

config.watchFolders = [path.resolve(rootDir, "packages")];
config.resolver.unstable_enableSymlinks = true;
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, "node_modules"),
  path.resolve(rootDir, "node_modules"),
];

// Force ONE copy of every package that registers a native view or holds React
// state. Without this the app dies at startup with:
//
//   Invariant Violation: Tried to register two views with the same name
//   RNGestureHandlerButton
//
// ...because `nodeModulesPaths` lists both roots, so `apps/mobile` code resolves
// its own copy while `packages/ui` code resolves the hoisted one, and BOTH get
// bundled and register. Today that bites gesture-handler, which the repo carries
// at two versions (apps/mobile pins ~2.28.0; apps/web and packages/ui want
// >=2.29.1), but the same trap applies to anything with a native side.
//
// These point at the APP-LOCAL copies deliberately: `expo prebuild`/CocoaPods
// resolve the native pods from `apps/mobile/node_modules`, so the JS half has to
// match the compiled native half or the versions disagree at the bridge.
//
// The real fix is to align the versions across the workspace so pnpm hoists a
// single copy — this pinning is what keeps the app bootable until then.
// Mirrors the equivalent block in apps/scanner/metro.config.js.
const singletons = [
  "react",
  "react-native",
  "react-native-gesture-handler",
  "react-native-reanimated",
  "react-native-safe-area-context",
  "react-native-screens",
  "react-native-svg",
];

/** Singleton name -> the ONE directory every importer must resolve to. */
const singletonDirs = Object.fromEntries(
  singletons
    .map((name) => [name, path.resolve(__dirname, "node_modules", name)])
    .filter(([, dir]) => fs.existsSync(dir)),
);

// `extraNodeModules` alone is NOT enough: Metro only consults it when normal
// resolution FAILS, and resolution never fails here — `packages/ui` sits above
// the root `node_modules`, so it happily finds the hoisted copy. The redirect
// therefore has to happen in `resolveRequest`, below.
config.resolver.extraNodeModules = singletonDirs;

// Prefer .native.tsx variants inside @th/ui so RN-only components win
// over their web counterparts on iOS/Android. Mirrors apps/scanner.
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "lucide-react") {
    return context.resolveRequest(context, "lucide-react-native", platform);
  }

  // Collapse every importer of a singleton onto the SAME directory, whoever is
  // asking. Handles subpath imports too ("react-native-gesture-handler/src/..."),
  // which is how the second copy actually sneaks in.
  for (const [name, dir] of Object.entries(singletonDirs)) {
    if (moduleName === name || moduleName.startsWith(`${name}/`)) {
      const rest = moduleName.slice(name.length);
      return context.resolveRequest(context, `${dir}${rest}`, platform);
    }
  }

  if (
    platform &&
    platform !== "web" &&
    (moduleName.startsWith("./") || moduleName.startsWith("../"))
  ) {
    const originModulePath = context.originModulePath;
    if (originModulePath && originModulePath.includes("/packages/ui/")) {
      const dir = path.dirname(originModulePath);
      const resolved = path.resolve(dir, moduleName);
      const nativePath = `${resolved}.native.tsx`;
      if (fs.existsSync(nativePath)) {
        return { type: "sourceFile", filePath: nativePath };
      }
      const indexNativePath = path.join(resolved, "index.native.tsx");
      if (fs.existsSync(indexNativePath)) {
        return { type: "sourceFile", filePath: indexNativePath };
      }
    }
  }

  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
