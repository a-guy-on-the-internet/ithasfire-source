import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * `useCreateDraftEvent` navigates directly for ordinary admins, but for a
 * community moderator `createDraft` does nothing except flip the hook's
 * internal `modeChoiceOpen` state — the Ticketed-vs-Community chooser is what
 * actually moves them forward. So a caller that destructures `createDraft` but
 * forgets to render the returned `modeChoiceDialog` ships a button that is
 * silently dead for that entire user class: no navigation, no error, no console
 * warning, and nothing `tsc` can catch (destructuring fewer properties from an
 * object is perfectly legal TypeScript).
 *
 * That regression shipped once. A dashboard rewrite kept
 * `const { createDraft } = useCreateDraftEvent(slug)` but dropped the
 * `{modeChoiceDialog}` render, leaving the "Create event" quick action inert
 * for moderators while looking correct in review and in the typechecker.
 *
 * This pins the hook's documented contract ("Callers must render the returned
 * `modeChoiceDialog` element") on every call site, so the same omission fails
 * a test instead of reaching users.
 */

// Vitest runs this suite from the repo root in some configs and from
// `apps/web` in others, so anchor on whichever one actually resolves rather
// than assuming a cwd.
const SRC_ROOT = [
	join(process.cwd(), "src", "hooks"),
	join(process.cwd(), "apps", "web", "src", "hooks"),
]
	.filter((candidate) => existsSync(candidate))
	.map((candidate) => join(candidate, ".."))[0];

const HOOK_FILE = join("hooks", "useCreateDraftEvent.tsx");
const HOOK_CALL = "useCreateDraftEvent(";

function collectSourceFiles(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		// Test files legitimately mention the hook only to mock it.
		if (entry.name === "node_modules" || entry.name === "__tests__") continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...collectSourceFiles(full));
		else if (/\.tsx?$/.test(entry.name)) found.push(full);
	}
	return found;
}

const callers = collectSourceFiles(SRC_ROOT)
	.filter((file) => !file.endsWith(HOOK_FILE))
	.filter((file) => readFileSync(file, "utf8").includes(HOOK_CALL))
	.map((file) => relative(SRC_ROOT, file).split(sep).join("/"));

describe("useCreateDraftEvent caller contract", () => {
	// Guards the guard: if the directory walk ever stops matching (a moved
	// hook, a renamed folder), every assertion below would pass vacuously and
	// this file would be a permanently-green no-op.
	it("discovers the known call sites", () => {
		expect(SRC_ROOT).toBeDefined();
		expect(callers.length).toBeGreaterThanOrEqual(5);
	});

	it.each(callers)("%s renders modeChoiceDialog", (caller) => {
		const source = readFileSync(join(SRC_ROOT, caller), "utf8");

		// The render, not just the destructure — lines declaring the binding are
		// excluded so `const { modeChoiceDialog } = ...` alone cannot satisfy it.
		const rendersDialog = source
			.split("\n")
			.some(
				(line) =>
					/\{\s*modeChoiceDialog\s*\}/.test(line) && !line.includes("const "),
			);

		expect(rendersDialog).toBe(true);
	});
});
