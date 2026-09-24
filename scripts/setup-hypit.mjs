import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const hypit = join(root, "vendor", "hypit");
const patches = [
  join(root, "patches", "hypit", "yt-dlp-curl-cffi.patch"),
  join(root, "patches", "hypit", "yt-dlp-download-cap.patch"),
];
const commit = "e9c99ea552a8d5171f4d3605b3084aa39c9849e5";

function run(args, cwd = root, allowFailure = false) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: allowFailure ? "pipe" : "inherit" });
  if (!allowFailure && result.status !== 0) process.exit(result.status ?? 1);
  return result;
}

if (!existsSync(join(hypit, ".git")) && !existsSync(join(hypit, "package.json"))) {
  run(["clone", "https://github.com/hypit-ai/hypit.git", hypit]);
}

run(["checkout", commit], hypit);
for (const patch of patches) {
  const alreadyApplied = run(["apply", "--unidiff-zero", "--reverse", "--check", patch], hypit, true).status === 0;
  if (!alreadyApplied) run(["apply", "--unidiff-zero", "--check", patch], hypit);
  if (!alreadyApplied) run(["apply", "--unidiff-zero", patch], hypit);
}

console.log(`Hypit is pinned to ${commit} and the downloader patches are applied.`);
console.log("Install its dependencies with: (cd vendor/hypit && corepack pnpm install --frozen-lockfile)");
