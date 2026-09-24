import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const checker = fileURLToPath(new URL("../scripts/check-repository.mjs", import.meta.url));

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "hirebit-repo-check-"));
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  git("init", "--quiet");
  return { cwd, git, check: () => spawnSync(process.execPath, [checker], { cwd, encoding: "utf8" }) };
}

test("repository check inspects staged bytes even when the working file was cleaned", async () => {
  const { cwd, git, check } = await fixture();
  await writeFile(join(cwd, "leak.txt"), "sk-" + "x".repeat(32));
  git("add", "leak.txt");
  await writeFile(join(cwd, "leak.txt"), "safe working copy");
  const result = check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /leak.txt: possible provider API key/);
  assert.ok(!result.stderr.includes("x".repeat(32)));
});

test("repository check also inspects unstaged edits and untracked files", async () => {
  const { cwd, git, check } = await fixture();
  await writeFile(join(cwd, "tracked.txt"), "clean staged content");
  git("add", "tracked.txt");
  await writeFile(join(cwd, "tracked.txt"), "sk-" + "u".repeat(32));
  await writeFile(join(cwd, "new.txt"), "sk-" + "v".repeat(32));
  const result = check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /tracked\.txt: possible provider API key in working tree/);
  assert.match(result.stderr, /new\.txt: possible provider API key in working tree/);
  assert.ok(!result.stderr.includes("u".repeat(32)));
  assert.ok(!result.stderr.includes("v".repeat(32)));
});

test("repository check respects Git exclusions for local runtime files", async () => {
  const { cwd, git, check } = await fixture();
  await writeFile(join(cwd, ".gitignore"), ".env\n.local-ops/\n");
  git("add", ".gitignore");
  await writeFile(join(cwd, ".env"), "PUBLIC_DEMO_ACCESS_TOKEN=local-private-value\n");
  await mkdir(join(cwd, ".local-ops"));
  await writeFile(join(cwd, ".local-ops", "credentials.txt"), "sk-" + "w".repeat(32));
  const result = check();
  assert.equal(result.status, 0, result.stderr);
});

test("repository check catches local tokens embedded in large binary assets", async () => {
  const { cwd, git, check } = await fixture();
  const token = "test-local-" + "z".repeat(32);
  await writeFile(join(cwd, ".env"), `PUBLIC_DEMO_ACCESS_TOKEN=${token}\n`);
  await writeFile(join(cwd, "image.bin"), Buffer.concat([Buffer.alloc(2_100_000), Buffer.from(token)]));
  git("add", "image.bin");
  const result = check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /locally configured credential/);
  assert.ok(!result.stderr.includes(token));
});

test("repository check accepts placeholder examples but rejects staged private config", async () => {
  const { cwd, git, check } = await fixture();
  await writeFile(join(cwd, ".env.example"), "PUBLIC_DEMO_ACCESS_TOKEN=\n");
  git("add", ".env.example");
  assert.equal(check().status, 0);
  await writeFile(join(cwd, ".env"), "PUBLIC_DEMO_ACCESS_TOKEN=\n");
  git("add", ".env");
  assert.equal(check().status, 1);
});

test("repository check rejects versioned presentation and output directories", async () => {
  const { cwd, git, check } = await fixture();
  for (const directory of [".deck-build-v3", ".deck-inspect-current", "output-v3"]) {
    await mkdir(join(cwd, directory));
    await writeFile(join(cwd, directory, "artifact.txt"), "generated output");
    git("add", `${directory}/artifact.txt`);
  }
  const result = check();
  assert.equal(result.status, 1);
  for (const directory of [".deck-build-v3", ".deck-inspect-current", "output-v3"]) {
    assert.match(result.stderr, new RegExp(directory.replaceAll(".", "\\.")));
  }
});
