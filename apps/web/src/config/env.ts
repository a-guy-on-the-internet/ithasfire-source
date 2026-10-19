// ---------------------------------------------------------------------------
// Barrel re-export for backward compatibility.
//
// ⚠️  CLIENT components should import from "@/config/env.public" directly to
//     avoid pulling server-only Zod/envInputs code into the browser bundle.
//     Importing from this file is fine for SERVER code.
//
// The split exists because Turbopack bundles entire modules: if a client file
// imports `publicRuntimeEnv` from a module that also exports `webEnv` (which
// depends on envInputs/Zod), the entire envInputs object — with its
// non-inlined process.env references — ends up in the client bundle.
// ---------------------------------------------------------------------------

export { publicRuntimeEnv, requireEnv } from "./env.public";
export { webEnv, serverRuntimeEnv } from "./env.server";
