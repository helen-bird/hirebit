import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const roots = ["src", "scripts", "web", "cloudflare", "test"];
const extensions = /\.(?:cjs|js|mjs)$/u;

async function sourceFiles(directory) {
  const entries = await readdir(join(root, directory), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (entry.isFile() && extensions.test(entry.name)) files.push(path);
  }
  return files;
}

const files = (await Promise.all(roots.map(sourceFiles))).flat().sort();
if (files.length === 0) throw new Error("No project source files found for syntax checking");

for (const file of files) {
  try {
    execFileSync(process.execPath, ["--check", file], { cwd: root, stdio: "pipe" });
  } catch (error) {
    process.stderr.write(`Syntax check failed: ${file}\n`);
    if (error?.stderr) process.stderr.write(error.stderr);
    process.exitCode = 1;
  }
}

if (process.exitCode !== 1) process.stdout.write(`Syntax check passed for ${files.length} project files.\n`);
