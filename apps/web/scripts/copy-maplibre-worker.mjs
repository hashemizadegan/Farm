// Copies MapLibre's worker script into public/ so the browser can load it from
// the app's own origin (CSP worker-src 'self'). See BoundaryMap.tsx.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pkgDir = dirname(require.resolve("maplibre-gl/package.json"));
const publicDir = join(here, "..", "public");
mkdirSync(publicDir, { recursive: true });
copyFileSync(join(pkgDir, "dist", "maplibre-gl-worker.mjs"), join(publicDir, "maplibre-gl-worker.mjs"));
console.log("copied maplibre-gl-worker.mjs to public/");
