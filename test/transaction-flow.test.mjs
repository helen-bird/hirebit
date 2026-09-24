import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BuyerService, BUYER_INITIAL_STATE } from "../src/buyer/buyer-service.mjs";
import { IntakeService, INTAKE_INITIAL_STATE } from "../src/buyer/intake-service.mjs";
import { DemoInstantWalletClient, DemoPaymentClient, DEMO_PAYMENT_INITIAL_STATE } from "../src/demo-payment.mjs";
import { JsonStore } from "../src/json-store.mjs";
import { SellerService } from "../src/seller-service.mjs";

test("a simulated Buyer-to-Seller purchase completes once without claiming Bitcoin settlement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "transaction-flow-"));
  const clock = () => 1_800_000_000_000;
  const buyerStore = new JsonStore(join(directory, "buyer.json"), { initialState: BUYER_INITIAL_STATE });
  const intakeStore = new JsonStore(join(directory, "intake.json"), { initialState: INTAKE_INITIAL_STATE });
  const sellerStore = new JsonStore(join(directory, "seller.json"));
  const paymentStore = new JsonStore(join(directory, "payments.json"), { initialState: DEMO_PAYMENT_INITIAL_STATE });
  await Promise.all([buyerStore.initialize(), intakeStore.initialize(), sellerStore.initialize(), paymentStore.initialize()]);
  const payment = new DemoPaymentClient({ store: paymentStore, clock });
  let productions = 0;
  const seller = new SellerService({
    store: sellerStore, payments: payment, clock,
    producer: {
      async readiness() { return { configured: true }; },
      async execute() {
        productions += 1;
        return { provider: "fake-offline", buildId: "build-flow-1", artifacts: [{ name: "final.mp4" }] };
      },
    },
  });
  const quote = await seller.createQuote({ productId: "proof_demo", budgetSats: 3000, sellerFeeAllowanceSats: 500 });
  const sellerClient = {
    origin: "http://seller.test",
    async health() { return { reachable: true, origin: this.origin }; },
    createOrder: (quoteId, key) => seller.createOrder({ quoteId, idempotencyKey: key }),
    syncOrder: (id) => seller.syncOrder(id),
    requestCancellation: (id) => seller.requestCancellation(id),
    retryProduction: (id) => seller.retryProduction(id),
    authorizeDemoPayment: (id) => seller.authorizeDemoPayment(id),
  };
  const wallet = new DemoInstantWalletClient({ authorizePayment: sellerClient.authorizeDemoPayment, clock, feeSats: 500 });
  let packages = 0;
  const buyer = new BuyerService({
    store: buyerStore, seller: sellerClient, wallet, clock,
    policy: {
      version: 1, maxCampaignSats: 3000, maxDailySpendSats: 60000,
      maxLifetimeSpendSats: 60000, maxPendingPayments: 1, maxPaymentFeeSats: 500, paymentsEnabled: true,
    },
    paymentFeeReserveSats: 500,
    decisionEngine: { async evaluate() { return { selected: {
      productId: quote.product.id, quote, score: 1,
    }, candidates: [] }; } },
    completer: {
      readiness() { return { configured: true }; },
      async complete() {
        packages += 1;
        return { state: "completed", files: [{ path: "manifest.json" }] };
      },
    },
  });
  const intake = new IntakeService({
    store: intakeStore, buyer, policy: { maxCampaignSats: 3000 }, clock,
    extractor: { async extract() { return {
      objective: "conversion", objectiveFamily: "conversion", objectiveConfidence: 0.95,
      budgetSats: 3000, budgetType: "hard_limit", deadlineMinutes: null, deadlineType: "none",
      decisionPriorities: { objective: 0.45, quality: 0.2, cost: 0.15, speed: 0.2 },
      authorizationMode: "auto_within_budget", autoAuthorizationExplicit: true,
      subject: "Acme launch", brief: {
        productName: "Acme", description: "Conversion video", referenceUrl: null, evidenceUrl: null,
        items: [], languages: ["en-US"], aspectRatios: ["9:16"], hookVariants: 1,
        visualMode: "product_only", voiceRequirements: [],
      }, assumptions: [], ambiguities: [], clarificationQuestions: [], evidence: [],
    }; } },
  });
  let delegation = await intake.createDelegation({
    input: {
      request: "Create an Acme conversion video with an absolute limit of 3000 sats. I have no delivery-time requirement.",
      context: { purchaseMode: "auto_within_budget" },
    }, idempotencyKey: "end-to-end-demo-delegation",
  });
  assert.equal(delegation.state, "approval_required");
  delegation = await intake.confirmMandate(delegation.id, {
    approved: true, mandateVersion: delegation.mandate.version, scopeHash: delegation.mandate.scopeHash,
  });
  let campaign = delegation.campaign;
  assert.equal(delegation.campaignId, campaign.id);
  const orderId = campaign.sellerOrder.id;
  await seller.syncOrder(orderId, { awaitProduction: true });
  delegation = await intake.syncDelegation(delegation.id);
  campaign = delegation.campaign;
  assert.equal(delegation.state, "completed");
  assert.equal(campaign.state, "completed");
  assert.equal(campaign.spentSats, quote.customerPriceSats);
  assert.equal(campaign.sellerOrder.amountSats, quote.customerPriceSats - 500);
  assert.equal(campaign.sellerOrder.payment.simulated, true);
  assert.equal(campaign.sellerOrder.payment.paidAt, null);
  assert.deepEqual(campaign.sellerOrder.payment.txids, []);
  assert.equal(productions, 1);
  assert.equal(packages, 1);
  const replay = await buyer.createCampaign({
    input: campaign.input,
    idempotencyKey: `delegation-${delegation.id}-v${delegation.mandate.version}`,
  });
  assert.equal(replay.id, campaign.id);
  assert.equal(Object.keys(paymentStore.snapshot().payments).length, 1);
  assert.equal(productions, 1);
});
