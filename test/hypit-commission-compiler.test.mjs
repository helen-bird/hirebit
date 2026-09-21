import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

import ffmpegStatic from "ffmpeg-static";

import {
  compileCommissionProject,
  decodeHypitTextJson,
} from "../src/hypit-commission-compiler.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);

async function fixture({ addOns = {}, inputSourceManifest = false } = {}) {
  const jobDir = await mkdtemp(join(tmpdir(), "hypit-commission-compiler-"));
  const workflows = JSON.parse(await readFile(join(rootDir, "config/hypit-workflows.json"), "utf8"));
  const order = { id: "ord_compiler_test", amountSats: 2610 };
  const quote = {
    product: {
      id: "ranking_listicle",
      name: "Ranking / Listicle",
      durationSeconds: [20, 35],
      objectives: ["comparison"],
    },
    brief: {
      productName: "UNO R4 WiFi",
      description: "Compare the concrete maker features",
      hooks: ["Three reasons to look closer", "The board answers back", "Keep the familiar shape"],
      items: ["Familiar UNO format", "Wireless connectivity", "On-board LED matrix"],
      localAssets: {},
    },
    addOns: {
      hookVariants: 3,
      languages: ["en-US", "es-US"],
      aspectRatios: ["9:16", "1:1"],
      inputSourceManifest,
      ...addOns,
    },
  };
  const commissionPath = join(jobDir, "commission.json");
  await writeFile(commissionPath, `${JSON.stringify({ order, quote, localAssets: {} }, null, 2)}\n`, { mode: 0o600 });
  return { jobDir, workflow: workflows.ranking_listicle, order, quote, commissionPath };
}

async function inputsWithNarration(input, durationSeconds) {
  const directory = join(input.jobDir, "production-inputs", "audio");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "h1-en-1-host_a.wav");
  await execFileAsync(ffmpegStatic, [
    "-nostdin", "-y", "-f", "lavfi", "-i", `sine=frequency=440:duration=${durationSeconds}`,
    "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", path,
  ]);
  const bytes = await readFile(path);
  const commissionSha256 = createHash("sha256").update(await readFile(input.commissionPath)).digest("hex");
  return {
    format: "seller.production-inputs@1",
    orderId: input.order.id,
    productId: input.quote.product.id,
    commissionSha256,
    manifestSha256: "1".repeat(64),
    copy: { provider: "test-copy", model: "test" },
    voice: { provider: "test-voice", commercialUseApproved: true },
    variants: [{
      hookIndex: 1,
      language: "en-US",
      headline: "Three reasons",
      items: ["First", "Second", "Third"],
      voiceScript: "Test narration",
      audio: [{
        role: "host_a",
        file: "audio/h1-en-1-host_a.wav",
        mediaType: "audio/wav",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        provider: "test-voice",
        voiceId: "test",
      }],
    }],
  };
}

test("commission compiler materializes the purchased hook-language-ratio matrix", async () => {
  const input = await fixture({ inputSourceManifest: true });
  const manifest = await compileCommissionProject({ rootDir, ...input });
  assert.equal(manifest.variantCount, 12);
  assert.equal(manifest.deliverables.filter((item) => item.mediaType === "video/mp4").length, 12);
  assert.equal(manifest.deliverables.at(-1).specification.kind, "input_source_manifest");
  assert.equal(new Set(manifest.deliverables.filter((item) => item.mediaType === "video/mp4")
    .map((item) => `${item.specification.hookIndex}:${item.specification.language}:${item.specification.aspectRatio}`)).size, 12);
  const run = await readFile(join(input.jobDir, "hypit-project", "run.svrun"), "utf8");
  assert.equal((run.match(/<target output=/gu) ?? []).length, 14);
  assert.match(run, /commission-receipt/u);
  assert.match(run, /input-source-manifest/u);
  const again = await compileCommissionProject({ rootDir, ...input });
  assert.deepEqual(again, manifest);
  await writeFile(join(input.jobDir, "hypit-project", "author.svml"), "tampered");
  await assert.rejects(
    compileCommissionProject({ rootDir, ...input }),
    (error) => error.code === "production_source_digest_mismatch",
  );
});

test("commission compiler refuses unsupported or excessive output matrices", async () => {
  const unsupported = await fixture({ addOns: { aspectRatios: ["4:5"] } });
  await assert.rejects(
    compileCommissionProject({ rootDir, ...unsupported }),
    (error) => error.code === "production_aspect_ratio_unsupported",
  );
  const excessive = await fixture({ addOns: {
    hookVariants: 5,
      languages: ["en-US", "en-GB", "es-US", "zh-CN"],
      aspectRatios: ["9:16", "1:1"],
  } });
  await assert.rejects(
    compileCommissionProject({ rootDir, ...excessive }),
    (error) => error.code === "production_variant_limit",
  );
});

test("commission compiler safely speeds up mildly overlong narration and rejects excessive compression", async () => {
  const adaptable = await fixture({ addOns: { hookVariants: 1, languages: ["en-US"], aspectRatios: ["9:16"] } });
  const productionInputs = await inputsWithNarration(adaptable, 23);
  const manifest = await compileCommissionProject({ rootDir, ...adaptable, productionInputs });
  assert.equal(manifest.audioTiming.length, 1);
  assert.ok(manifest.audioTiming[0].tempoRate > 1);
  assert.ok(manifest.audioTiming[0].tempoRate <= 1.25);
  assert.ok(manifest.audioTiming[0].fittedTotalSeconds <= manifest.audioTiming[0].budgetSeconds + 0.12);

  const excessive = await fixture({ addOns: { hookVariants: 1, languages: ["en-US"], aspectRatios: ["9:16"] } });
  const excessiveInputs = await inputsWithNarration(excessive, 30);
  await assert.rejects(
    compileCommissionProject({ rootDir, ...excessive, productionInputs: excessiveInputs }),
    (error) => error.code === "production_audio_too_long" && error.details.requiredTempoRate > 1.25,
  );
});

test("commission compiler binds generated product motion and emits Hypit-valid source", async () => {
  const input = await fixture({ addOns: { hookVariants: 1, languages: ["en-US"], aspectRatios: ["9:16"] } });
  const directory = join(input.jobDir, "veo-inputs");
  const videoPath = join(directory, "product-motion.mp4");
  await mkdir(directory, { recursive: true });
  await execFileAsync(ffmpegStatic, [
    "-nostdin", "-y", "-f", "lavfi", "-i", "color=c=teal:s=720x1280:d=8:r=30",
    "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", videoPath,
  ]);
  const videoBytes = await readFile(videoPath);
  const commissionSha256 = createHash("sha256").update(await readFile(input.commissionPath)).digest("hex");
  const generatedVideo = {
    format: "seller.google-veo-input@1",
    orderId: input.order.id,
    productId: input.quote.product.id,
    commissionSha256,
    provider: "google-vertex-veo",
    model: "veo-3.1-lite-generate-001",
    output: {
      path: videoPath,
      mediaType: "video/mp4",
      sha256: createHash("sha256").update(videoBytes).digest("hex"),
      durationSeconds: 8,
    },
  };
  const manifest = await compileCommissionProject({ rootDir, ...input, generatedVideo });
  assert.equal(manifest.videoInputSha256, generatedVideo.output.sha256);
  const projectDir = join(input.jobDir, manifest.projectDirectory);
  const normalizedVideo = await readFile(join(projectDir, "assets/customer-motion.mp4"));
  assert.notEqual(createHash("sha256").update(normalizedVideo).digest("hex"), generatedVideo.output.sha256);
  const author = await readFile(join(projectDir, "author.svml"), "utf8");
  assert.match(author, /<asset:Video id="product-motion"/u);
  assert.match(author, /source=\{product-motion\}/u);
  await execFileAsync(join(rootDir, "vendor/hypit/hypit"), [
    "check", join(projectDir, manifest.run), "--workspace", projectDir, "--json",
  ], { cwd: projectDir, timeout: 120_000 });
});

test("commission compiler uses reference-guided Veo motion while retaining the bound analysis receipt", async () => {
  const input = await fixture({ addOns: { hookVariants: 1, languages: ["en-US"], aspectRatios: ["9:16", "1:1"] } });
  const workflows = JSON.parse(await readFile(join(rootDir, "config/hypit-workflows.json"), "utf8"));
  input.workflow = workflows.proof_demo;
  input.quote.product = {
    id: "proof_demo",
    name: "Proof Demo",
    durationSeconds: [20, 45],
    objectives: ["product_education"],
  };
  input.quote.brief = {
    productName: "Cotton swabs",
    description: "Show the supplied product using the reference video's reusable visual grammar",
    hooks: ["A closer look"],
    items: ["Double-tipped swabs", "Clear storage tub", "Compact detail tool"],
    referenceUrl: "https://example.com/product.jpeg",
    evidenceUrl: "https://www.tiktok.com/@example/video/1234567890123456789",
  };

  const inputDir = join(input.jobDir, "localized-inputs");
  await mkdir(inputDir, { recursive: true });
  const productPath = join(inputDir, "product.jpeg");
  const referencePath = join(inputDir, "reference.mp4");
  await Promise.all([
    copyFile(join(rootDir, "product_pic.jpeg"), productPath),
    execFileAsync(ffmpegStatic, [
      "-nostdin", "-y", "-f", "lavfi", "-i", "testsrc2=size=90x160:rate=10",
      "-t", "12.6", "-c:v", "libx264", "-pix_fmt", "yuv420p", referencePath,
    ]),
  ]);
  const productBytes = await readFile(productPath);
  const referenceBytes = await readFile(referencePath);
  const productSha256 = createHash("sha256").update(productBytes).digest("hex");
  const referenceSha256 = createHash("sha256").update(referenceBytes).digest("hex");
  const localAssets = {
    referenceUrl: {
      path: productPath,
      filename: "product.jpeg",
      mediaType: "image/jpeg",
      bytes: productBytes.length,
      sha256: productSha256,
      sourceHost: "example.com",
    },
    evidenceUrl: {
      path: referencePath,
      filename: "reference.mp4",
      mediaType: "video/mp4",
      bytes: referenceBytes.length,
      sha256: referenceSha256,
      sourceHost: "www.tiktok.com",
    },
  };
  await writeFile(input.commissionPath, `${JSON.stringify({ order: input.order, quote: input.quote, localAssets }, null, 2)}\n`, { mode: 0o600 });
  const commissionSha256 = createHash("sha256").update(await readFile(input.commissionPath)).digest("hex");
  // Schema-valid synthetic model output; no private cached provider response or social footage.
  const plan = {
    product: {
      category: "cotton swabs",
      observedFeatures: ["clear round tub", "white cotton tips"],
      visibleUses: ["small-area detailing"],
      uncertainty: "Material specifications are not verified.",
    },
    reference: {
      visualGrammar: "Detail opening, process phase, reveal and close.",
      subjectFraming: "Vertical macro framing on a generic adult creator's eye and hand.",
      actionSequence: [
        "A hand brings one cotton swab beside the eye.",
        "The creator completes one precise makeup touch-up.",
        "The hand rotates the swab before the product reveal.",
      ],
      pacing: "moderate", transitionMoment: 0.58,
      typography: "Short high-contrast statements.",
    },
    adaptation: {
      strategy: "Compose product crops with six distinct motion beats.",
      palette: ["#f1e7df", "#9d2878", "#fff4cb"],
      narration: "Look closer at a detail tool for your routine.",
      shots: Array.from({ length: 6 }, (_, index) => ({
        durationWeight: 1, focusX: 0.5, focusY: 0.5, cropScale: 1.2,
        motion: ["punch", "drift_left", "drift_right", "slow_zoom", "reveal", "reveal"][index],
        copy: ["LOOK CLOSER", "DOUBLE ENDED", "SMALL DETAILS", "REFINE THE EDGES", "TIDY THE FINISH", "EXPLORE THE PRODUCT"][index],
        copyPlacement: "bottom",
        emphasis: ["hook", "feature", "action", "action", "proof", "cta"][index],
      })),
    },
  };
  const referenceAdaptation = {
    format: "seller.reference-vision-plan@2",
    orderId: input.order.id,
    productId: input.quote.product.id,
    commissionSha256,
    manifestSha256: "2".repeat(64),
    inputs: { productSha256, referenceSha256 },
    source: {
      durationSeconds: 12.606,
      frameRate: 10,
      boundaryTimes: [0, 2.362, 5.513, 7.25, 10.667, 12.6],
    },
    sampling: [0.5, 2, 4, 6, 8, 10, 11, 12],
    provider: "test-vision",
    model: "synthetic-plan",
    plan,
  };

  const veoDirectory = join(input.jobDir, "veo-inputs");
  const videoPath = join(veoDirectory, "product-motion.mp4");
  await mkdir(veoDirectory, { recursive: true });
  await execFileAsync(ffmpegStatic, [
    "-nostdin", "-y", "-f", "lavfi", "-i", "color=c=magenta:s=720x1280:d=16:r=30",
    "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", videoPath,
  ]);
  const videoBytes = await readFile(videoPath);
  const generatedVideo = {
    format: "seller.google-veo-input@1",
    orderId: input.order.id,
    productId: input.quote.product.id,
    commissionSha256,
    provider: "google-vertex-veo",
    model: "veo-3.1-lite-generate-001",
    generationCount: 2,
    segments: [1, 2].map((index) => ({
      index,
      sha256: `${index}`.repeat(64),
      durationSeconds: 8,
    })),
    output: {
      path: videoPath,
      mediaType: "video/mp4",
      sha256: createHash("sha256").update(videoBytes).digest("hex"),
      durationSeconds: 16,
    },
  };

  const productionInputs = await inputsWithNarration(input, 10);
  const manifest = await compileCommissionProject({
    rootDir, ...input, generatedVideo, referenceAdaptation, productionInputs,
  });
  assert.equal(manifest.referenceAdaptationSha256, referenceAdaptation.manifestSha256);
  assert.equal(manifest.videoInputSha256, generatedVideo.output.sha256);
  assert.equal(manifest.deliverables[0].specification.durationSeconds, 12.6);
  const projectDir = join(input.jobDir, manifest.projectDirectory);
  const author = await readFile(join(projectDir, "author.svml"), "utf8");
  assert.equal((author.match(/reference-shot-[1-6]/gu) ?? []).length, 0);
  assert.match(author, /generated-motion/u);
  assert.doesNotMatch(author, /product-endcard/u);
  assert.match(author, /end="12\.6s"/u);
  assert.doesNotMatch(author, /presenter-shot/u);
  const receiptSource = await readFile(join(projectDir, "receipt.svs"), "utf8");
  const encodedReceipt = receiptSource.match(/text: "([^"]+)";/u)?.[1];
  const receipt = decodeHypitTextJson(encodedReceipt);
  assert.equal(receipt.referenceAdaptation.sourceVideoSha256, referenceSha256);
  assert.equal(receipt.referenceAdaptation.productImageSha256, productSha256);
  assert.equal(receipt.videoGeneration.generationCount, 2);
  assert.equal(receipt.referenceAdaptation.renderMode, "veo-two-segment-continuation");
  assert.equal(receipt.referenceAdaptation.renderedShots.length, 0);
  assert.equal(receipt.referenceAdaptation.actionSequence.length, 3);
  await execFileAsync(join(rootDir, "vendor/hypit/hypit"), [
    "check", join(projectDir, manifest.run), "--workspace", projectDir, "--json",
  ], { cwd: projectDir, timeout: 120_000 });
});

test("Hypit text JSON envelope requires the compiler prefix", () => {
  const encoded = `seller-json-v1:${Buffer.from(JSON.stringify({ orderId: "ord_1" })).toString("base64url")}`;
  assert.deepEqual(decodeHypitTextJson(encoded), { orderId: "ord_1" });
  assert.throws(() => decodeHypitTextJson("{}"), (error) => error.code === "hypit_json_output_invalid");
});
