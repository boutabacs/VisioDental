// Write `modules.json` listing every module layer under <layers-root>.
//
//   node scripts/modules-json.mjs <layers-root> [--prefix <path-prefix>]
//
// Two layouts are supported:
//   <root>/<name>/frontend/nuxt.config.ts   (Python-era module tree)
//   <root>/<name>/nuxt.config.ts            (frontend/layers, post-migration)
//
// The backend regenerates this file at runtime as modules are installed;
// contexts that run without a backend (typecheck:layers, e2e) bake every
// layer instead:
//   typecheck:layers → ./layers
//
// `--prefix` decouples the emitted paths from the scanned directory: a
// caller can scan a directory yet emit an alternate path prefix instead of
// the scanned root (#264 determinism).
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const prefixIdx = args.indexOf("--prefix");
const prefix = prefixIdx === -1 ? null : args[prefixIdx + 1];
const positional = args.filter(
  (_, i) => prefixIdx === -1 || (i !== prefixIdx && i !== prefixIdx + 1),
);
const root = positional[0];
if (!root || (prefixIdx !== -1 && !prefix)) {
  console.error(
    "usage: node scripts/modules-json.mjs <layers-root> [--prefix <path-prefix>]",
  );
  process.exit(1);
}
const base = prefix ?? root;

/** `frontend/` subdirectory of the Python-era layout, else the layer root. */
function layerDirOf(name) {
  if (existsSync(join(root, name, "frontend/nuxt.config.ts"))) {
    return `${name}/frontend`;
  }
  return name;
}

const names = readdirSync(root)
  .filter(
    (name) =>
      existsSync(join(root, name, "frontend/nuxt.config.ts")) ||
      existsSync(join(root, name, "nuxt.config.ts")),
  )
  .sort();
// Fail loudly on zero layers (#544): an empty directory would emit an
// empty modules.json and every layer-enumerating gate would pass
// vacuously. (A file in place of the directory already throws ENOTDIR.)
if (names.length === 0) {
  console.error(
    `modules-json: no layers with nuxt.config.ts under ${root} - refusing to write an empty modules.json`,
  );
  process.exit(1);
}
// Route paths each layer contributes (issue #326): walk pages/ and turn
// files into route patterns ("[id]" → ":param"). The module-gate route
// middleware uses these to 404 pages of baked-but-uninstalled modules.
function routesOf(name) {
  const pagesDir = join(root, layerDirOf(name), "pages");
  if (!existsSync(pagesDir)) return [];
  const routes = [];
  const walk = (dir, segs) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full, [...segs, entry]);
      } else if (entry.endsWith(".vue")) {
        const leaf = entry.slice(0, -4);
        const parts = leaf === "index" ? segs : [...segs, leaf];
        routes.push(
          "/" +
            parts
              .map((p) => p.replace(/\[(\.\.\.)?([^\]]+)\]/g, ":$2"))
              .join("/"),
        );
      }
    }
  };
  walk(pagesDir, []);
  return routes;
}

const modules = names.map((name) => ({
  name,
  path: `${base}/${layerDirOf(name)}`,
  routes: routesOf(name),
}));
writeFileSync(
  "modules.json",
  JSON.stringify(
    { layers: modules.map((m) => m.path), modules, version: 1 },
    null,
    2,
  ) + "\n",
);
console.log("modules.json:", names.join(", "));
