import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { AppError } from "./errors.mjs";
import { REFERENCE_VISION_PLAN_FORMAT, validateReferenceVisionPlan } from "./reference-vision-planner.mjs";

const execute = promisify(execFile);
const FORMAT = "seller.google-veo-input@1";
const LEDGER_FORMAT = "seller.google-veo-ledger@1";
const ALLOWED_MODEL = "veo-3.1-lite-generate-001";
const DEFAULT_GENERATION_WINDOW_MS = 60 * 60 * 1000;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function inside(path, root) {
  const target = resolve(path);
  const boundary = resolve(root);
  return target === boundary || target.startsWith(`${boundary}/`);
}

function safeText(value, fallback, maximum) {
  const normalized = typeof value === "string"
    ? value.replace(/https?:\/\/\S+/giu, "").replace(/\s+/gu, " ").trim()
    : "";
  return (normalized || fallback).slice(0, maximum);
}

async function readJson(path, fallback = null) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(path, value) {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function videoBytes(result) {
  const item = result?.response?.videos?.[0] ?? result?.response?.generatedVideos?.[0]?.video;
  const encoded = item?.bytesBase64Encoded ?? item?.videoBytes ?? item?.bytesBase64;
  return typeof encoded === "string" && encoded.length > 0 ? Buffer.from(encoded, "base64") : null;
}

export class GoogleVeoVideoProvider {
  constructor({
    projectId,
    location = "us-central1",
    model = ALLOWED_MODEL,
    gcloudPath = "gcloud",
    enabled = false,
    commercialUseApproved = false,
    maxGenerations = 3,
    generationWindowMs = DEFAULT_GENERATION_WINDOW_MS,
    ledgerFile,
    fetchImpl = fetch,
    tokenProvider = null,
    sleepImpl = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
    pollIntervalMs = 15_000,
    maxWaitMs = 12 * 60_000,
    clock = Date.now,
  }) {
    this.provider = "google-vertex-veo";
    this.projectId = projectId?.trim();
    this.location = location;
    this.model = model;
    this.gcloudPath = gcloudPath;
    this.enabled = enabled === true;
    this.commercialUseApproved = commercialUseApproved === true;
    this.maxGenerations = maxGenerations;
    this.generationWindowMs = generationWindowMs;
    this.ledgerFile = ledgerFile;
    this.fetchImpl = fetchImpl;
    this.tokenProvider = tokenProvider;
    this.sleepImpl = sleepImpl;
    this.pollIntervalMs = pollIntervalMs;
    this.maxWaitMs = maxWaitMs;
    this.clock = clock;
  }

  readiness() {
    const issues = [];
    if (!this.enabled) issues.push("Google Veo is disabled");
    if (!this.commercialUseApproved) issues.push("Google Veo commercial use has not been approved");
    if (!this.projectId) issues.push("Google Cloud project is missing");
    if (this.model !== ALLOWED_MODEL) issues.push("Google Veo model is not allowlisted");
    if (!Number.isSafeInteger(this.maxGenerations) || this.maxGenerations < 1 || this.maxGenerations > 10) {
      issues.push("Google Veo generation cap must be 1-10");
    }
    if (!Number.isSafeInteger(this.generationWindowMs) || this.generationWindowMs < 60_000) {
      issues.push("Google Veo generation window must be at least one minute");
    }
    if (typeof this.ledgerFile !== "string" || this.ledgerFile === "") issues.push("Google Veo ledger is missing");
    return {
      configured: issues.length === 0,
      provider: this.provider,
      model: this.model,
      location: this.location,
      maxGenerations: this.maxGenerations,
      generationWindowMinutes: Math.round(this.generationWindowMs / 60_000),
      sampleCount: 1,
      durationSeconds: 8,
      resolution: "720p",
      generateAudio: false,
      issue: issues[0] ?? null,
    };
  }

  async prepare({ jobDir, order, quote, commissionPath, productionInputs = null, referenceAdaptation = null }) {
    const readiness = this.readiness();
    if (!readiness.configured) throw new AppError("google_veo_unavailable", readiness.issue, 503);
    const outputRoot = join(jobDir, "veo-inputs");
    const manifestPath = join(outputRoot, "manifest.json");
    const receiptPath = join(outputRoot, "receipt.json");
    const outputPath = join(outputRoot, "product-motion.mp4");
    await mkdir(outputRoot, { recursive: true, mode: 0o700 });

    const commissionBytes = await readFile(commissionPath);
    const commissionSha256 = sha256(commissionBytes);
    const commission = JSON.parse(commissionBytes);
    const source = Object.values(commission.localAssets ?? {}).find((item) => item?.mediaType?.startsWith("image/"));
    if (source === undefined) return null;
    if (!inside(source.path, jobDir)) throw new AppError("production_asset_path_invalid", "Veo product image escaped the order directory", 503);
    const image = await readFile(source.path);
    if (sha256(image) !== source.sha256) throw new AppError("production_asset_digest_mismatch", "Veo product image changed after commission creation", 503);
    let referencePlan = null;
    let referenceAdaptationSha256 = null;
    if (referenceAdaptation !== null) {
      if (referenceAdaptation.format !== REFERENCE_VISION_PLAN_FORMAT
        || referenceAdaptation.orderId !== order.id
        || referenceAdaptation.productId !== quote.product.id
        || referenceAdaptation.commissionSha256 !== commissionSha256
        || referenceAdaptation.inputs?.productSha256 !== source.sha256
        || typeof referenceAdaptation.manifestSha256 !== "string") {
        throw new AppError("google_veo_reference_mismatch", "Reference guidance is not bound to this commission", 503);
      }
      referencePlan = validateReferenceVisionPlan(referenceAdaptation.plan);
      referenceAdaptationSha256 = referenceAdaptation.manifestSha256;
    }

    const existingManifest = await readJson(manifestPath);
    if (existingManifest !== null) {
      if (existingManifest.format !== FORMAT || existingManifest.orderId !== order.id
        || existingManifest.productId !== quote.product.id || existingManifest.commissionSha256 !== commissionSha256
        || existingManifest.inputImageSha256 !== source.sha256 || existingManifest.model !== this.model
        || (existingManifest.referenceAdaptationSha256 ?? null) !== referenceAdaptationSha256) {
        throw new AppError("google_veo_manifest_mismatch", "Existing Veo input is not bound to this commission", 503);
      }
      const bytes = await readFile(outputPath);
      if (sha256(bytes) !== existingManifest.output.sha256) {
        throw new AppError("google_veo_output_digest_mismatch", "Existing Veo video changed after generation", 503);
      }
      return existingManifest;
    }

    const product = safeText(quote.brief?.productName ?? quote.brief?.subject, "the supplied product", 100);
    const objective = safeText(quote.brief?.description ?? quote.brief?.objective, "show the product clearly in use", 220);
    const headline = safeText(productionInputs?.variants?.[0]?.headline, "See the useful detail", 100);
    const demonstration = referencePlan === null
      ? (quote.product.id === "proof_demo"
        ? "Show a clean hands-only demonstration with no visible face or presenter."
        : "Show a newly generated generic adult creator naturally demonstrating the product.")
      : [
        "Use a newly generated generic adult actor or hands; do not reproduce or identify the source person.",
        `Reusable subject framing: ${safeText(referencePlan.reference.subjectFraming, "product-focused creator framing", 160)}.`,
        `Reusable action choreography: ${referencePlan.reference.actionSequence
          .map((action, index) => `${index + 1}) ${safeText(action, "show the product", 120)}`).join(" ")}`,
        `Editing grammar: ${safeText(referencePlan.reference.visualGrammar, "product reveal and demonstration", 220)}.`,
        `Pacing: ${referencePlan.reference.pacing}; main transition near ${Math.round(referencePlan.reference.transitionMoment * 100)}% of the clip.`,
        `Adaptation direction: ${safeText(referencePlan.adaptation.strategy, "adapt the reference action to the supplied product", 260)}.`,
      ].join(" ");
    const prompt = [
      "Create an eight-second vertical social-commerce product video from the supplied real product image.",
      `Product: ${product}. Campaign goal: ${objective}. Creative hook: ${headline}.`,
      `Start with a clean macro product reveal. ${demonstration} Finish with a stable product hero pose.`,
      "Preserve the supplied product's visible materials, colors, proportions, packaging, and distinctive physical details.",
      "Use warm natural indoor light, subtle handheld creator movement, realistic hands, and shallow depth of field.",
      "Do not copy the source person's face, body, clothing, identity, or likeness. Do not invent brand claims, logos, labels, captions, price text, watermarks, extra products, duplicate hands, or floating objects. Keep the lower third clean for later Hypit graphics.",
    ].join(" ").slice(0, 2_500);
    const promptSha256 = sha256(Buffer.from(prompt));

    let receipt = await readJson(receiptPath);
    if (receipt === null) {
      await this.#reserve(order.id);
      receipt = {
        format: FORMAT,
        orderId: order.id,
        productId: quote.product.id,
        commissionSha256,
        inputImageSha256: source.sha256,
        referenceAdaptationSha256,
        model: this.model,
        promptSha256,
        status: "submitting",
        createdAt: new Date(this.clock()).toISOString(),
      };
      await writeJsonAtomic(receiptPath, receipt);
      let submitted;
      try {
        submitted = await this.#request("predictLongRunning", {
          instances: [{
            prompt,
            image: { bytesBase64Encoded: image.toString("base64"), mimeType: source.mediaType },
          }],
          parameters: {
            aspectRatio: "9:16",
            durationSeconds: 8,
            sampleCount: 1,
            resolution: "720p",
            resizeMode: "crop",
            personGeneration: "allow_adult",
            generateAudio: false,
            enhancePrompt: true,
          },
        });
      } catch (error) {
        receipt.status = "submission_uncertain";
        receipt.error = { code: error.code ?? "google_veo_submission_failed", message: error.message };
        await writeJsonAtomic(receiptPath, receipt);
        throw error;
      }
      if (typeof submitted?.name !== "string" || submitted.name === "") {
        receipt.status = "submission_uncertain";
        await writeJsonAtomic(receiptPath, receipt);
        throw new AppError("google_veo_submission_uncertain", "Veo returned no durable operation id; automatic resubmission is disabled", 503);
      }
      receipt.operationName = submitted.name;
      receipt.status = "submitted";
      receipt.submittedAt = new Date(this.clock()).toISOString();
      await writeJsonAtomic(receiptPath, receipt);
    }
    if (receipt.status === "submission_uncertain") {
      throw new AppError("google_veo_submission_uncertain", "Veo submission outcome is uncertain; automatic resubmission is disabled", 503);
    }
    if (typeof receipt.operationName !== "string" || receipt.operationName === "") {
      throw new AppError("google_veo_receipt_invalid", "Veo receipt has no operation id", 503);
    }

    const deadline = this.clock() + this.maxWaitMs;
    let result;
    while (this.clock() < deadline) {
      result = await this.#request("fetchPredictOperation", { operationName: receipt.operationName });
      if (result?.done) break;
      await this.sleepImpl(this.pollIntervalMs);
    }
    if (!result?.done) throw new AppError("google_veo_still_running", "Veo generation is still running and will be resumed", 409);
    if (result.error) throw new AppError("google_veo_generation_failed", "Veo generation failed", 502, { error: result.error });
    const bytes = videoBytes(result);
    if (!bytes || bytes.length < 10_000) throw new AppError("google_veo_output_invalid", "Veo returned no usable inline video", 502);
    const temporary = `${outputPath}.tmp-${process.pid}`;
    await writeFile(temporary, bytes, { mode: 0o600 });
    await rename(temporary, outputPath);
    receipt.status = "succeeded";
    receipt.completedAt = new Date(this.clock()).toISOString();
    receipt.outputSha256 = sha256(bytes);
    await writeJsonAtomic(receiptPath, receipt);
    const receiptBytes = await readFile(receiptPath);
    const manifest = {
      format: FORMAT,
      orderId: order.id,
      productId: quote.product.id,
      commissionSha256,
      inputImageSha256: source.sha256,
      referenceAdaptationSha256,
      provider: this.provider,
      model: this.model,
      promptSha256,
      receiptSha256: sha256(receiptBytes),
      output: {
        path: outputPath,
        mediaType: "video/mp4",
        sha256: sha256(bytes),
        bytes: bytes.length,
        durationSeconds: 8,
        aspectRatio: "9:16",
        resolution: "720p",
        sampleCount: 1,
        generateAudio: false,
      },
    };
    await writeJsonAtomic(manifestPath, manifest);
    return manifest;
  }

  async #token() {
    if (this.tokenProvider !== null) return await this.tokenProvider();
    const { stdout } = await execute(this.gcloudPath, ["auth", "application-default", "print-access-token"], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    const token = stdout.trim();
    if (!token) throw new AppError("google_veo_authentication_failed", "Google ADC returned no access token", 503);
    return token;
  }

  async #request(action, body) {
    const token = await this.#token();
    const endpoint = `https://${this.location}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(this.projectId)}/locations/${encodeURIComponent(this.location)}/publishers/google/models/${encodeURIComponent(this.model)}:${action}`;
    let response;
    try {
      response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (error) {
      throw new AppError("google_veo_unavailable", "Google Veo is unavailable", 503, { cause: error.message });
    }
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = { raw: text.slice(0, 2_000) }; }
    if (!response.ok) {
      throw new AppError("google_veo_request_failed", "Google Veo request failed", 502, { httpStatus: response.status, payload });
    }
    return payload;
  }

  async #reserve(orderId) {
    await mkdir(dirname(resolve(this.ledgerFile)), { recursive: true, mode: 0o700 });
    const ledger = await readJson(this.ledgerFile, { format: LEDGER_FORMAT, entries: {} });
    if (ledger.format !== LEDGER_FORMAT || ledger.entries === null || typeof ledger.entries !== "object") {
      throw new AppError("google_veo_ledger_invalid", "Google Veo usage ledger is invalid", 503);
    }
    if (ledger.entries[orderId] !== undefined) return;
    const cutoff = this.clock() - this.generationWindowMs;
    const recentReservations = Object.values(ledger.entries).filter((entry) => {
      const reservedAt = Date.parse(entry?.reservedAt);
      return !Number.isFinite(reservedAt) || reservedAt >= cutoff;
    });
    if (recentReservations.length >= this.maxGenerations) {
      const validTimes = recentReservations.map((entry) => Date.parse(entry?.reservedAt)).filter(Number.isFinite);
      const retryAt = validTimes.length === 0 ? null : new Date(Math.min(...validTimes) + this.generationWindowMs).toISOString();
      throw new AppError("google_veo_generation_cap_reached", "The hourly Google Veo generation cap has been reached", 429, {
        maxGenerations: this.maxGenerations,
        generationWindowMinutes: Math.round(this.generationWindowMs / 60_000),
        retryAt,
      });
    }
    ledger.entries[orderId] = { reservedAt: new Date(this.clock()).toISOString(), model: this.model };
    await writeJsonAtomic(this.ledgerFile, ledger);
  }
}

export const GOOGLE_VEO_MODEL = ALLOWED_MODEL;
