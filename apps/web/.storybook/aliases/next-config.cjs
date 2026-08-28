// Storybook's Next.js preset still requires `next/config`, but in Next 16 the old entrypoint
// isn't present. Provide a lightweight shim that re-exports the new implementation.
//
// Important: keep this CommonJS so `require('next/config')` works.
module.exports = require("next/dist/server/config");
