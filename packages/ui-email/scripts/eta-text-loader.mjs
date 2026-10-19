import { readFile } from "node:fs/promises";

export async function resolve(specifier, context, defaultResolve) {
	if (specifier.endsWith(".eta")) {
		return {
			url: new URL(specifier, context.parentURL).href,
			shortCircuit: true,
		};
	}

	return defaultResolve(specifier, context, defaultResolve);
}

export async function load(url, context, defaultLoad) {
	if (url.endsWith(".eta")) {
		const source = await readFile(new URL(url));
		return {
			format: "module",
			source: `export default ${JSON.stringify(source.toString("utf8"))};`,
			shortCircuit: true,
		};
	}

	return defaultLoad(url, context, defaultLoad);
}
