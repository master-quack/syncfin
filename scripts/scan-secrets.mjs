// Fails if any secret from .env appears in client-visible build output. Never prints secret values.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const dirs = process.argv.slice(2);
if (dirs.length === 0) dirs.push(".next/static", "public");

const env = Object.fromEntries(
  readFileSync(".env", "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const SECRET_KEYS = ["PARTY_PASSCODE", "SESSION_SECRET", "INTERNAL_SECRET", "JELLYFIN_TOKEN"];
const secrets = SECRET_KEYS.filter((k) => (env[k] ?? "").length >= 8).map((k) => [k, env[k]]);
const unset = SECRET_KEYS.filter((k) => (env[k] ?? "").length < 8);

const walk = (d) => {
  try {
    return readdirSync(d).flatMap((f) => {
      const p = join(d, f);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  } catch {
    return [];
  }
};

let files = 0;
const hits = [];
for (const dir of dirs) {
  for (const f of walk(dir)) {
    files++;
    const body = readFileSync(f, "latin1");
    for (const [key, value] of secrets) if (body.includes(value)) hits.push(`${key} found in ${f}`);
    if (/X-Emby-Token|api_key=/i.test(body)) hits.push(`Jellyfin credential plumbing found in ${f}`);
  }
}
console.log(`scanned ${files} files in ${dirs.join(", ")} for ${secrets.map(([k]) => k).join(", ")}`);
if (unset.length) console.log(`(not set, so not scannable: ${unset.join(", ")})`);
if (hits.length) {
  console.error(hits.join("\n"));
  process.exit(1);
}
console.log("clean");
