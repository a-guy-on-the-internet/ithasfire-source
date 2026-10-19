// This package ran vitest with no config (vitest defaults). This file adds only
// the machine-wide gate: `vitest run` queues for a light slot (scripts/dev/gate);
// watch mode takes none. The path is absolute: a relative entry resolves against
// vitest's root (cwd), not this file.
import { fileURLToPath } from "node:url";

export default {
  test: {
    globalSetup: [fileURLToPath(new URL("../../scripts/dev/gate/vitest-global-setup.mjs", import.meta.url))],
  },
};
