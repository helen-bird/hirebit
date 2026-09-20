import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GoogleVeoVideoProvider } from "../src/google-veo-video-provider.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

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

test("Google Veo provider submits once, persists the operation, and reuses the bound output", async () => {
  const input = await setup();
  const generatedBytes = Buffer.alloc(12_000, 7);
  const calls = [];
  const provider = new GoogleVeoVideoProvider({
    projectId: "project-test",
    enabled: true,
    commercialUseApproved: true,
    maxGenerations: 1,
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
  const manifest = await provider.prepare({ ...input, productionInputs: {
    variants: [{ headline: "See the useful detail" }],
  } });
  assert.equal(manifest.provider, "google-vertex-veo");
  assert.equal(manifest.output.sha256, sha256(generatedBytes));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers.authorization, "Bearer private-token");
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.parameters.durationSeconds, 8);
  assert.equal(body.parameters.sampleCount, 1);
  assert.equal(body.parameters.generateAudio, false);
  assert.equal(body.instances[0].prompt.includes("http"), false);

  const again = await provider.prepare({ ...input, productionInputs: {
    variants: [{ headline: "See the useful detail" }],
  } });
  assert.deepEqual(again, manifest);
  assert.equal(calls.length, 2);
  assert.deepEqual(await readFile(manifest.output.path), generatedBytes);
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
  const generatedBytes = Buffer.alloc(12_000, 9);
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
  assert.ok(ledger.entries[input.order.id]);
});
