// Copies CesiumJS static runtime assets (Workers, Assets, Widgets, ThirdParty)
// into public/cesium so the app can load them via window.CESIUM_BASE_URL.
// Runs on postinstall and can be run manually: `node scripts/copy-cesium.mjs`.

import { cp, mkdir, access, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const src = join(root, "node_modules", "cesium", "Build", "Cesium");
const dest = join(root, "public", "cesium");

const dirs = ["Workers", "Assets", "Widgets", "ThirdParty"];

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await exists(src))) {
    console.warn(
      "[copy-cesium] Cesium build not found at",
      src,
      "- skipping (is cesium installed?)"
    );
    return;
  }
  await mkdir(dest, { recursive: true });
  for (const d of dirs) {
    const from = join(src, d);
    if (!(await exists(from))) continue;
    await cp(from, join(dest, d), { recursive: true });
  }
  // The prebuilt UMD bundle — loaded via <script> at runtime so Cesium is
  // never processed by the Next/webpack bundler (it is far too large).
  const cesiumJs = join(src, "Cesium.js");
  if (await exists(cesiumJs)) {
    await copyFile(cesiumJs, join(dest, "Cesium.js"));
  }
  console.log("[copy-cesium] Cesium assets copied to public/cesium");
}

main().catch((err) => {
  console.error("[copy-cesium] failed:", err);
  process.exitCode = 1;
});
