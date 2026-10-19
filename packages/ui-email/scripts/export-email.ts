#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { listTemplates, render, sampleInputFor } from "../src";
import type { TemplateId } from "../src";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, "..");
const defaultOutputRoot = resolve(packageRoot, "tmp/email-previews");

const args = process.argv.slice(2);

const usage = () => {
  const templateList = listTemplates()
    .map((template) => `  - ${template.id}`)
    .join("\n");
  return `Usage: pnpm -F @th/ui-email email:export <template-id> [--dir=<path>] [--no-open]\n\nAvailable template IDs:\n${templateList}`;
};

const parseArgs = () => {
  let templateId: TemplateId | undefined;
  let outputDir = defaultOutputRoot;
  let shouldOpen = true;

  for (const arg of args) {
    if (arg === "--no-open") {
      shouldOpen = false;
      continue;
    }

    if (arg.startsWith("--dir=")) {
      const [, dir] = arg.split("=", 2);
      if (dir) {
        outputDir = resolve(process.cwd(), dir);
      }
      continue;
    }

    if (!templateId) {
      templateId = arg as TemplateId;
      continue;
    }

    throw new Error(`Unexpected argument '${arg}'.\n\n${usage()}`);
  }

  if (!templateId) {
    throw new Error(`Missing template ID.\n\n${usage()}`);
  }

  if (!listTemplates().some((template) => template.id === templateId)) {
    throw new Error(`Unknown template '${templateId}'.\n\n${usage()}`);
  }

  return { templateId, outputDir, shouldOpen };
};

const toIsoSlug = (date: Date) =>
  date.toISOString().replace(/[:.]/g, "-").replace(/Z$/, "z");

const buildEml = (subject: string, html: string, text: string) => {
  const boundary = `TH-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return [
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary=\"${boundary}\"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: quoted-printable",
    "",
    text,
    "",
    `--${boundary}`,
    'Content-Type: text/html; charset="utf-8"',
    "Content-Transfer-Encoding: quoted-printable",
    "",
    html,
    "",
    `--${boundary}--`,
    "",
  ]
    .map((line) => line.replace(/\r?\n/g, "\r\n"))
    .join("\r\n");
};

async function main() {
  const { templateId, outputDir, shouldOpen } = parseArgs();
  const summary = listTemplates().find(
    (template) => template.id === templateId,
  );
  if (!summary) {
    throw new Error(`Template '${templateId}' is not registered.`);
  }

  const props = sampleInputFor(templateId);
  const { subject, html, text } = await render({ templateId, props });

  const timestamp = toIsoSlug(new Date());
  const templateSlug = templateId.replace(/[^a-z0-9]+/gi, "-");
  const previewDir = resolve(outputDir, `${templateSlug}-${timestamp}`);

  await mkdir(previewDir, { recursive: true });

  const files = {
    html: join(previewDir, "email.html"),
    text: join(previewDir, "email.txt"),
    eml: join(previewDir, "email.eml"),
    props: join(previewDir, "props.json"),
    meta: join(previewDir, "meta.json"),
  };

  await writeFile(
    files.html,
    `<!doctype html>\n${html.startsWith("<!doctype") ? html.split("\n").slice(1).join("\n") : html}`,
    "utf8",
  );
  await writeFile(files.text, `${text}\n`, "utf8");
  await writeFile(files.props, `${JSON.stringify(props, null, 2)}\n`, "utf8");
  await writeFile(
    files.meta,
    `${JSON.stringify(
      {
        templateId,
        subject,
        requiredProps: summary.requiredProps,
        hasTextTemplate: summary.hasTextTemplate,
        timestamp,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(files.eml, buildEml(subject, html, text), "utf8");

  process.stdout.write(`✔︎ Email preview written to ${previewDir}\n`);

  if (shouldOpen) {
    openInClient(files.eml).catch((error) => {
      process.stderr.write(
        `⚠️  Failed to open email client automatically: ${
          error instanceof Error ? error.message : String(error)
        }.\n`,
      );
    });
  }
}

const openInClient = async (filePath: string) => {
  const rejectOpenError = (
    rejectPromise: (reason?: unknown) => void,
    error: unknown,
  ) => {
    rejectPromise(error instanceof Error ? error : new Error(String(error)));
  };

  const currentPlatform = platform();
  if (currentPlatform === "darwin") {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      execFile("open", [filePath], (error) => {
        if (error) {
          rejectOpenError(rejectPromise, error);
          return;
        }
        resolvePromise();
      });
    });
    process.stdout.write(
      `Opened ${basename(filePath)} in the default mail client.\n`,
    );
    return;
  }

  if (currentPlatform === "win32") {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      execFile("cmd", ["/c", "start", "", filePath], (error) => {
        if (error) {
          rejectOpenError(rejectPromise, error);
          return;
        }
        resolvePromise();
      });
    });
    process.stdout.write("Opened email preview via start command.\n");
    return;
  }

  if (currentPlatform === "linux") {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      execFile("xdg-open", [filePath], (error) => {
        if (error) {
          rejectOpenError(rejectPromise, error);
          return;
        }
        resolvePromise();
      });
    });
    process.stdout.write("Opened email preview via xdg-open.\n");
    return;
  }

  throw new Error(
    `Automatic opening is not supported on platform '${currentPlatform}'.`,
  );
};

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
