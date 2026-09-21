import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import ffmpegStatic from "ffmpeg-static";

import { GoogleVeoVideoProvider } from "../src/google-veo-video-provider.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const execFileAsync = promisify(execFile);

async function generatedVideoBytes(root, color = "magenta") {
  const path = join(root, `${color}.mp4`);
  await execFileAsync(ffmpegStatic, [
    "-nostdin", "-y", "-f", "lavfi", "-i", "testsrc2=size=180x320:rate=24:duration=8",
    "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", path,
  ]);
  return await readFile(path);
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "google-veo-provider-"));
  const jobDir = join(root, "job");
  const inputDir = join(jobDir, "inputs");
  await mkdir(inputDir, { recursive: true });
  const imagePath = join(inputDir, "product.jpg");
  const image = Buffer.alloc(2048, 3);
  await writeFile(imagePath, image);
  const order = { id: "ord_veo_test" };
  const quote = {
    product: { id: "proof_demo", name: "Proof Demo" },
    brief: { productName: "Sample product", description: "Show the visible product in use" },
  };
  const commissionPath = join(jobDir, "commission.json");
  await writeFile(commissionPath, JSON.stringify({
    order,
    quote,
    localAssets: {
      referenceUrl: {
        path: imagePath,
        mediaType: "image/jpeg",
        sha256: sha256(image),
      },
    },
  }));
  return { root, jobDir, order, quote, commissionPath };
}

async function referenceGuidance(input) {
  const commissionBytes = await readFile(input.commissionPath);
  const commission = JSON.parse(commissionBytes);
  return {
    format: "seller.reference-vision-plan@2",
    orderId: input.order.id,
    productId: input.quote.product.id,
    commissionSha256: sha256(commissionBytes),
    manifestSha256: "a".repeat(64),
    inputs: {
      productSha256: commission.localAssets.referenceUrl.sha256,
      referenceSha256: "b".repeat(64),
    },
    plan: {
      product: {
        category: "cotton swabs",
        observedFeatures: ["light wooden shafts", "white double-ended tips"],
        visibleUses: ["small-area makeup detailing"],
        uncertainty: "Material specifications are not verified.",
      },
      reference: {
        visualGrammar: "Macro eye framing, rapid product entry, precise touch-up, then a clean reveal.",
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
        strategy: "Recreate the macro action rhythm with a new generic creator and the supplied product.",
        palette: ["#f1e7df", "#9d2878", "#fff4cb"],
        narration: "Use one precise tool to refine small makeup details.",
        shots: Array.from({ length: 6 }, (_, index) => ({
          durationWeight: 1,
          focusX: 0.5,
          focusY: 0.5,
          cropScale: 1.2,
          motion: ["punch", "drift_left", "drift_right", "slow_zoom", "reveal", "reveal"][index],
          copy: ["LOOK CLOSER", "ONE PRECISE TOOL", "REFINE DETAILS", "MOVE WITH CONTROL", "SHOW BOTH TIPS", "SEE THE PRODUCT"][index],
          copyPlacement: "bottom",
          emphasis: ["hook", "feature", "action", "action", "proof", "cta"][index],
        })),
      },
    },
  };
}

test("Google Veo provider submits two continuous reference segments and reuses the bound output", async () => {
  const input = await setup();
  const generatedBytes = await generatedVideoBytes(input.root);
  const calls = [];
  const provider = new GoogleVeoVideoProvider({
    projectId: "project-test",
    enabled: true,
    commercialUseApproved: true,
    maxGenerations: 2,
    ledgerFile: join(input.root, "seller", "veo-ledger.json"),
    tokenProvider: async () => "private-token",
    sleepImpl: async () => {},
    pollIntervalMs: 0,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith(":predictLongRunning")) {
        return new Response(JSON.stringify({ name: "projects/project-test/operations/op-1" }), { status: 200 });
      }
      return new Response(JSON.stringify({
        done: true,
        response: { videos: [{ bytesBase64Encoded: generatedBytes.toString("base64") }] },
      }), { status: 200 });
    },
  });
  const referenceAdaptation = await referenceGuidance(input);
  const manifest = await provider.prepare({ ...input, productionInputs: {
    variants: [{ headline: "See the useful detail" }],
  }, referenceAdaptation });
  assert.equal(manifest.provider, "google-vertex-veo");
  assert.equal(manifest.referenceAdaptationSha256, referenceAdaptation.manifestSha256);
  assert.equal(manifest.generationCount, 2);
  assert.equal(manifest.segments.length, 2);
  assert.equal(manifest.segments[0].sha256, sha256(generatedBytes));
  assert.equal(calls.length, 4);
  assert.equal(calls[0].options.headers.authorization, "Bearer private-token");
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.parameters.durationSeconds, 8);
  assert.equal(body.parameters.sampleCount, 1);
  assert.equal(body.parameters.generateAudio, false);
  assert.equal(body.instances[0].prompt.includes("http"), false);
  assert.match(body.instances[0].prompt, /Bring one cotton swab into frame beside the eye/u);
  assert.match(body.instances[0].prompt, /do not reproduce or identify the source person/u);
  const continuationBody = JSON.parse(calls[2].options.body);
  assert.match(continuationBody.instances[0].prompt, /Continue seamlessly/u);
  assert.notEqual(continuationBody.instances[0].image.bytesBase64Encoded, body.instances[0].image.bytesBase64Encoded);

  const again = await provider.prepare({ ...input, productionInputs: {
    variants: [{ headline: "See the useful detail" }],
  }, referenceAdaptation });
  assert.deepEqual(again, manifest);
  assert.equal(calls.length, 4);
  assert.ok((await readFile(manifest.output.path)).length > 10_000);
});

test("Google Veo provider fails closed after an uncertain submission", async () => {
  const input = await setup();
  let calls = 0;
  const provider = new GoogleVeoVideoProvider({
    projectId: "project-test",
    enabled: true,
    commercialUseApproved: true,
    maxGenerations: 1,
    ledgerFile: join(input.root, "seller", "veo-ledger.json"),
    tokenProvider: async () => "private-token",
    fetchImpl: async () => {
      calls += 1;
      throw new Error("connection lost after write");
    },
  });
  await assert.rejects(
    provider.prepare(input),
    (error) => error.code === "google_veo_unavailable",
  );
  await assert.rejects(
    provider.prepare(input),
    (error) => error.code === "google_veo_submission_uncertain",
  );
  assert.equal(calls, 1);
});

test("Google Veo hourly reservation cap releases reservations older than one hour", async () => {
  const input = await setup();
  const ledgerFile = join(input.root, "seller", "veo-ledger.json");
  await mkdir(join(input.root, "seller"), { recursive: true });
  await writeFile(ledgerFile, JSON.stringify({
    format: "seller.google-veo-ledger@1",
    entries: {
      old_order: { reservedAt: "2026-09-21T09:00:00.000Z", model: "veo-3.1-lite-generate-001" },
    },
  }));
  const generatedBytes = await generatedVideoBytes(input.root, "teal");
  const provider = new GoogleVeoVideoProvider({
    projectId: "project-test",
    enabled: true,
    commercialUseApproved: true,
    maxGenerations: 1,
    ledgerFile,
    clock: () => Date.parse("2026-09-21T11:00:00.000Z"),
    tokenProvider: async () => "private-token",
    sleepImpl: async () => {},
    pollIntervalMs: 0,
    fetchImpl: async (url) => url.endsWith(":predictLongRunning")
      ? new Response(JSON.stringify({ name: "projects/project-test/operations/op-new" }), { status: 200 })
      : new Response(JSON.stringify({
        done: true,
        response: { videos: [{ bytesBase64Encoded: generatedBytes.toString("base64") }] },
      }), { status: 200 }),
  });
  const manifest = await provider.prepare(input);
  assert.equal(manifest.output.sha256, sha256(generatedBytes));
  const ledger = JSON.parse(await readFile(ledgerFile, "utf8"));
  assert.ok(ledger.entries.old_order);
  assert.ok(ledger.entries[`${input.order.id}:segment-1`]);
});
