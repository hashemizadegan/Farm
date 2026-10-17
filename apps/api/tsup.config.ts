import { defineConfig } from "tsup";

// Workspace packages export TypeScript source, so they are bundled in.
// Third-party dependencies stay external and are installed in the image.
export default defineConfig({
  entry: { main: "src/main.ts", migrate: "../../packages/db/src/scripts/migrate.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  sourcemap: true,
  clean: true,
  noExternal: [/^@metafarm\//],
  // Workspace packages are bundled, and so are their CommonJS dependencies (e.g. pg).
  // ESM output has no `require`, so provide one for those bundled modules.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
});
