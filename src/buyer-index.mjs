import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { BuyerService, BUYER_INITIAL_STATE } from "./buyer/buyer-service.mjs";
import { CampaignCompletionService } from "./buyer/campaign-completion.mjs";
import { DeepSeekCreativeAdvisor } from "./buyer/creative-advisor.mjs";
import { DecisionEngine } from "./buyer/decision-engine.mjs";
import { InstantWalletClient } from "./buyer/instant-wallet.mjs";
import { DemoInstantWalletClient } from "./demo-payment.mjs";
import { IntakeService, INTAKE_INITIAL_STATE } from "./buyer/intake-service.mjs";
import { DeepSeekMandateExtractor } from "./buyer/mandate-extractor.mjs";
import { SellerClient } from "./buyer/seller-client.mjs";
import { createBuyerServer } from "./buyer/server.mjs";
import { acquireProcessLock, JsonStore } from "./json-store.mjs";
import { loadOrCreateToken, resolvePublicDemoAccessToken } from "./security.mjs";

const rootDir = resolve(import.meta.dirname, "..");
const dataDir = resolve(rootDir, process.env.BUYER_DATA_DIR ?? ".buyer");
const processLock = await acquireProcessLock(resolve(dataDir, "buyer-process.lock"));
const policyFile = resolve(rootDir, process.env.BUYER_POLICY_FILE ?? "config/buyer-policy.json");
const policy = JSON.parse(await readFile(policyFile, "utf8"));
const paymentMode = process.env.PAYMENT_MODE ?? "gobtcpay";
if (!new Set(["gobtcpay", "demo"]).has(paymentMode)) throw new Error(`Unsupported PAYMENT_MODE: ${paymentMode}`);
const publicDemoEnabled = process.env.PUBLIC_DEMO_MODE === "1";
if (paymentMode === "gobtcpay" && !/^(02|03)[a-fA-F0-9]{64}$/.test(process.env.GOBTCPAY_PAYER_PUBLIC_KEY ?? "")) {
  throw new Error("GOBTCPAY_PAYER_PUBLIC_KEY must be the registered compressed payer public key");
}
if (publicDemoEnabled && paymentMode !== "demo") {
  throw new Error("PUBLIC_DEMO_MODE requires PAYMENT_MODE=demo; real Bitcoin payments may never be exposed publicly");
}
const apiToken = resolvePublicDemoAccessToken({
  enabled: publicDemoEnabled,
  paymentMode,
  value: process.env.PUBLIC_DEMO_ACCESS_TOKEN,
}) ?? await loadOrCreateToken({
  environmentValue: process.env.BUYER_API_TOKEN,
  file: resolve(dataDir, process.env.BUYER_API_TOKEN_FILE ?? "api-token"),
});
const sellerApiToken = await loadOrCreateToken({
  environmentValue: process.env.BUYER_SELLER_API_TOKEN ?? process.env.SELLER_API_TOKEN,
  file: resolve(rootDir, process.env.SELLER_DATA_DIR ?? ".seller", "api-token"),
});

const seller = new SellerClient({
  baseUrl: process.env.BUYER_SELLER_BASE_URL ?? policy.sellerBaseUrl,
  allowedOrigins: policy.allowedSellerOrigins,
  apiToken: sellerApiToken.value,
});
const wallet = paymentMode === "demo"
  ? new DemoInstantWalletClient({
    authorizePayment: (paymentId) => seller.authorizeDemoPayment(paymentId),
  })
  : new InstantWalletClient({
    baseUrl: process.env.GOBTCPAY_BASE_URL ?? "https://api.gobtcpay.com/public/api/v1.2",
    keyFile: resolve(rootDir, process.env.GOBTCPAY_PAYER_KEY_FILE ?? ".gobtcpay/payer-key.pem"),
    expectedPublicKeyHex: process.env.GOBTCPAY_PAYER_PUBLIC_KEY,
    multisigAddress: process.env.GOBTCPAY_BUYER_MULTISIG_ADDRESS,
    maxFeeSats: policy.maxPaymentFeeSats,
    maxFeeRateSatVb: policy.maxFeeRateSatVb,
  });
const store = new JsonStore(resolve(dataDir, process.env.BUYER_STATE_FILE ?? "state.json"), {
  initialState: BUYER_INITIAL_STATE,
});
await store.initialize();
const creativeAdvisor = new DeepSeekCreativeAdvisor({
  baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
  model: process.env.DEEPSEEK_MODEL ?? "deepseek-flash",
});
const paymentFeeReserveSats = paymentMode === "demo" ? 0 : policy.maxPaymentFeeSats;
const decisionEngine = new DecisionEngine({ seller, policy, advisor: creativeAdvisor, paymentFeeReserveSats });
const completer = new CampaignCompletionService({ seller, dataDir, advisor: creativeAdvisor });
const service = new BuyerService({
  store,
  seller,
  wallet,
  decisionEngine,
  completer,
  policy,
  paymentFeeReserveSats,
  policyLoader: async () => JSON.parse(await readFile(policyFile, "utf8")),
});
await service.recover();
const intakeStore = new JsonStore(resolve(dataDir, process.env.BUYER_INTAKE_STATE_FILE ?? "intake-state.json"), {
  initialState: INTAKE_INITIAL_STATE,
});
await intakeStore.initialize();
const extractor = new DeepSeekMandateExtractor({
  schemaFile: resolve(rootDir, "config/delegation-extraction.schema.json"),
  baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
  model: process.env.DEEPSEEK_MODEL ?? "deepseek-flash",
});
const intake = new IntakeService({
  store: intakeStore,
  extractor,
  buyer: service,
  policy,
  allowExternalUrls: !publicDemoEnabled,
  referenceUploadBaseUrl: publicDemoEnabled ? process.env.PUBLIC_DEMO_ORIGIN : null,
});
await intake.recover();
const pollInterval = Number(process.env.BUYER_POLL_INTERVAL_MS ?? policy.pollIntervalMs ?? 5000);
service.startPolling(Number.isFinite(pollInterval) && pollInterval >= 1000 ? pollInterval : 5000);

const host = process.env.BUYER_HOST ?? "127.0.0.1";
const port = Number(process.env.BUYER_PORT ?? 8788);
const allowedHostnames = new Set((process.env.BUYER_ALLOWED_HOSTS ?? "127.0.0.1,localhost,::1")
  .split(",").map((item) => item.trim().toLowerCase()).filter(Boolean));
const publicDemo = publicDemoEnabled ? {
  enabled: true,
  publicOrigin: process.env.PUBLIC_DEMO_ORIGIN,
  maxDelegations: Number(process.env.PUBLIC_DEMO_MAX_DELEGATIONS_PER_HOUR
    ?? process.env.PUBLIC_DEMO_MAX_DELEGATIONS
    ?? 3),
  maxRequestChars: Number(process.env.PUBLIC_DEMO_MAX_REQUEST_CHARS ?? 1000),
  maxMutationsPerMinute: Number(process.env.PUBLIC_DEMO_MAX_MUTATIONS_PER_MINUTE ?? 30),
} : { enabled: false };
if (publicDemoEnabled && (!Number.isSafeInteger(publicDemo.maxDelegations) || publicDemo.maxDelegations < 1 || publicDemo.maxDelegations > 10)) {
  throw new Error("PUBLIC_DEMO_MAX_DELEGATIONS_PER_HOUR must be an integer from 1 to 10");
}
if (publicDemoEnabled && (!Number.isSafeInteger(publicDemo.maxRequestChars) || publicDemo.maxRequestChars < 100 || publicDemo.maxRequestChars > 2000)) {
  throw new Error("PUBLIC_DEMO_MAX_REQUEST_CHARS must be an integer from 100 to 2000");
}
if (publicDemoEnabled && (!Number.isSafeInteger(publicDemo.maxMutationsPerMinute)
  || publicDemo.maxMutationsPerMinute < 1 || publicDemo.maxMutationsPerMinute > 60)) {
  throw new Error("PUBLIC_DEMO_MAX_MUTATIONS_PER_MINUTE must be an integer from 1 to 60");
}
const server = createBuyerServer({
  service,
  intake,
  dataDir,
  webDir: resolve(rootDir, "web"),
  demoProductImagePath: resolve(rootDir, "product_pic.jpeg"),
  apiToken: apiToken.value,
  allowedHostnames,
  publicDemo,
});
server.listen(port, host, () => {
  console.log(`Autonomous Video Buyer listening on http://${host}:${port}`);
  if (paymentMode === "demo") console.log("DEMO PAYMENT MODE: no Bitcoin is transferred and no GoBTC API is called");
  if (publicDemoEnabled) console.log(`RESTRICTED PUBLIC DEMO: ${publicDemo.maxDelegations} delegations per rolling hour, only validated reference-video URLs allowed`);
  if (apiToken.source !== "environment") console.log(`Buyer Console access token is stored in ${apiToken.source}`);
});

function shutdown() {
  service.stopPolling();
  server.close(() => {
    void processLock.release().finally(() => process.exit(0));
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
