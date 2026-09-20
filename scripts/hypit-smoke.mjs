import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

import { HypitAdapter } from "../src/hypit-adapter.mjs";

const rootDir = resolve(import.meta.dirname, "..");
const dataDir = resolve(rootDir, process.env.SELLER_DATA_DIR ?? ".seller");
const hypitRoot = resolve(rootDir, "vendor/hypit");
const projectDir = resolve(hypitRoot, "examples/semantic-composition");
const runtimeFile = resolve(dataDir, "hypit-smoke.runtime.json");
const workflowFile = resolve(dataDir, "hypit-smoke-workflows.json");
const hypitBin = resolve(hypitRoot, "hypit");

async function installedChrome() {
  const root = resolve(homedir(), ".cache/hyperframes/chrome");
  const entries = await readdir(root, { recursive: true });
  for (const entry of entries) {
    if (!entry.endsWith("chrome-headless-shell")) continue;
    const candidate = resolve(root, entry);
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Keep looking for another prepared version.
    }
  }
  throw new Error("Hypit smoke requires a prepared HyperFrames Chrome Headless Shell");
}

const chromePath = await installedChrome();

async function run(program, args, cwd = rootDir) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, { cwd, stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("close", (code) => code === 0
      ? resolvePromise()
      : reject(new Error(`${program} exited with code ${code}`)));
  });
}

if (typeof ffmpegPath !== "string" || typeof ffprobeStatic?.path !== "string") {
  throw new Error("Local FFmpeg/FFprobe paths are unavailable");
}

await mkdir(dataDir, { recursive: true, mode: 0o700 });
await chmod(dataDir, 0o700);
await run(process.execPath, [resolve(hypitRoot, "scripts/build-public-types.mjs")]);
await run(resolve(hypitRoot, "node_modules/.bin/tsc"), [
  "-p",
  resolve(projectDir, "packages/chat-scene/tsconfig.json"),
]);

await writeFile(runtimeFile, `${JSON.stringify({
  format: "hypit.runtime-local@1",
  dataRoot: "hypit-smoke-runtime",
  endpoints: {
    "media.local": {
      use: "@hypit/provider-media-local",
      config: { defaultConcurrency: 2, ffmpegPath, ffprobePath: ffprobeStatic.path },
    },
    "hyperframes.local": {
      use: "@hypit/provider-hyperframes-local",
      config: { workers: 2, defaultConcurrency: 1, ffmpegPath, ffprobePath: ffprobeStatic.path, chromePath },
    },
  },
}, null, 2)}\n`, { mode: 0o600 });

await writeFile(workflowFile, `${JSON.stringify({
  smoke_chat: {
    testOnly: true,
    readyForSale: true,
    maxProviderCostSats: 0,
    providerTermsConfirmedAt: "2026-09-18T00:00:00Z",
    projectDir: "vendor/hypit/examples/semantic-composition",
    run: "chat.svrun",
    runtime: runtimeFile,
    runtimeDataDir: "hypit-smoke-runtime",
    deliverables: [{ output: "final.video", filename: "final.mp4", mediaType: "video/mp4" }],
  },
}, null, 2)}\n`, { mode: 0o600 });

await run(hypitBin, [
  "runtime",
  "up",
  "--workspace",
  projectDir,
  "--runtime",
  runtimeFile,
]);

const adapter = new HypitAdapter({ rootDir, dataDir, workflowFile, hypitBin, isolationVerified: true });
const orderId = `smoke-${Date.now()}`;
const result = await adapter.execute({
  order: {
    id: orderId,
    state: "paid",
    payment: { authorization: "authorized", settlement: "pending" },
  },
  quote: {
    product: { id: "smoke_chat", name: "Local Hypit smoke video" },
    amountSats: 0,
    productionMode: "original",
    addOns: { hookVariants: 1, languages: ["en"], aspectRatios: ["9:16"] },
    brief: { purpose: "Validate Seller-to-Hypit execution without hosted model charges" },
  },
});

console.log(JSON.stringify({ orderId, ...result }, null, 2));
