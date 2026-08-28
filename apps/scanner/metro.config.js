const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");
const fs = require("fs");
const config = getDefaultConfig(__dirname);

const rootDir = path.resolve(__dirname, "..", "..");
const floatingUiStub = path.resolve(__dirname, "src", "shims", "floating-ui-react-stub.ts");

config.watchFolders = [path.resolve(rootDir, "packages")];
config.resolver.unstable_enableSymlinks = true;
config.resolver.nodeModulesPaths = [
	path.resolve(__dirname, "node_modules"),
	path.resolve(rootDir, "node_modules"),
];

// Explicit fallbacks for packages that pnpm hoists to the workspace root
// but doesn't always link into `apps/scanner/node_modules`. Without these,
// Metro's resolver walks up from `apps/scanner/node_modules/expo/...`
// looking for sibling node_modules and fails before reaching the root,
// even though `nodeModulesPaths` lists root explicitly.
config.resolver.extraNodeModules = {
	"@babel/runtime": path.resolve(rootDir, "node_modules", "@babel", "runtime"),
	"react-native": path.resolve(rootDir, "node_modules", "react-native"),
	"react": path.resolve(rootDir, "node_modules", "react"),
	"react-dom": path.resolve(rootDir, "node_modules", "react-dom"),
};

config.resolver.resolveRequest = (context, moduleName, platform) => {
	if (moduleName === "lucide-react") {
		return context.resolveRequest(context, "lucide-react-native", platform);
	}

	if (moduleName === "@floating-ui/react") {
		return { type: "sourceFile", filePath: floatingUiStub };
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
