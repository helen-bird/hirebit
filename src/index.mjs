import { resolve } from "node:path";
import { readFile } from "node:fs/promises";

import { GoBtcPayClient } from "./gobtcpay.mjs";
import { GoogleVeoVideoProvider } from "./google-veo-video-provider.mjs";
import { DemoPaymentClient, DEMO_PAYMENT_INITIAL_STATE } from "./demo-payment.mjs";
import { DockerHypitRunner } from "./docker-hypit-runner.mjs";
import { HypitAdapter } from "./hypit-adapter.mjs";
import { DeepSeekReferenceVisionProvider } from "./reference-vision-planner.mjs";
import {
  DeepSeekProductionCopyProvider,
  GoogleCloudTtsVoiceProvider,
  MacOsSayVoiceProvider,
  ProductionInputPreparer,
} from "./production-input-preparer.mjs";
import { acquireProcessLock, JsonStore } from "./json-store.mjs";
import { SellerService } from "./seller-service.mjs";
import { createSellerServer } from "./server.mjs";
import { loadOrCreateToken } from "./security.mjs";

const rootDir = resolve(import.meta.dirname, "..");
const dataDir = resolve(rootDir, process.env.SELLER_DATA_DIR ?? ".seller");
const processLock = await acquireProcessLock(resolve(dataDir, "seller-process.lock"));
const apiToken = await loadOrCreateToken({
  environmentValue: process.env.SELLER_API_TOKEN,
  file: resolve(dataDir, "api-token"),
});
const store = new JsonStore(resolve(dataDir, process.env.SELLER_STATE_FILE ?? "state.json"));
await store.initialize();
const spendAllowed = async (orderId) => {
  const order = store.snapshot().orders?.[orderId];
  return order !== undefined && order.cancellation?.state == null;
};

async function merchantApiKey() {
  if (process.env.GOBTCPAY_MERCHANT_API_KEY) return process.env.GOBTCPAY_MERCHANT_API_KEY;
  try {
    const secret = JSON.parse(await readFile(resolve(dataDir, "merchant-secrets.json"), "utf8"));
    return secret.merchantApiKey;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return undefined;
  }
}

const paymentMode = process.env.PAYMENT_MODE ?? "gobtcpay";
if (!new Set(["gobtcpay", "demo"]).has(paymentMode)) throw new Error(`Unsupported PAYMENT_MODE: ${paymentMode}`);
let payments;
if (paymentMode === "demo") {
  const demoPaymentStore = new JsonStore(resolve(dataDir, process.env.DEMO_PAYMENT_STATE_FILE ?? "demo-payments.json"), {
    initialState: DEMO_PAYMENT_INITIAL_STATE,
  });
  await demoPaymentStore.initialize();
  payments = new DemoPaymentClient({ store: demoPaymentStore });
} else {
  payments = new GoBtcPayClient({
    baseUrl: process.env.GOBTCPAY_BASE_URL ?? "https://api.gobtcpay.com/public/api/v1.2",
    merchantApiKey: await merchantApiKey(),
  });
}
const configuredVoiceProvider = process.env.SELLER_VOICE_PROVIDER ?? "google-cloud-tts";
if (!["google-cloud-tts", "macos-say-acceptance"].includes(configuredVoiceProvider)) {
  throw new Error(`Unsupported SELLER_VOICE_PROVIDER: ${configuredVoiceProvider}`);
}
const voiceProvider = configuredVoiceProvider === "macos-say-acceptance"
  ? new MacOsSayVoiceProvider()
  : new GoogleCloudTtsVoiceProvider({
    projectId: process.env.GOOGLE_CLOUD_PROJECT,
    commercialUseApproved: process.env.GOOGLE_TTS_COMMERCIAL_USE_APPROVED === "1",
    maxCharactersPerOrder: Number(process.env.GOOGLE_TTS_MAX_CHARACTERS_PER_ORDER ?? 20_000),
  });
const inputPreparer = new ProductionInputPreparer({
  spendAllowed,
  copyProvider: new DeepSeekProductionCopyProvider({
    baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
    model: process.env.DEEPSEEK_MODEL ?? "deepseek-flash",
  }),
  voiceProvider,
});
const videoProvider = new GoogleVeoVideoProvider({
  spendAllowed,
  projectId: process.env.GOOGLE_CLOUD_PROJECT,
  location: process.env.GOOGLE_VEO_LOCATION ?? "us-central1",
  model: process.env.GOOGLE_VEO_MODEL ?? "veo-3.1-lite-generate-001",
  gcloudPath: process.env.GOOGLE_CLOUD_CLI_PATH ?? "gcloud",
  enabled: process.env.GOOGLE_VEO_ENABLED === "1",
  commercialUseApproved: process.env.GOOGLE_VEO_COMMERCIAL_USE_APPROVED === "1",
  maxGenerations: Number(process.env.GOOGLE_VEO_MAX_GENERATIONS ?? 20),
  ledgerFile: resolve(dataDir, "google-veo-ledger.json"),
});
const referenceVisionProvider = new DeepSeekReferenceVisionProvider({
  baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
  model: process.env.DEEPSEEK_MODEL ?? "deepseek-flash",
});
const workerMode = process.env.HYPIT_WORKER_MODE ?? "host-sandbox";
if (!new Set(["host-sandbox", "docker"]).has(workerMode)) {
  throw new Error(`Unsupported HYPIT_WORKER_MODE: ${workerMode}`);
}
const dockerRunner = workerMode === "docker" ? new DockerHypitRunner({
  dataDir,
  dockerBin: process.env.DOCKER_BIN ?? "/usr/local/bin/docker",
  image: process.env.HYPIT_WORKER_IMAGE ?? "agentic-hypit-worker:local",
  ...(process.env.HYPIT_WORKER_ATTESTATION_FILE ? {
    attestationFile: resolve(rootDir, process.env.HYPIT_WORKER_ATTESTATION_FILE),
  } : {}),
}) : null;
const dockerIsolation = dockerRunner === null ? null : await dockerRunner.isolationStatus();
const isolationVerified = workerMode === "docker"
  && process.env.HYPIT_WORKER_ISOLATION_VERIFIED === "1"
  && dockerIsolation?.verified === true;
const producer = new HypitAdapter({
  spendAllowed,
  rootDir,
  dataDir,
  workflowFile: process.env.SELLER_HYPIT_WORKFLOWS ?? "config/hypit-workflows.json",
  hypitBin: process.env.HYPIT_BIN ?? "vendor/hypit/hypit",
  isolationVerified,
  protectedPaths: [
    resolve(rootDir, process.env.BUYER_DATA_DIR ?? ".buyer"),
    resolve(rootDir, process.env.GOBTCPAY_PAYER_KEY_FILE ?? ".gobtcpay/payer-key.pem"),
    resolve(rootDir, process.env.BUYER_POLICY_FILE ?? "config/buyer-policy.json"),
  ],
  ...(dockerRunner === null ? {} : { commandRunner: dockerRunner }),
  inputPreparer,
  videoProvider,
  referenceVisionProvider,
  mediaBinDir: process.env.HYPIT_MEDIA_BIN_DIR ?? null,
  ...(typeof process.env.PUBLIC_DEMO_ORIGIN === "string" ? {
    trustedUploadOrigin: process.env.PUBLIC_DEMO_ORIGIN,
    trustedUploadDirectory: resolve(rootDir, process.env.BUYER_DATA_DIR ?? ".buyer", "uploads"),
  } : {}),
});
const maxConcurrentProductions = Number(process.env.SELLER_MAX_CONCURRENT_PRODUCTIONS ?? 1);
const service = new SellerService({
  store,
  payments,
  producer,
  maxConcurrentProductions: Number.isSafeInteger(maxConcurrentProductions) && maxConcurrentProductions > 0
    ? maxConcurrentProductions
    : 1,
});
const pollInterval = Number(process.env.SELLER_POLL_INTERVAL_MS ?? 5000);

const allowedHostnames = new Set((process.env.SELLER_ALLOWED_HOSTS ?? "127.0.0.1,localhost,::1")
  .split(",").map((item) => item.trim().toLowerCase()).filter(Boolean));
const server = createSellerServer({ service, dataDir, apiToken: apiToken.value, allowedHostnames });
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8787);
server.listen(port, host, () => {
  console.log(`Hypit Video Seller listening on http://${host}:${port}`);
  if (paymentMode === "demo") console.log("DEMO PAYMENT MODE: no Bitcoin is transferred and no GoBTC API is called");
  if (apiToken.source !== "environment") console.log(`Seller API token is stored in ${apiToken.source}`);
});
void service.recover().finally(() => {
  service.startPolling(Number.isFinite(pollInterval) && pollInterval >= 1000 ? pollInterval : 5000);
});

function shutdown() {
  service.stopPolling();
  server.close(() => {
    void processLock.release().finally(() => process.exit(0));
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
