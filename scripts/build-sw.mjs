// Generates public/sw.js after `next build`: precache list = static app pages + every file in
// .next/static (content-hashed) + icons/manifest. The SW version is the Next.js BUILD_ID.
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

const buildId = readFileSync(".next/BUILD_ID", "utf8").trim();

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const staticFiles = walk(".next/static")
  .filter((f) => !f.endsWith(".map"))
  .map((f) => "/_next/static/" + relative(".next/static", f).split(sep).join("/"));

const PAGES = [
  "/app",
  "/app/transactions",
  "/app/accounts",
  "/app/accounts/view",
  "/app/budgets",
  "/app/budgets/view",
  "/app/more",
  "/app/allocations",
  "/app/categories",
  "/app/templates",
  "/app/sync",
  "/app/security",
  "/app/export",
  "/app/settings",
  "/login",
  "/change-password",
];

const extra = ["/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/maskable-512.png", "/icons/apple-touch-icon.png"].filter(
  (u) => existsSync(join("public", u)),
);

const sw = readFileSync("scripts/sw-template.js", "utf8")
  .replace("__VERSION__", buildId)
  .replace("__PAGES__", JSON.stringify(PAGES))
  .replace("__ASSETS__", JSON.stringify([...staticFiles, ...extra]));
writeFileSync("public/sw.js", sw);
console.log(`Service worker written: version ${buildId}, ${PAGES.length} pages, ${staticFiles.length + extra.length} assets.`);
