import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

import ffmpegStatic from "ffmpeg-static";

import { assertReferenceDownloadHeadroom, downloadSocialReferenceVideo, HypitAdapter, pruneReferenceVideoCache } from "../src/hypit-adapter.mjs";
import { AppError } from "../src/errors.mjs";
import { ProductionInputPreparer } from "../src/production-input-preparer.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);

test("Apple Silicon Hypit defaults to a runnable native ffprobe", {
  skip: process.platform !== "darwin" || process.arch !== "arm64",
}, async () => {
  const adapter = new HypitAdapter({ rootDir, dataDir: join(rootDir, ".seller"), workflowFile: "workflows/unused.json", hypitBin: "hypit" });
  const { stdout } = await execFileAsync(join(adapter.mediaBinDir, "ffprobe"), ["-version"]);
  assert.match(stdout, /^ffprobe version/u);
});

test("reference-video cache evicts only old cached media before reaching its total cap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hypit-cache-budget-"));
  const old = `${"a".repeat(64)}.mp4`;
  const recent = `${"b".repeat(64)}.mp4`;
  for (const name of [old, recent, "manifest.json"]) await writeFile(join(directory, name), "123456");
  const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  await utimes(join(directory, old), oldDate, oldDate);
  assert.equal(await pruneReferenceVideoCache(directory, { incomingBytes: 4, maxBytes: 12 }), 10);
  assert.deepEqual((await readdir(directory)).sort(), [recent, "manifest.json"].sort());
});

test("pre-Build retry evidence fails closed when a submission marker exists", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hypit-prebuild-proof-"));
  const dataDir = join(directory, "seller-data");
  const jobDir = join(dataDir, "jobs", "ord_proof");
  await mkdir(jobDir, { recursive: true });
  const adapter = new HypitAdapter({ rootDir, dataDir, workflowFile: "workflows/unused.json", hypitBin: "hypit" });
  const order = { id: "ord_proof", amountSats: 1600 };
  const quote = { id: "qte_proof" };
  assert.equal(await adapter.canRetryBeforeBuild({ order, quote }), false);
  await writeFile(join(jobDir, "commission.json"), JSON.stringify({ order, quote }));
  assert.equal(await adapter.canRetryBeforeBuild({ order, quote }), true);
  await writeFile(join(jobDir, "build.attempt.json"), "uncertain");
  assert.equal(await adapter.canRetryBeforeBuild({ order, quote }), false);
});

test("reference download stops before disk exhaustion instead of filling the website host", async () => {
  await assert.rejects(assertReferenceDownloadHeadroom("/unused", 1_000_000_000,
    async () => ({ bavail: 4, bsize: 1_000_000_000 })),
  (error) => error.code === "reference_video_disk_full" && error.status === 507);
  await assertReferenceDownloadHeadroom("/unused", 1_000_000_000,
    async () => ({ bavail: 5, bsize: 1_000_000_000 }));
});

test("Hypit social reference fetch localizes a platform page as an order-private video", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hypit-social-reference-"));
  const stateHome = join(directory, "state");
  let commandCalls = 0;
  const result = await downloadSocialReferenceVideo(
    "https://www.tiktok.com/@creator/video/7461234567890123456",
    {
      directory: join(directory, "inputs"),
      stateHome,
      hypitBin: "/fake/hypit",
      commandRunner: async (program, args, options) => {
        commandCalls += 1;
        assert.equal(program, "/fake/hypit");
        if (args[1] === "prepare-fetch") return { stdout: JSON.stringify({ ready: true }), stderr: "" };
        assert.equal(options.env.HYPIT_FETCH_MAX_BYTES, "1000000000");
        assert.deepEqual(args.slice(0, 3), ["media", "fetch", "https://www.tiktok.com/@creator/video/7461234567890123456"]);
        const destination = args[args.indexOf("--to") + 1];
        await writeFile(destination, "fake-reference-video");
        return { stdout: JSON.stringify({ path: destination }), stderr: "" };
      },
    },
  );
  assert.equal(result.mediaType, "video/mp4");
  assert.equal(result.sourcePlatform, "TikTok");
  assert.equal(result.fetchedBy, "hypit-media-fetch");
  assert.match(result.sha256, /^[a-f0-9]{64}$/u);
  const cached = await downloadSocialReferenceVideo(
    "https://www.tiktok.com/@creator/video/7461234567890123456",
    {
      directory: join(directory, "second-order-inputs"),
      stateHome,
      hypitBin: "/fake/hypit",
      commandRunner: async () => { throw new Error("Cache hit must not access the network"); },
    },
  );
  assert.equal(cached.fetchedBy, "hypit-reference-cache");
  assert.equal(cached.sha256, result.sha256);
  assert.equal(commandCalls, 2);
});

test("Hypit reference fetch rejects non-TikTok pages before any command", async () => {
  for (const url of [
    "https://www.instagram.com/reel/DFa1b2C3d4E/",
    "https://www.youtube.com/shorts/dQw4w9WgXcQ",
  ]) {
    await assert.rejects(downloadSocialReferenceVideo(url, {
      directory: join(tmpdir(), "hypit-unsupported-reference"),
      commandRunner: async () => { throw new Error("Downloader must not start"); },
    }), (error) => error.code === "reference_video_url_unsupported");
  }
});

test("social reference rejects oversized fetches and removes the incomplete order file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hypit-social-reference-limit-"));
  const inputs = join(directory, "inputs");
  await assert.rejects(
    downloadSocialReferenceVideo("https://www.tiktok.com/@creator/video/7461234567890123456", {
      directory: inputs,
      stateHome: join(directory, "state"),
      hypitBin: "/fake/hypit",
      maxBytes: 8,
      commandRunner: async (_program, args, options) => {
        if (args[1] === "prepare-fetch") return { stdout: "{}", stderr: "" };
        assert.equal(options.env.HYPIT_FETCH_MAX_BYTES, "8");
        await writeFile(args[args.indexOf("--to") + 1], "123456789");
        return { stdout: "{}", stderr: "" };
      },
    }),
    (error) => error.code === "external_resource_too_large",
  );
  await assert.rejects(readFile(join(inputs, "evidence.mp4")), (error) => error.code === "ENOENT");
});

test("in-flight Hypit size rejection remains a clear 413 instead of a source outage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hypit-social-reference-stream-limit-"));
  await assert.rejects(downloadSocialReferenceVideo("https://www.tiktok.com/@creator/video/7461234567890123456", {
    directory: join(directory, "inputs"),
    stateHome: join(directory, "state"),
    hypitBin: "/fake/hypit",
    maxBytes: 8,
    commandRunner: async (_program, args) => {
      if (args[1] === "prepare-fetch") return { stdout: "{}", stderr: "" };
      throw new AppError("hypit_command_failed", "Hypit exited with code 1", 502, {
        stdout: JSON.stringify({ format: "hypit.cli-error@1", ok: false, error: { code: "REFERENCE_VIDEO_TOO_LARGE" } }),
      });
    },
  }), (error) => error.code === "external_resource_too_large" && error.status === 413);
});

test("Hypit social reference fetch reports source unavailability instead of a generic command failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hypit-social-reference-timeout-"));
  await assert.rejects(
    downloadSocialReferenceVideo("https://www.tiktok.com/@creator/video/6798977602963918085", {
      directory: join(directory, "inputs"),
      stateHome: join(directory, "state"),
      hypitBin: "/fake/hypit",
      commandRunner: async () => {
        throw new AppError("hypit_command_failed", "Hypit exited with code 1", 502);
      },
    }),
    (error) => error.code === "reference_video_fetch_failed"
      && error.message.includes("retry the same paid order"),
  );
});

test("reference-video fetch failure stops Seller production instead of degrading to link-only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hypit-reference-fail-closed-"));
  const workflow = JSON.parse(await readFile(join(rootDir, "config/hypit-workflows.json"), "utf8")).proof_demo;
  const workflowFile = join(directory, "workflows.json");
  await writeFile(workflowFile, JSON.stringify({ proof_demo: workflow }));
  const uploadDirectory = join(directory, "uploads");
  const uploadFilename = `${"b".repeat(48)}.jpg`;
  await mkdir(uploadDirectory, { recursive: true });
  await copyFile(join(rootDir, "productions/shared-assets/arduino-uno-r4-wifi/product.jpg"), join(uploadDirectory, uploadFilename));
  let buildCalled = false;
  const adapter = new HypitAdapter({
    rootDir,
    dataDir: join(directory, "seller-data"),
    workflowFile,
    hypitBin: join(rootDir, "vendor/hypit/hypit"),
    isolationVerified: true,
    commandRunner: async () => { buildCalled = true; throw new Error("Build must not start"); },
    inputPreparer: { voiceProvider: { provider: "google-cloud-tts", commercialUseApproved: true } },
    referenceVisionProvider: { async readiness() { return { configured: true }; } },
    trustedUploadOrigin: "https://buyer.example",
    trustedUploadDirectory: uploadDirectory,
    referenceVideoFetcher: async () => {
      throw new AppError("reference_video_fetch_failed", "Reference video could not be fetched", 502);
    },
  });
  await assert.rejects(adapter.start({
    order: { id: "ord_reference_fail_closed", amountSats: 1300 },
    quote: {
      product: { id: "proof_demo", name: "Proof Demo", durationSeconds: [20, 45], objectives: ["conversion"] },
      brief: {
        productName: "Test product",
        referenceUrl: `https://buyer.example/v1/uploads/${uploadFilename}`,
        evidenceUrl: "https://www.tiktok.com/@creator/video/6798977602963918085",
      },
      addOns: { hookVariants: 1, languages: ["en-US"], aspectRatios: ["9:16"] },
    },
  }), (error) => error.code === "reference_video_fetch_failed");
  assert.equal(buildCalled, false);
});

test("non-video reference evidence cannot silently fall back to image-only production", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hypit-reference-type-"));
  const workflow = JSON.parse(await readFile(join(rootDir, "config/hypit-workflows.json"), "utf8")).proof_demo;
  const workflowFile = join(directory, "workflows.json");
  await writeFile(workflowFile, JSON.stringify({ proof_demo: workflow }));
  const uploadDirectory = join(directory, "uploads");
  const uploadFilename = `${"e".repeat(48)}.jpg`;
  await mkdir(uploadDirectory, { recursive: true });
  await copyFile(join(rootDir, "product_pic.jpeg"), join(uploadDirectory, uploadFilename));
  const adapter = new HypitAdapter({
    rootDir, dataDir: join(directory, "seller-data"), workflowFile,
    hypitBin: join(rootDir, "vendor/hypit/hypit"), isolationVerified: true,
    commandRunner: async () => { throw new Error("Build must not start"); },
    inputPreparer: { voiceProvider: { provider: "google-cloud-tts", commercialUseApproved: true } },
    trustedUploadOrigin: "https://buyer.example", trustedUploadDirectory: uploadDirectory,
    referenceVideoFetcher: async () => ({ mediaType: "application/octet-stream" }),
  });
  await assert.rejects(adapter.start({
    order: { id: "ord_reference_type", amountSats: 1300 },
    quote: {
      product: { id: "proof_demo", name: "Proof Demo", durationSeconds: [20, 45] },
      brief: {
        referenceUrl: `https://buyer.example/v1/uploads/${uploadFilename}`,
        evidenceUrl: "https://www.tiktok.com/@creator/video/6798977602963918085",
      },
      addOns: { hookVariants: 1, languages: ["en-US"], aspectRatios: ["9:16"] },
    },
  }), (error) => error.code === "reference_video_required");
});

test("reference-video production passes the analyzed choreography to Veo instead of using image-only motion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hypit-reference-veo-"));
  const workflow = JSON.parse(await readFile(join(rootDir, "config/hypit-workflows.json"), "utf8")).proof_demo;
  const workflowFile = join(directory, "workflows.json");
  await writeFile(workflowFile, JSON.stringify({ proof_demo: workflow }));
  const uploadDirectory = join(directory, "uploads");
  const uploadFilename = `${"c".repeat(48)}.jpg`;
  await mkdir(uploadDirectory, { recursive: true });
  await copyFile(join(rootDir, "product_pic.jpeg"), join(uploadDirectory, uploadFilename));
  const sourceVideo = join(directory, "reference.mp4");
  await execFileAsync(ffmpegStatic, [
    "-nostdin", "-y", "-f", "lavfi", "-i", "testsrc2=size=90x160:rate=10",
    "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", sourceVideo,
  ]);
  const plan = {
    product: {
      category: "cotton swabs",
      observedFeatures: ["light wooden shafts", "white double-ended tips"],
      visibleUses: ["small-area makeup detailing"],
      uncertainty: "Material specifications are not verified.",
    },
    reference: {
      visualGrammar: "Macro eye framing, product entry, precise touch-up, then a reveal.",
      subjectFraming: "Vertical macro framing on a generic adult creator's eye and hand.",
      actionSequence: [
        "Bring one cotton swab into frame beside the eye.",
        "Complete one precise makeup touch-up without touching the eye.",
        "Move the swab away and rotate it to show both tips.",
      ],
      pacing: "fast",
      transitionMoment: 0.58,
      typography: "Short high-contrast captions.",
    },
    adaptation: {
      strategy: "Recreate the action rhythm with a new generic creator and the supplied product.",
      palette: ["#f1e7df", "#9d2878", "#fff4cb"],
      narration: "Use one precise tool to refine small makeup details.",
      shots: Array.from({ length: 6 }, (_, index) => ({
        durationWeight: 1, focusX: 0.5, focusY: 0.5, cropScale: 1.2,
        motion: ["punch", "drift_left", "drift_right", "slow_zoom", "reveal", "reveal"][index],
        copy: ["LOOK CLOSER", "ONE PRECISE TOOL", "REFINE DETAILS", "MOVE WITH CONTROL", "SHOW BOTH TIPS", "SEE THE PRODUCT"][index],
        copyPlacement: "bottom",
        emphasis: ["hook", "feature", "action", "action", "proof", "cta"][index],
      })),
    },
  };
  let receivedReference = null;
  const adapter = new HypitAdapter({
    rootDir,
    dataDir: join(directory, "seller-data"),
    workflowFile,
    hypitBin: join(rootDir, "vendor/hypit/hypit"),
    isolationVerified: true,
    commandRunner: async () => { throw new Error("Hypit build must not start before the Veo assertion"); },
    inputPreparer: {
      voiceProvider: { provider: "google-cloud-tts", commercialUseApproved: true },
      async prepare() {
        return { voice: { commercialUseApproved: true, requirementsSatisfied: true } };
      },
    },
    videoProvider: {
      async prepare(request) {
        receivedReference = request.referenceAdaptation;
        throw new AppError("test_veo_called", "Veo received reference choreography", 503);
      },
    },
    referenceVisionProvider: {
      async readiness() { return { configured: true }; },
      async generate() { return { provider: "test-vision", model: "test", usage: {}, plan }; },
    },
    referenceAnalysisRunner: async (_program, args) => {
      if (args[1] === "probe") return { stdout: JSON.stringify({ duration: 2, width: 90, height: 160, frameRate: 10 }), stderr: "" };
      if (args[1] === "boundaries") return { stdout: JSON.stringify({ candidates: [{ at: 1, score: 0.9 }] }), stderr: "" };
      throw new Error(`Unexpected reference command: ${args.join(" ")}`);
    },
    trustedUploadOrigin: "https://buyer.example",
    trustedUploadDirectory: uploadDirectory,
    referenceVideoFetcher: async (_url, { directory: targetDirectory, basename }) => {
      await mkdir(targetDirectory, { recursive: true });
      const path = join(targetDirectory, `${basename}.mp4`);
      await copyFile(sourceVideo, path);
      const bytes = await readFile(path);
      return {
        path,
        filename: `${basename}.mp4`,
        mediaType: "video/mp4",
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sourceHost: "www.tiktok.com",
        sourcePlatform: "TikTok",
      };
    },
  });
  await assert.rejects(adapter.start({
    order: { id: "ord_reference_veo", amountSats: 1300 },
    quote: {
      product: { id: "proof_demo", name: "Proof Demo", durationSeconds: [20, 45], objectives: ["conversion"] },
      brief: {
        productName: "Cotton swabs",
        description: "Adapt the reference action for this product",
        referenceUrl: `https://buyer.example/v1/uploads/${uploadFilename}`,
        evidenceUrl: "https://www.tiktok.com/@creator/video/6798977602963918085",
      },
      addOns: { hookVariants: 1, languages: ["en-US"], aspectRatios: ["9:16"] },
    },
  }), (error) => error.code === "test_veo_called");
  assert.equal(receivedReference?.format, "seller.reference-vision-plan@2");
  assert.deepEqual(receivedReference?.plan.reference.actionSequence, plan.reference.actionSequence);
});

test("Seller retries reference analysis once at its cost, then stops after two lost responses", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hypit-reference-uncertain-"));
  const workflow = JSON.parse(await readFile(join(rootDir, "config/hypit-workflows.json"), "utf8")).proof_demo;
  const workflowFile = join(directory, "workflows.json");
  await writeFile(workflowFile, JSON.stringify({ proof_demo: workflow }));
  const uploadDirectory = join(directory, "uploads");
  const uploadFilename = `${"d".repeat(48)}.jpg`;
  await mkdir(uploadDirectory, { recursive: true });
  await copyFile(join(rootDir, "product_pic.jpeg"), join(uploadDirectory, uploadFilename));
  const sourceVideo = join(directory, "reference.mp4");
  await execFileAsync(ffmpegStatic, [
    "-nostdin", "-y", "-f", "lavfi", "-i", "testsrc2=size=90x160:rate=10",
    "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", sourceVideo,
  ]);
  let analysisCalls = 0;
  const adapter = new HypitAdapter({
    rootDir,
    dataDir: join(directory, "seller-data"),
    workflowFile,
    hypitBin: join(rootDir, "vendor/hypit/hypit"),
    isolationVerified: true,
    commandRunner: async () => { throw new Error("Hypit must not start"); },
    inputPreparer: { voiceProvider: { provider: "google-cloud-tts", commercialUseApproved: true } },
    referenceVisionProvider: {
      async generate() { analysisCalls += 1; throw new Error("response lost after analysis submission"); },
    },
    referenceAnalysisRunner: async (_program, args) => ({
      stdout: JSON.stringify(args[1] === "probe"
        ? { duration: 2, width: 90, height: 160, frameRate: 10 }
        : { candidates: [{ at: 1, score: 0.9 }] }),
      stderr: "",
    }),
    trustedUploadOrigin: "https://buyer.example",
    trustedUploadDirectory: uploadDirectory,
    referenceVideoFetcher: async (_url, { directory: targetDirectory, basename }) => {
      await mkdir(targetDirectory, { recursive: true });
      const path = join(targetDirectory, `${basename}.mp4`);
      await copyFile(sourceVideo, path);
      const bytes = await readFile(path);
      return {
        path, filename: `${basename}.mp4`, mediaType: "video/mp4", bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"), sourceHost: "www.tiktok.com",
      };
    },
  });
  const request = {
    order: { id: "ord_reference_uncertain", amountSats: 1300 },
    quote: {
      product: { id: "proof_demo", name: "Proof Demo", durationSeconds: [20, 45] },
      brief: {
        productName: "Cotton swabs",
        referenceUrl: `https://buyer.example/v1/uploads/${uploadFilename}`,
        evidenceUrl: "https://www.tiktok.com/@creator/video/6798977602963918085",
      },
      addOns: { hookVariants: 1, languages: ["en-US"], aspectRatios: ["9:16"] },
    },
  };
  await assert.rejects(adapter.start(request), (error) => error.code === "reference_adaptation_submission_uncertain");
  const attempt = JSON.parse(await readFile(join(directory, "seller-data", "jobs", request.order.id,
    "reference-adaptation", "plan.attempt.json"), "utf8"));
  assert.equal(attempt.orderId, request.order.id);
  await assert.rejects(adapter.start(request), (error) => error.code === "reference_adaptation_submission_uncertain");
  assert.equal(analysisCalls, 2);
});

test("HypitAdapter compiles a paid commission and verifies the Build receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hypit-adapter-compiler-"));
  let buildCalls = 0;
  const commandRunner = async (_program, args, { cwd }) => {
    const command = args[0];
    if (command === "check") return { stdout: JSON.stringify({ ok: true }), stderr: "" };
    if (command === "plan") return { stdout: JSON.stringify({ ok: true, requestIssueCount: 0 }), stderr: "" };
    if (command === "build") {
      buildCalls += 1;
      return { stdout: JSON.stringify({ build: { id: "bld_fake_compiled" } }), stderr: "" };
    }
    if (command === "status") return { stdout: JSON.stringify({ build: { work: { outcome: "complete" } } }), stderr: "" };
    if (command === "get") {
      const output = args[args.indexOf("--output") + 1];
      const destination = args[args.indexOf("--to") + 1];
      if (output === "commission-receipt" || output === "input-source-manifest") {
        const source = await readFile(join(cwd, output === "commission-receipt" ? "receipt.svs" : "source-manifest.svs"), "utf8");
        const encoded = /text: "([^"]+)"/u.exec(source)?.[1];
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, "value.json"), JSON.stringify({ format: "hypit.result-value@1", value: { value: encoded }, resources: [] }));
      } else await writeFile(destination, "fake-video");
      return { stdout: JSON.stringify({ ok: true }), stderr: "" };
    }
    throw new Error(`Unexpected fake Hypit command ${command}`);
  };
  const base = JSON.parse(await readFile(join(rootDir, "config/hypit-workflows.json"), "utf8")).ranking_listicle;
  const workflow = {
    ...base,
    readyForSale: true,
    runtime: undefined,
    productionInputs: { enabled: true, copyProvider: "fake-copy", voiceProvider: "fake-voice" },
    maxProviderCostSats: 100,
    providerTermsConfirmedAt: "2026-09-18T00:00:00Z",
  };
  const workflowFile = join(directory, "workflows.json");
  await writeFile(workflowFile, JSON.stringify({ ranking_listicle: workflow }));
  const uploadDirectory = join(directory, "buyer-uploads");
  const uploadFilename = `${"a".repeat(48)}.jpg`;
  await mkdir(uploadDirectory, { recursive: true });
  await copyFile(join(rootDir, "productions/shared-assets/arduino-uno-r4-wifi/product.jpg"), join(uploadDirectory, uploadFilename));
  const inputPreparer = new ProductionInputPreparer({
    copyProvider: {
      async generate(request) {
        return {
          provider: "fake-copy",
          model: "fake-model",
          value: {
            variants: request.languages.map((language) => ({
              hookIndex: 1,
              language,
              headline: "A localized headline",
              items: ["First", "Second", "Third"],
              voiceScript: "A localized narration",
              speakerTurns: [{ role: "host_a", text: "A localized narration" }],
            })),
          },
        };
      },
    },
    voiceProvider: {
      provider: "fake-voice",
      commercialUseApproved: true,
      async synthesize({ destination }) {
        await copyFile(join(rootDir, "productions/ranking-listicle/assets/narration.wav"), destination);
        return {
          provider: "fake-voice",
          voiceId: "fixture",
          commercialUseApproved: true,
          requirementsApplied: true,
          mediaType: "audio/wav",
        };
      },
    },
  });
  const adapter = new HypitAdapter({
    rootDir,
    dataDir: join(directory, "seller-data"),
    workflowFile,
    hypitBin: join(directory, "fake-hypit"),
    isolationVerified: true,
    commandRunner,
    inputPreparer,
    trustedUploadOrigin: "https://buyer.example",
    trustedUploadDirectory: uploadDirectory,
  });
  const order = { id: "ord_adapter_compiler", amountSats: 1600 };
  const quote = {
    product: {
      id: "ranking_listicle",
      name: "Ranking / Listicle",
      durationSeconds: [20, 35],
      objectives: ["comparison"],
    },
    brief: {
      productName: "UNO R4 WiFi",
      description: "Compare three concrete maker features",
      items: ["UNO format", "Wireless", "LED matrix"],
      referenceUrl: `https://buyer.example/v1/uploads/${uploadFilename}`,
    },
    addOns: { hookVariants: 1, languages: ["en-US"], aspectRatios: ["9:16"], inputSourceManifest: true },
  };
  const submission = await adapter.start({ order, quote });
  assert.equal(submission.buildId, "bld_fake_compiled");
  assert.equal((await adapter.recoverUnsubmitted({ order, quote })).buildId, submission.buildId);
  assert.equal(buildCalls, 1);
  const buildReceipt = JSON.parse(await readFile(join(directory, "seller-data", "jobs", order.id, "build.receipt.json"), "utf8"));
  assert.equal(buildReceipt.buildId, submission.buildId);
  const result = await adapter.resume({ ...submission, order, quote });
  assert.equal(result.commissionReceipt.orderId, order.id);
  assert.equal(result.commissionReceipt.productId, quote.product.id);
  assert.equal(result.commissionReceipt.variantCount, 1);
  assert.equal(result.commissionReceipt.productionInputs.copyProvider, "fake-copy");
  assert.equal(result.commissionReceipt.productionInputs.commercialUseApproved, true);
  assert.equal(result.commissionReceipt.productionInputs.requirementsSatisfied, true);
  assert.equal(result.commissionReceipt.localAssets[0].sourceHost, "buyer.example");
  assert.deepEqual(result.commissionReceipt.sourceLinks, []);
  assert.deepEqual(result.commissionReceipt.productionInputs.creativeRequirements, {
    visualMode: "package_default",
    voiceRequirements: [],
  });
  assert.equal(result.commissionReceipt.productionInputs.variants[0].timing.tempoRate, 1);
  assert.match(result.commissionReceipt.productionInputs.variants[0].timing.compiledAudio[0].sha256, /^[a-f0-9]{64}$/u);
  assert.equal(result.artifacts.length, 2);
  for (const artifact of result.artifacts) {
    const contents = await readFile(join(directory, "seller-data", "jobs", order.id, "outputs", artifact.name));
    assert.equal(artifact.bytes, contents.length);
    assert.equal(artifact.sha256, createHash("sha256").update(contents).digest("hex"));
  }
  assert.deepEqual(result.artifacts.map((item) => item.specification), [
    {
      hookIndex: 1,
      language: "en-US",
      aspectRatio: "9:16",
      durationSeconds: 20,
      referenceGuided: false,
      maxContinuousFreezeSeconds: null,
    },
    { kind: "input_source_manifest" },
  ]);
});

test("HypitAdapter removes paid workflows when production providers are not ready", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hypit-adapter-readiness-"));
  const hypitBin = join(directory, "hypit");
  await writeFile(hypitBin, "#!/bin/sh\nexit 0\n");
  await chmod(hypitBin, 0o700);
  const base = JSON.parse(await readFile(join(rootDir, "config/hypit-workflows.json"), "utf8")).creator_pitch;
  const workflowFile = join(directory, "workflows.json");
  await writeFile(workflowFile, JSON.stringify({ creator_pitch: { ...base, readyForSale: true } }));
  const inputPreparer = {
    voiceProvider: { provider: "google-cloud-tts", commercialUseApproved: true },
    async readiness() {
      return {
        configured: false,
        copy: { configured: false, issue: "deepseek_credential_missing" },
        voice: { configured: true },
      };
    },
  };
  const adapter = new HypitAdapter({
    rootDir,
    dataDir: join(directory, "seller-data"),
    workflowFile,
    hypitBin,
    isolationVerified: true,
    commandRunner: async () => ({ stdout: "{}", stderr: "" }),
    inputPreparer,
  });
  const readiness = await adapter.readiness();
  assert.equal(readiness.configured, false);
  assert.equal(readiness.productionInputs.configured, false);
  assert.equal(readiness.workflowIssues.creator_pitch, "deepseek_credential_missing");
});
