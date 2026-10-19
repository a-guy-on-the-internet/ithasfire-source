import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const PORT = Number(process.env.STORYBOOK_PORT ?? 6006);
const HOST = process.env.STORYBOOK_HOST ?? "127.0.0.1";
const TIMEOUT_MS = Number(process.env.STORYBOOK_SMOKE_TIMEOUT_MS ?? 60_000);

const BASE_URL = `http://${HOST}:${PORT}`;

const abortController = new AbortController();

function log(message) {
	process.stdout.write(`[storybook-smoke] ${message}\n`);
}

async function fetchOk(url) {
	// Node 18+ has global fetch.
	const res = await fetch(url, { signal: abortController.signal });
	return { ok: res.ok, status: res.status, text: await res.text() };
}

async function waitForHttp(url, timeoutMs) {
	const start = Date.now();
	let lastError;
	while (Date.now() - start < timeoutMs) {
		try {
			const res = await fetchOk(url);
			if (res.ok) return res;
			lastError = new Error(`HTTP ${res.status} for ${url}`);
		} catch (err) {
			lastError = err;
		}
		await delay(500);
	}
	throw lastError ?? new Error(`Timed out waiting for ${url}`);
}

async function main() {
	log(`starting Storybook dev server on ${BASE_URL}`);

	// Use pnpm script so it stays consistent with repo workflows.
	const child = spawn(
		"pnpm",
		["storybook", "--", "-p", String(PORT), "--host", HOST, "--quiet"],
		{
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				// Keep noise down in CI and avoid opening browsers.
				BROWSER: "none",
			},
		},
	);

	let stderr = "";
	let stdout = "";
	child.stdout.on("data", (d) => {
		stdout += String(d);
	});
	child.stderr.on("data", (d) => {
		stderr += String(d);
	});

	const kill = async (signal = "SIGTERM") => {
		if (child.killed) return;
		child.kill(signal);
		// Give it a moment to exit cleanly.
		await delay(1500);
		if (!child.killed) child.kill("SIGKILL");
	};

	const onSignal = async () => {
		abortController.abort();
		await kill("SIGTERM");
		process.exit(130);
	};

	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);

	const timeoutTimer = setTimeout(async () => {
		abortController.abort();
		await kill("SIGTERM");
		log(`timed out after ${TIMEOUT_MS}ms`);
		if (stdout.trim()) log(`stdout tail:\n${stdout.split("\n").slice(-40).join("\n")}`);
		if (stderr.trim()) log(`stderr tail:\n${stderr.split("\n").slice(-40).join("\n")}`);
		process.exit(1);
	}, TIMEOUT_MS);

	try {
		// Wait for endpoints that should exist in dev mode.
		await waitForHttp(`${BASE_URL}/iframe.html`, TIMEOUT_MS);
		await waitForHttp(`${BASE_URL}/index.html`, TIMEOUT_MS);
		log("iframe + manager responded ✅");
		clearTimeout(timeoutTimer);
		await kill("SIGTERM");
		process.exit(0);
	} catch (err) {
		clearTimeout(timeoutTimer);
		abortController.abort();
		await kill("SIGTERM");
		log(`smoke check failed: ${err instanceof Error ? err.message : String(err)}`);
		if (stdout.trim()) log(`stdout tail:\n${stdout.split("\n").slice(-60).join("\n")}`);
		if (stderr.trim()) log(`stderr tail:\n${stderr.split("\n").slice(-60).join("\n")}`);
		process.exit(1);
	}
}

main().catch((err) => {
	process.stderr.write(String(err?.stack ?? err) + "\n");
	process.exit(1);
});
