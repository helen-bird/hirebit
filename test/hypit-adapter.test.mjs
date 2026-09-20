import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { downloadSocialReferenceVideo, HypitAdapter } from "../src/hypit-adapter.mjs";
import { AppError } from "../src/errors.mjs";
import { ProductionInputPreparer } from "../src/production-input-preparer.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("Hypit social reference fetch localizes a platform page as an order-private video", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hypit-social-reference-"));
  const result = await downloadSocialReferenceVideo(
    "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    {
      directory: join(directory, "inputs"),
      stateHome: join(directory, "state"),
      hypitBin: "/fake/hypit",
      commandRunner: async (program, args) => {
        assert.equal(program, "/fake/hypit");
        if (args[1] === "prepare-fetch") return { stdout: JSON.stringify({ ready: true }), stderr: "" };
        assert.deepEqual(args.slice(0, 3), ["media", "fetch", "https://www.youtube.com/shorts/dQw4w9WgXcQ"]);
        const destination = args[args.indexOf("--to") + 1];
        await writeFile(destination, "fake-reference-video");
        return { stdout: JSON.stringify({ path: destination }), stderr: "" };
      },
    },
  );
  assert.equal(result.mediaType, "video/mp4");
  assert.equal(result.sourcePlatform, "YouTube Shorts");
  assert.equal(result.fetchedBy, "hypit-media-fetch");
  assert.match(result.sha256, /^[a-f0-9]{64}$/u);
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

test("HypitAdapter compiles a paid commission and verifies the Build receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hypit-adapter-compiler-"));
  const commandRunner = async (_program, args, { cwd }) => {
    const command = args[0];
    if (command === "check") return { stdout: JSON.stringify({ ok: true }), stderr: "" };
    if (command === "plan") return { stdout: JSON.stringify({ ok: true, requestIssueCount: 0 }), stderr: "" };
    if (command === "build") return { stdout: JSON.stringify({ build: { id: "bld_fake_compiled" } }), stderr: "" };
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
  assert.deepEqual(result.artifacts.map((item) => item.specification), [
    { hookIndex: 1, language: "en-US", aspectRatio: "9:16" },
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
