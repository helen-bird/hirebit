import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CampaignCompletionService } from "../src/buyer/campaign-completion.mjs";

const video = Buffer.from("verified-hypit-video");

function campaign() {
  return {
    id: "cmp_package_test",
    input: {
      objective: "conversion",
      budgetSats: 3000,
      brief: { productName: "Acme Launch" },
    },
    decision: {
      rationale: "Proof Demo best balances conversion fit, quality, cost, and delivery speed.",
      selected: {
        score: 0.91,
        quote: {
          product: { id: "proof_demo", name: "Proof Demo" },
        },
      },
    },
    spentSats: 1300,
    remainingBudgetSats: 1700,
    paymentAttempt: { receipt: { instantReceiptId: "instant-receipt-1" } },
    sellerOrder: {
      id: "ord_1",
      amountSats: 1300,
      state: "completed",
      payment: {
        id: "pay_1",
        authorization: "authorized",
        settlement: "settled",
        paidAt: "2026-09-18T10:00:00.000Z",
        txids: ["deadbeef"],
      },
      production: {
        state: "completed",
        result: {
          provider: "self_hosted_hypit",
          buildId: "bld_1",
          artifacts: [{ name: "final.mp4", mediaType: "video/mp4" }],
        },
      },
    },
  };
}

test("CampaignCompletionService creates a verifiable outcome package", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "campaign-package-test-"));
  const seller = {
    async downloadArtifact(orderId, filename) {
      assert.equal(orderId, "ord_1");
      assert.equal(filename, "final.mp4");
      return { data: video, mediaType: "video/mp4" };
    },
  };
  const service = new CampaignCompletionService({
    seller,
    dataDir,
    clock: () => Date.parse("2026-09-18T11:00:00.000Z"),
    mediaValidator: async () => ({ expectedVideos: 1, validatedVideos: 1, coverage: ["1:en:9:16"] }),
  });

  const result = await service.complete(campaign());

  assert.equal(result.state, "completed");
  assert.equal(result.summary.spend.spentSats, 1300);
  assert.equal(result.paymentProof.instantReceiptId, "instant-receipt-1");
  assert.equal("paymentId" in result.paymentProof, false);
  assert.deepEqual(result.paymentProof.txids, ["deadbeef"]);
  assert.match(result.paymentProof.note, /only txids are on-chain/u);
  assert.equal(result.testingPlan.variants[0].strategy, "Pain → proof → CTA");

  const root = service.packageDirectory("cmp_package_test");
  const creative = await readFile(join(root, "creatives", "final.mp4"));
  assert.deepEqual(creative, video);
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  assert.equal(manifest.files.length, 5);
  const creativeEntry = manifest.files.find((item) => item.path === "creatives/final.mp4");
  assert.equal(creativeEntry.sha256, createHash("sha256").update(video).digest("hex"));
  assert.equal(creativeEntry.url, "/v1/campaigns/cmp_package_test/package/files/creatives/final.mp4");
  assert.equal((await stat(join(root, "summary.json"))).mode & 0o777, 0o600);
  const report = await readFile(join(root, "campaign-report.md"), "utf8");
  assert.equal(report.includes("pay_1"), false);
  assert.match(report, /Instant receipt: instant-receipt-1/u);
  assert.match(report, /On-chain txids: deadbeef/u);

  const updatedCampaign = campaign();
  updatedCampaign.sellerOrder.payment.txids = ["settled-chain-txid"];
  const refreshed = await service.refreshPaymentProof(updatedCampaign, result);
  assert.deepEqual(refreshed.paymentProof.txids, ["settled-chain-txid"]);
  const refreshedProof = JSON.parse(await readFile(join(root, "payment-proof.json"), "utf8"));
  assert.deepEqual(refreshedProof.txids, ["settled-chain-txid"]);
  assert.equal("paymentId" in refreshedProof, false);
  const refreshedReport = await readFile(join(root, "campaign-report.md"), "utf8");
  assert.match(refreshedReport, /settled-chain-txid/u);
});

test("CampaignCompletionService refuses incomplete fulfillment", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "campaign-package-test-"));
  const service = new CampaignCompletionService({ seller: {}, dataDir });
  const incomplete = campaign();
  incomplete.sellerOrder.state = "awaiting_payment";
  await assert.rejects(service.complete(incomplete), (error) => error.code === "fulfillment_not_complete");
});

test("a corrected delivery is versioned, keeps the original bytes, and refreshes its own proof", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "campaign-package-revision-test-"));
  let currentVideo = video;
  const service = new CampaignCompletionService({
    seller: { async downloadArtifact() { return { data: currentVideo, mediaType: "video/mp4" }; } },
    dataDir,
    mediaValidator: async () => ({ expectedVideos: 1, validatedVideos: 1 }),
  });
  const original = await service.complete(campaign());
  currentVideo = Buffer.from("corrected-verified-hypit-video");
  const correctedCampaign = campaign();
  correctedCampaign.sellerOrder.production.result.artifacts[0].sha256 = createHash("sha256").update(currentVideo).digest("hex");
  correctedCampaign.sellerOrder.production.result.artifacts[0].bytes = currentVideo.length;
  const revision = await service.complete(correctedCampaign, { revision: "r2" });
  await assert.rejects(service.complete(correctedCampaign, { revision: "r2" }),
    (error) => error.code === "delivery_revision_exists");
  assert.equal(revision.revision, "r2");
  assert.equal(revision.files.find((file) => file.mediaType === "video/mp4").path, "revisions/r2/creatives/final.mp4");
  assert.deepEqual(await readFile(join(service.packageDirectory(campaign().id), "creatives/final.mp4")), video);
  assert.deepEqual(await readFile(join(service.packageDirectory(campaign().id), "revisions/r2/creatives/final.mp4")), currentVideo);
  assert.equal(original.files.find((file) => file.path === "manifest.json").sha256,
    createHash("sha256").update(await readFile(join(service.packageDirectory(campaign().id), "manifest.json"))).digest("hex"));
  const refreshed = await service.refreshPaymentProof(correctedCampaign, revision);
  assert.equal(refreshed.files.find((file) => file.path === "revisions/r2/manifest.json").sha256,
    createHash("sha256").update(await readFile(join(service.packageDirectory(campaign().id), "revisions/r2/manifest.json"))).digest("hex"));
  assert.deepEqual(await readFile(join(service.packageDirectory(campaign().id), "creatives/final.mp4")), video);
  await assert.rejects(service.complete(correctedCampaign, { revision: "../../bad" }),
    (error) => error.code === "invalid_delivery_revision");
});

test("CampaignCompletionService rejects bytes that differ from Seller's completed artifact record", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "campaign-package-integrity-test-"));
  const completed = campaign();
  completed.sellerOrder.production.result.artifacts[0].bytes = video.length;
  completed.sellerOrder.production.result.artifacts[0].sha256 = "a".repeat(64);
  const service = new CampaignCompletionService({
    seller: { async downloadArtifact() { return { data: video, mediaType: "video/mp4" }; } },
    dataDir,
    mediaValidator: async () => ({ validatedVideos: 1 }),
  });
  await assert.rejects(service.complete(completed), (error) => error.code === "seller_artifact_integrity_failed");
});

test("CampaignCompletionService rejects a non-video artifact advertised as MP4", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "campaign-package-invalid-media-test-"));
  const service = new CampaignCompletionService({
    seller: { async downloadArtifact() { return { data: video, mediaType: "video/mp4" }; } },
    dataDir,
  });
  await assert.rejects(service.complete(campaign()), (error) => error.code === "media_invalid");
});

test("CampaignCompletionService rejects a missing paid hook variant before packaging", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "campaign-package-variant-test-"));
  const service = new CampaignCompletionService({
    seller: { async downloadArtifact() { return { data: video, mediaType: "video/mp4" }; } },
    dataDir,
  });
  const missingVariants = campaign();
  missingVariants.decision.selected.quote.addOns = {
    hookVariants: 3,
    languages: ["en"],
    aspectRatios: ["9:16"],
    inputSourceManifest: false,
  };
  await assert.rejects(
    service.complete(missingVariants),
    (error) => error.code === "deliverable_count_mismatch" && error.details.expectedVideos === 3,
  );
});
