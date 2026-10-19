import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import { expect, test } from "@playwright/test";

type StorybookServer = {
  url: string;
  close: () => Promise<void>;
  stdout: () => string;
  stderr: () => string;
};

const HOST = process.env.STORYBOOK_HOST ?? "127.0.0.1";
const PORT = Number(process.env.STORYBOOK_PORT ?? 6006);
const TIMEOUT_MS = Number(process.env.STORYBOOK_SMOKE_TIMEOUT_MS ?? 60_000);

const URL = `http://${HOST}:${PORT}`;

async function waitForHttpOk(url: string, timeoutMs: number) {
  const start = Date.now();
  let lastErr: unknown;
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

async function startStorybook(): Promise<StorybookServer> {
  const child = spawn(
    "pnpm",
    ["storybook", "--", "-p", String(PORT), "--host", HOST, "--quiet"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        BROWSER: "none",
      },
    },
  );

  let out = "";
  let err = "";
  child.stdout.on("data", (d) => {
    out += String(d);
  });
  child.stderr.on("data", (d) => {
    err += String(d);
  });

  await waitForHttpOk(`${URL}/iframe.html`, TIMEOUT_MS);
  await waitForHttpOk(`${URL}/index.html`, TIMEOUT_MS);

  return {
    url: URL,
    stdout: () => out,
    stderr: () => err,
    close: async () => {
      if (child.killed) return;
      child.kill("SIGTERM");
      await delay(1500);
      if (!child.killed) child.kill("SIGKILL");
    },
  };
}

test.describe("storybook smoke", () => {
  test("loads manager + iframe without console/page errors", async ({
    page,
  }, testInfo) => {
    const server = await startStorybook();
    testInfo.attach("storybook-url", {
      body: server.url,
      contentType: "text/plain",
    });

    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });

    const pageErrors: string[] = [];
    page.on("pageerror", (err) => {
      pageErrors.push(err.message);
    });

    try {
      // Manager
      await page.goto(`${server.url}/index.html`, {
        waitUntil: "domcontentloaded",
      });
      await expect(page).toHaveTitle(/storybook/i);

      // Iframe (where most runtime module errors happen)
      await page.goto(`${server.url}/iframe.html`, {
        waitUntil: "domcontentloaded",
      });
      // Preview takes a moment to boot; the root can remain hidden until a story is selected.
      await page.waitForFunction(
        () => {
          const root = document.getElementById("storybook-root");
          return Boolean(root);
        },
        undefined,
        { timeout: 30_000 },
      );
      // Ensure Storybook's preview runtime loaded.
      await page.waitForFunction(
        () =>
          Boolean(
            (window as any).__STORYBOOK_PREVIEW__ ||
            (window as any).__STORYBOOK_ADDONS__,
          ),
        undefined,
        { timeout: 30_000 },
      );
    } finally {
      await server.close();
    }

    const filteredConsole = consoleErrors.filter(
      (msg) =>
        // Ignore common noisy warnings that don't indicate a broken preview.
        !/\buse client\b/i.test(msg) &&
        !/ResizeObserver loop limit exceeded/i.test(msg),
    );

    // Attach logs if we fail.
    if (filteredConsole.length || pageErrors.length) {
      testInfo.attach("storybook-stdout", {
        body: server.stdout().slice(-20_000),
        contentType: "text/plain",
      });
      testInfo.attach("storybook-stderr", {
        body: server.stderr().slice(-20_000),
        contentType: "text/plain",
      });
    }

    expect(pageErrors, `pageerror events:\n${pageErrors.join("\n")}`).toEqual(
      [],
    );
    expect(
      filteredConsole,
      `console.error messages:\n${filteredConsole.join("\n")}`,
    ).toEqual([]);
  });
});
