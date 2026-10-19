import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const entry = path.resolve(
    __dirname,
    "../../src/use-cases/events/__tests__/get-random-event.test.ts",
  );

  console.log("Analyzing bundle for", entry);

  const result = await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    metafile: true,
    write: false,
    logLevel: "silent",
    define: {
      "import.meta.vitest": "undefined",
      "process.env.NODE_ENV": '"test"',
    },
    external: ["vitest", "node:crypto"],
    tsconfig: path.resolve(__dirname, "../../tsconfig.json"),
  });

  const { metafile } = result;
  if (!metafile) {
    console.error("No metafile generated");
    process.exit(1);
  }

  const outputs = Object.values(metafile.outputs);
  if (outputs.length === 0) {
    console.error("No outputs in metafile");
    process.exit(1);
  }

  const [output] = outputs;
  const entries = Object.entries(output.inputs).map(([file, info]) => {
    const typed = info as unknown as { bytes?: number; bytesInOutput?: number };
    const bytes = typed.bytes ?? typed.bytesInOutput ?? 0;
    return { file, bytes };
  });
  entries.sort((a, b) => b.bytes - a.bytes);

  const top = entries.slice(0, 20);
  const total = entries.reduce((acc, item) => acc + item.bytes, 0);

  console.log(`Total bundled input size: ${(total / 1024).toFixed(2)} KiB`);
  console.log("Top contributors:");
  for (const item of top) {
    console.log(`  ${(item.bytes / 1024).toFixed(2)} KiB - ${item.file}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
