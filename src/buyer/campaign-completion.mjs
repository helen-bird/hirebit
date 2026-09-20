import { createHash } from "node:crypto";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { AppError } from "../errors.mjs";
import { validateCampaignDeliverables } from "../media-validator.mjs";

function safeName(value) {
  return basename(value).replace(/[^a-zA-Z0-9._-]/gu, "-").slice(0, 160) || "artifact.bin";
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

async function atomicWrite(file, data, mode = 0o600) {
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, data, { mode });
  await rename(temporary, file);
}

function fileUrl(campaignId, path) {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `/v1/campaigns/${encodeURIComponent(campaignId)}/package/files/${encoded}`;
}

function strategy(objective, index) {
  const strategies = {
    conversion: ["Pain → proof → CTA", "Outcome-first proof", "Offer and urgency"],
    direct_response: ["Problem-led CTA", "Benefit-led CTA", "Objection-led CTA"],
    comparison: ["Category ranking", "Feature contrast", "Best-for-use-case"],
    social_proof: ["Peer validation", "Objection handling", "Authority signal"],
    product_education: ["Core workflow", "Feature proof", "Before and after"],
  };
  const selected = strategies[objective] ?? ["Primary angle", "Alternative angle", "Proof angle"];
  return selected[index % selected.length];
}

function fallbackTestingPlan(campaign, creativeFiles, advisorError = null) {
  return {
    objective: campaign.input.objective,
    method: "deterministic_fallback",
    recommendation: "Test in priority order, keep audience and spend constant, then scale the strongest signal.",
    variants: creativeFiles.map((file, index) => ({
      priority: index + 1,
      file: file.name,
      strategy: strategy(campaign.input.objectiveFamily ?? campaign.input.objective, index),
      hypothesis: "This creative angle will produce a measurable signal against the campaign objective.",
      primaryMetric: campaign.input.objective === "conversion" ? "conversion rate" : "qualified engagement rate",
    })),
    advisorError,
  };
}

function markdown(summary, testingPlan, paymentProof, creativeFiles) {
  const lines = [
    `# ${summary.subject ?? "Campaign"} — Campaign Package`,
    "",
    `- Objective: ${summary.objective}`,
    `- Selected package: ${summary.selectedProduct.name}`,
    `- Spend: ${summary.spend.spentSats} sats`,
    `- Remaining budget: ${summary.spend.remainingBudgetSats} sats`,
    `- Payment authorization: ${paymentProof.authorization}`,
    `- Settlement: ${paymentProof.settlement}`,
    `- Payment mode: ${paymentProof.mode}`,
    "",
    "## Why this package",
    "",
    summary.decisionRationale,
    "",
    "## Creative testing order",
    "",
    ...testingPlan.variants.map((item) => (
      `${item.priority}. **${item.file}** — ${item.strategy}; hypothesis: ${item.hypothesis}; primary metric: ${item.primaryMetric}`
    )),
    "",
    "## Deliverables",
    "",
    ...creativeFiles.map((item) => `- [${item.name}](${item.url})`),
    "",
    "## Payment proof",
    "",
    `- GoBTC payment ID: ${paymentProof.paymentId ?? "pending"}`,
    `- Instant receipt: ${paymentProof.instantReceiptId ?? "pending"}`,
    `- On-chain txids: ${paymentProof.txids.length > 0 ? paymentProof.txids.join(", ") : "pending settlement"}`,
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function paymentProofFor(campaign) {
  const order = campaign.sellerOrder;
  const payment = order?.payment ?? {};
  const simulated = payment.simulated === true || campaign.paymentAttempt?.receipt?.simulated === true;
  return {
    paymentId: payment.id ?? null,
    instantReceiptId: campaign.paymentAttempt?.receipt?.instantReceiptId ?? null,
    authorization: payment.authorization ?? "pending",
    settlement: payment.settlement ?? "pending",
    paidAt: payment.paidAt ?? null,
    txids: payment.txids ?? [],
    amountSats: order?.amountSats ?? null,
    networkFeeSats: campaign.networkFeeSats ?? campaign.paymentAttempt?.prepared?.validation?.feeSats ?? 0,
    totalDebitSats: campaign.spentSats,
    mode: simulated ? "demo_simulated" : (payment.mode ?? "gobtcpay_mainnet"),
    simulated,
    mainnet: !simulated,
    note: simulated
      ? "DEMO ONLY: no Bitcoin was transferred, no GoBTC API was called, and no on-chain proof exists"
      : "instantReceiptId is a platform receipt; only txids are on-chain transaction IDs",
  };
}

export class CampaignCompletionService {
  constructor({ seller, dataDir, advisor = null, clock = Date.now, mediaValidator = validateCampaignDeliverables }) {
    this.seller = seller;
    this.dataDir = dataDir;
    this.advisor = advisor;
    this.clock = clock;
    this.mediaValidator = mediaValidator;
  }

  readiness() {
    return { configured: true, outputRoot: "campaign-packages" };
  }

  packageDirectory(campaignId) {
    return resolve(this.dataDir, "campaign-packages", safeName(campaignId));
  }

  async complete(campaign) {
    const order = campaign.sellerOrder;
    if (order?.state !== "completed" || order.production?.state !== "completed") {
      throw new AppError("fulfillment_not_complete", "Campaign package requires completed Seller fulfillment", 409);
    }
    const artifacts = order.production.result?.artifacts ?? [];
    if (artifacts.length === 0) throw new AppError("fulfillment_has_no_artifacts", "Seller returned no campaign artifacts", 502);

    const root = this.packageDirectory(campaign.id);
    const creativeDir = join(root, "creatives");
    await mkdir(creativeDir, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    await chmod(creativeDir, 0o700);
    const creativeFiles = [];
    const usedNames = new Set();
    for (const [index, artifact] of artifacts.entries()) {
      let name = safeName(artifact.name);
      if (usedNames.has(name)) name = `${index + 1}-${name}`;
      usedNames.add(name);
      const downloaded = await this.seller.downloadArtifact(order.id, artifact.name);
      const path = `creatives/${name}`;
      await atomicWrite(join(root, path), downloaded.data);
      creativeFiles.push({
        name,
        path,
        url: fileUrl(campaign.id, path),
        mediaType: artifact.mediaType ?? downloaded.mediaType,
        bytes: downloaded.data.byteLength,
        sha256: sha256(downloaded.data),
        specification: artifact.specification ?? null,
        absolutePath: join(root, path),
      });
    }

    const quote = campaign.decision.selected.quote;
    const deliveryValidation = await this.mediaValidator({ files: creativeFiles, quote });
    for (const file of creativeFiles) delete file.absolutePath;
    const summary = {
      campaignId: campaign.id,
      generatedAt: new Date(this.clock()).toISOString(),
      subject: campaign.input.brief?.productName ?? campaign.input.brief?.description ?? null,
      objective: campaign.input.objective,
      selectedProduct: { id: quote.product.id, name: quote.product.name },
      decisionRationale: campaign.decision.rationale,
      decisionScore: campaign.decision.selected.score,
      spend: {
        budgetSats: campaign.input.budgetSats,
        invoiceSats: campaign.invoiceSpentSats ?? order.amountSats,
        networkFeeSats: campaign.networkFeeSats ?? 0,
        spentSats: campaign.spentSats,
        remainingBudgetSats: campaign.remainingBudgetSats,
      },
      fulfillment: {
        provider: order.production.result.provider,
        buildId: order.production.result.buildId,
        artifactCount: creativeFiles.length,
        validation: deliveryValidation,
      },
    };
    const paymentProof = paymentProofFor(campaign);
    let testingPlan = fallbackTestingPlan(campaign, creativeFiles);
    if (this.advisor !== null) {
      try {
        testingPlan = await this.advisor.createTestingPlan({ campaign, creativeFiles });
      } catch (error) {
        testingPlan = fallbackTestingPlan(campaign, creativeFiles, {
          code: error.code ?? "creative_advisor_failed",
          message: error.message,
        });
      }
    }

    const documents = [
      { name: "summary.json", mediaType: "application/json", content: `${JSON.stringify(summary, null, 2)}\n` },
      { name: "payment-proof.json", mediaType: "application/json", content: `${JSON.stringify(paymentProof, null, 2)}\n` },
      { name: "testing-plan.json", mediaType: "application/json", content: `${JSON.stringify(testingPlan, null, 2)}\n` },
    ];
    documents.push({
      name: "campaign-report.md",
      mediaType: "text/markdown; charset=utf-8",
      content: markdown(summary, testingPlan, paymentProof, creativeFiles),
    });
    const documentFiles = [];
    for (const document of documents) {
      const data = Buffer.from(document.content, "utf8");
      await atomicWrite(join(root, document.name), data);
      documentFiles.push({
        name: document.name,
        path: document.name,
        url: fileUrl(campaign.id, document.name),
        mediaType: document.mediaType,
        bytes: data.byteLength,
        sha256: sha256(data),
      });
    }
    const manifest = {
      version: 1,
      campaignId: campaign.id,
      generatedAt: summary.generatedAt,
      files: [...documentFiles, ...creativeFiles],
    };
    const manifestData = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await atomicWrite(join(root, "manifest.json"), manifestData);
    const manifestFile = {
      name: "manifest.json",
      path: "manifest.json",
      url: fileUrl(campaign.id, "manifest.json"),
      mediaType: "application/json",
      bytes: manifestData.byteLength,
      sha256: sha256(manifestData),
    };
    return {
      state: "completed",
      generatedAt: summary.generatedAt,
      summary,
      paymentProof,
      testingPlan,
      files: [manifestFile, ...documentFiles, ...creativeFiles],
    };
  }

  async refreshPaymentProof(campaign, campaignPackage) {
    if (campaignPackage?.state !== "completed") throw new AppError("package_not_ready", "Campaign package is not complete", 409);
    const root = this.packageDirectory(campaign.id);
    const next = structuredClone(campaignPackage);
    const paymentProof = paymentProofFor(campaign);
    const proofData = Buffer.from(`${JSON.stringify(paymentProof, null, 2)}\n`, "utf8");
    await atomicWrite(join(root, "payment-proof.json"), proofData);
    const proofEntry = next.files.find((item) => item.path === "payment-proof.json");
    Object.assign(proofEntry, { bytes: proofData.byteLength, sha256: sha256(proofData) });
    next.paymentProof = paymentProof;

    const creativeFiles = next.files.filter((item) => item.path.startsWith("creatives/"));
    const reportData = Buffer.from(markdown(next.summary, next.testingPlan, paymentProof, creativeFiles), "utf8");
    await atomicWrite(join(root, "campaign-report.md"), reportData);
    const reportEntry = next.files.find((item) => item.path === "campaign-report.md");
    Object.assign(reportEntry, { bytes: reportData.byteLength, sha256: sha256(reportData) });

    next.settlementUpdatedAt = new Date(this.clock()).toISOString();
    const manifestEntry = next.files.find((item) => item.path === "manifest.json");
    const manifest = {
      version: 1,
      campaignId: campaign.id,
      generatedAt: next.generatedAt,
      settlementUpdatedAt: next.settlementUpdatedAt,
      files: next.files.filter((item) => item.path !== "manifest.json"),
    };
    const manifestData = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await atomicWrite(join(root, "manifest.json"), manifestData);
    Object.assign(manifestEntry, { bytes: manifestData.byteLength, sha256: sha256(manifestData) });
    return next;
  }
}
