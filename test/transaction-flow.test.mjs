import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BuyerService, BUYER_INITIAL_STATE } from "../src/buyer/buyer-service.mjs";
import { DemoInstantWalletClient, DemoPaymentClient, DEMO_PAYMENT_INITIAL_STATE } from "../src/demo-payment.mjs";
import { JsonStore } from "../src/json-store.mjs";
import { SellerService } from "../src/seller-service.mjs";

test("a simulated Buyer-to-Seller purchase completes once without claiming Bitcoin settlement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "transaction-flow-"));
  const clock = () => 1_800_000_000_000;
  const buyerStore = new JsonStore(join(directory, "buyer.json"), { initialState: BUYER_INITIAL_STATE });
  const sellerStore = new JsonStore(join(directory, "seller.json"));
  const paymentStore = new JsonStore(join(directory, "payments.json"), { initialState: DEMO_PAYMENT_INITIAL_STATE });
  await Promise.all([buyerStore.initialize(), sellerStore.initialize(), paymentStore.initialize()]);
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
  let campaign = await buyer.createCampaign({
    input: { objective: "conversion", budgetSats: 3000, autoExecute: true },
    idempotencyKey: "end-to-end-demo-purchase",
  });
  const orderId = campaign.sellerOrder.id;
  await seller.syncOrder(orderId, { awaitProduction: true });
  campaign = await buyer.syncCampaign(campaign.id);
  assert.equal(campaign.state, "completed");
  assert.equal(campaign.spentSats, quote.customerPriceSats);
  assert.equal(campaign.sellerOrder.amountSats, quote.customerPriceSats - 500);
  assert.equal(campaign.sellerOrder.payment.simulated, true);
  assert.equal(campaign.sellerOrder.payment.paidAt, null);
  assert.deepEqual(campaign.sellerOrder.payment.txids, []);
  assert.equal(productions, 1);
  assert.equal(packages, 1);
  const replay = await buyer.createCampaign({
    input: { objective: "conversion", budgetSats: 3000, autoExecute: true },
    idempotencyKey: "end-to-end-demo-purchase",
  });
  assert.equal(replay.id, campaign.id);
  assert.equal(Object.keys(paymentStore.snapshot().payments).length, 1);
  assert.equal(productions, 1);
});
