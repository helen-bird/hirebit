import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { calculateQuote } from "../src/catalog.mjs";
import { compileCommissionProject, decodeHypitTextJson } from "../src/hypit-commission-compiler.mjs";
import { validateCampaignDeliverables } from "../src/media-validator.mjs";
import { GoogleCloudTtsVoiceProvider, ProductionInputPreparer } from "../src/production-input-preparer.mjs";

const execFileAsync = promisify(execFile);
const rootDir = resolve(import.meta.dirname, "..");
const hypitBin = join(rootDir, "vendor/hypit/hypit");
const runtimeFile = join(rootDir, "productions/hypit.runtime.json");
const workflowFile = join(rootDir, "config/hypit-workflows.json");
const aggregateCharacterBudget = 240;
const maximumUsdPerMillionCharacters = 16;

const cases = [
  {
    productId: "creator_pitch",
    language: "en-US",
    headline: "Start with one board",
    items: ["Wi-Fi", "LED matrix", "UNO format"],
    turns: [{ role: "host_a", text: "Build smarter with UNO R4 WiFi." }],
    voiceRequirements: [{ role: "narrator", style: "warm", pace: "normal", accent: "US English" }],
  },
  {
    productId: "proof_demo",
    language: "zh-CN",
    headline: "三个可验证功能",
    items: ["无线连接", "LED 矩阵", "UNO 外形"],
    turns: [{ role: "host_a", text: "无线连接，矩阵显示，快速验证。" }],
    voiceRequirements: [{ role: "narrator", style: "calm", pace: "normal", accent: "Mandarin" }],
    visualMode: "product_only",
  },
  {
    productId: "ranking_listicle",
    language: "es-US",
    headline: "Tres razones",
    items: ["Conectividad", "Matriz LED", "Formato UNO"],
    turns: [{ role: "host_a", text: "Tres razones para crear con UNO R4 WiFi." }],
    voiceRequirements: [{ role: "narrator", style: "energetic", pace: "fast", accent: "US Spanish" }],
  },
  {
    productId: "two_person_podcast",
    language: "en-GB",
    headline: "More than Wi-Fi?",
    items: ["Two views", "Real features", "Quick verdict"],
    turns: [
      { role: "host_a", text: "Is it more than Wi-Fi?" },
      { role: "host_b", text: "Yes. It adds tools makers can test." },
    ],
    voiceRequirements: [
      { role: "host_a", style: "warm", pace: "normal", accent: "British English" },
      { role: "host_b", style: "energetic", pace: "normal", accent: "British English" },
    ],
  },
];

const requestedProducts = new Set(process.argv.slice(2));
const selectedCases = requestedProducts.size === 0
  ? cases
  : cases.filter((item) => requestedProducts.has(item.productId));
if (selectedCases.length === 0 || selectedCases.length !== requestedProducts.size) {
  throw new Error(`Unknown or duplicate production acceptance product: ${[...requestedProducts].join(", ")}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeTimestamp() {
  return new Date().toISOString().replace(/[:.]/gu, "-");
}

function parseJson(stdout, subject) {
  try { return JSON.parse(stdout); } catch {
    throw new Error(`${subject} returned invalid JSON: ${stdout.slice(-1000)}`);
  }
}

async function hypit(args, { cwd = rootDir, timeout = 630_000 } = {}) {
  const { stdout } = await execFileAsync(hypitBin, args, {
    cwd,
    env: process.env,
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  });
  return parseJson(stdout, `hypit ${args[0]}`);
}

function copyProvider() {
  return {
    async generate({ productId, languages, hookCount }) {
      const selected = cases.find((item) => item.productId === productId);
      if (selected === undefined || hookCount !== 1 || languages.length !== 1 || languages[0] !== selected.language) {
        throw new Error(`Unexpected acceptance-copy request for ${productId}`);
      }
      const voiceScript = selected.turns.map((turn) => turn.text).join(" ");
      return {
        provider: "production-acceptance-fixture",
        model: null,
        value: {
          variants: [{
            hookIndex: 1,
            language: selected.language,
            headline: selected.headline,
            items: selected.items,
            voiceScript,
            speakerTurns: selected.turns,
          }],
        },
      };
    },
  };
}

const plannedCharacters = selectedCases.reduce((sum, item) => (
  sum + item.turns.reduce((turnSum, turn) => turnSum + [...turn.text].length, 0)
), 0);
if (plannedCharacters > aggregateCharacterBudget) {
  throw new Error(`Acceptance scripts contain ${plannedCharacters} characters; budget is ${aggregateCharacterBudget}`);
}
if (process.env.GOOGLE_TTS_COMMERCIAL_USE_APPROVED !== "1") {
  throw new Error("GOOGLE_TTS_COMMERCIAL_USE_APPROVED=1 is required for production acceptance");
}

const workflows = JSON.parse(await readFile(workflowFile, "utf8"));
const runRoot = join(rootDir, ".seller", "production-validation", safeTimestamp());
await mkdir(runRoot, { recursive: true, mode: 0o700 });

const voiceProvider = new GoogleCloudTtsVoiceProvider({
  projectId: process.env.GOOGLE_CLOUD_PROJECT,
  commercialUseApproved: true,
  maxCharactersPerOrder: aggregateCharacterBudget,
});
const preparer = new ProductionInputPreparer({ copyProvider: copyProvider(), voiceProvider });
const results = [];

await hypit(["runtime", "up", "--workspace", join(rootDir, "productions"), "--runtime", runtimeFile, "--json"], { timeout: 120_000 });
try {
  for (const item of selectedCases) {
    const workflow = workflows[item.productId];
    const jobDir = join(runRoot, item.productId);
    const outputDir = join(jobDir, "outputs");
    await mkdir(outputDir, { recursive: true, mode: 0o700 });
    const quote = calculateQuote({
      productId: item.productId,
      productionMode: "original",
      brief: {
        productName: "Arduino UNO R4 WiFi",
        description: "Short production acceptance fixture using documented product capabilities.",
        visualMode: item.visualMode ?? "package_default",
        voiceRequirements: item.voiceRequirements,
      },
      addOns: { hookVariants: 1, languages: [item.language], aspectRatios: ["9:16"] },
    });
    const order = {
      id: `accept-${item.productId}-${Date.now()}`,
      amountSats: quote.amountSats,
      state: "paid",
      payment: { authorization: "authorized", settlement: "acceptance-only" },
    };
    const commissionPath = join(jobDir, "commission.json");
    await writeFile(commissionPath, `${JSON.stringify({ order, quote, localAssets: {} }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    const productionInputs = await preparer.prepare({ jobDir, order, quote, commissionPath });
    const manifest = await compileCommissionProject({
      rootDir, jobDir, workflow, order, quote, commissionPath, productionInputs,
    });
    const projectDir = join(jobDir, manifest.projectDirectory);
    const runPath = join(projectDir, manifest.run);
    await hypit(["check", runPath, "--workspace", projectDir, "--json"], { cwd: projectDir, timeout: 120_000 });
    const plan = await hypit(["plan", runPath, "--workspace", projectDir, "--runtime", runtimeFile, "--json"], { cwd: projectDir, timeout: 120_000 });
    if (plan.ok === false || Number(plan.requestIssueCount ?? 0) > 0) {
      throw new Error(`${item.productId} Hypit plan contains unresolved requests`);
    }
    const built = await hypit([
      "build", runPath,
      "--workspace", projectDir,
      "--runtime", runtimeFile,
      "--title", `acceptance-${item.productId}`,
      "--follow", "--max-wait-ms", "600000", "--json",
    ], { cwd: projectDir });
    const build = built.build ?? built;
    const buildId = build.id;
    if (typeof buildId !== "string" || buildId === "" || build.work?.outcome !== "complete") {
      throw new Error(`${item.productId} Build did not complete`);
    }
    const video = manifest.deliverables.find((deliverable) => deliverable.mediaType === "video/mp4");
    const videoPath = join(outputDir, video.filename);
    await hypit(["get", buildId, "--output", video.output, "--to", videoPath, "--workspace", projectDir, "--json"], { cwd: projectDir, timeout: 300_000 });
    const receiptDir = join(outputDir, "commission-receipt");
    await hypit(["get", buildId, "--output", manifest.commissionReceiptOutput, "--to", receiptDir, "--workspace", projectDir, "--json"], { cwd: projectDir, timeout: 300_000 });
    const receiptEnvelope = JSON.parse(await readFile(join(receiptDir, "value.json"), "utf8"));
    const receipt = decodeHypitTextJson(receiptEnvelope?.value?.value, "commission receipt");
    const commissionSha256 = sha256(await readFile(commissionPath));
    if (receipt.orderId !== order.id || receipt.productId !== item.productId || receipt.commissionSha256 !== commissionSha256
      || receipt.productionInputs?.manifestSha256 !== productionInputs.manifestSha256) {
      throw new Error(`${item.productId} commission receipt is not bound to the validation order`);
    }
    const files = [{ ...video, name: video.filename, absolutePath: videoPath }];
    const media = await validateCampaignDeliverables({ files, quote });
    const result = {
      productId: item.productId,
      buildId,
      language: item.language,
      billableCharacters: productionInputs.voice.billableCharacters,
      voices: productionInputs.variants.flatMap((variant) => variant.audio.map((audio) => ({
        role: audio.role,
        voiceId: audio.voiceId,
        appliedVoice: audio.appliedVoice,
      }))),
      video: {
        path: videoPath,
        sha256: files[0].validation.sha256,
        durationSeconds: files[0].validation.durationSeconds,
        width: files[0].validation.width,
        height: files[0].validation.height,
        audio: files[0].validation.audio,
        visual: files[0].validation.visual,
      },
      mediaAcceptance: media,
      receiptBound: true,
    };
    results.push(result);
    await writeFile(join(jobDir, "acceptance-result.json"), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  }
} finally {
  await hypit(["runtime", "down", "--workspace", join(rootDir, "productions"), "--runtime", runtimeFile, "--json"], { timeout: 120_000 }).catch(() => {});
}

const billableCharacters = results.reduce((sum, result) => sum + result.billableCharacters, 0);
const summary = {
  format: "seller.production-acceptance@1",
  completedAt: new Date().toISOString(),
  result: "passed",
  scope: `${selectedCases.map((item) => item.productId).join(", ")} single-variant production acceptance with real Google Cloud TTS and local Hypit renders`,
  costControl: {
    aggregateCharacterBudget,
    plannedCharacters,
    billableCharacters,
    maximumUsdPerMillionCharacters,
    maximumEstimatedTtsCostUsd: Number(((billableCharacters / 1_000_000) * maximumUsdPerMillionCharacters).toFixed(6)),
    deepSeekCalls: 0,
  },
  results,
};
const summaryPath = join(runRoot, "summary.json");
await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600, flag: "wx" });
console.log(JSON.stringify({ summaryPath, ...summary }, null, 2));
