import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const PORT = Number(process.env.STORYBOOK_PORT ?? 6006);
const HOST = process.env.STORYBOOK_HOST ?? "127.0.0.1";
const TIMEOUT_MS = Number(process.env.STORYBOOK_SMOKE_TIMEOUT_MS ?? 90_000);

const BASE_URL = `http://${HOST}:${PORT}`;

function log(message) {
	process.stdout.write(`[storybook-pw-smoke] ${message}\n`);
}

async function waitForHttpOk(url, timeoutMs) {
	const start = Date.now();
	let lastErr;
	while (Date.now() - start < timeoutMs) {
		try {
			const res = await fetch(url);
			if (res.ok) return;
			lastErr = new Error(`HTTP ${res.status} for ${url}`);
		} catch (err) {
			lastErr = err;
		}
		await delay(500);
	}
	throw lastErr ?? new Error(`Timed out waiting for ${url}`);
}

async function main() {
	log(`booting Storybook dev server on ${BASE_URL}`);

	// Storybook Vite builder can occasionally return 504 (Outdated Optimize Dep) if its
	// optimized-deps cache doesn't match the currently-installed dependency graph.
	// Wiping the cache makes this smoke deterministic.
	try {
		await rm(resolve(process.cwd(), "node_modules/.cache/storybook"), {
			recursive: true,
			force: true,
		});
	} catch {
		// ignore
	}

	const child = spawn(
		"pnpm",
		["storybook", "--", "-p", String(PORT), "--host", HOST, "--quiet"],
		{
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				BROWSER: "none",
				// Reduce flakiness from stale Vite optimized deps when the cache changes.
				// Storybook's Vite builder respects Vite's force option.
				VITE_FORCE: "true",
			},
		},
	);

	let stderr = "";
	let stdout = "";
	child.stdout.on("data", (d) => (stdout += String(d)));
	child.stderr.on("data", (d) => (stderr += String(d)));

	const kill = async (signal = "SIGTERM") => {
		if (child.killed) return;
		child.kill(signal);
		await delay(1500);
		if (!child.killed) child.kill("SIGKILL");
	};

	const timeoutTimer = setTimeout(async () => {
		await kill("SIGTERM");
		log(`timed out after ${TIMEOUT_MS}ms`);
		if (stdout.trim()) log(`stdout tail:\n${stdout.split("\n").slice(-40).join("\n")}`);
		if (stderr.trim()) log(`stderr tail:\n${stderr.split("\n").slice(-40).join("\n")}`);
		process.exit(1);
	}, TIMEOUT_MS);

	try {
		await waitForHttpOk(`${BASE_URL}/iframe.html`, TIMEOUT_MS);

		// Run @playwright/test against Storybook's dev server.
		// Note: we run it as a separate process so the Playwright runner
		// always owns browser lifecycle.
		log("running Playwright smoke spec");

		const pw = spawn(
			"pnpm",
			[
				"exec",
				"playwright",
				"test",
				"-c",
				"./playwright.storybook-smoke.config.ts",
				"./scripts/storybook-smoke.spec.ts",
				"--reporter=line",
			],
			{
				stdio: "inherit",
				env: {
					...process.env,
					STORYBOOK_BASE_URL: BASE_URL,
					STORYBOOK_PORT: String(PORT),
					STORYBOOK_HOST: HOST,
				},
			},
		);

		const exitCode = await new Promise((resolve) => {
			pw.on("exit", (code) => resolve(code ?? 1));
		});

		clearTimeout(timeoutTimer);
		await kill("SIGTERM");
		process.exit(exitCode);
	} catch (err) {
		clearTimeout(timeoutTimer);
		await kill("SIGTERM");
		log(`smoke harness failed: ${err instanceof Error ? err.message : String(err)}`);
		if (stdout.trim()) log(`stdout tail:\n${stdout.split("\n").slice(-60).join("\n")}`);
		if (stderr.trim()) log(`stderr tail:\n${stderr.split("\n").slice(-60).join("\n")}`);
		process.exit(1);
	}
}

main().catch((err) => {
	process.stderr.write(String(err?.stack ?? err) + "\n");
	process.exit(1);
});
