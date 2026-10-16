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
});
