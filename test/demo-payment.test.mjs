import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DemoInstantWalletClient,
  DemoPaymentClient,
  DEMO_PAYMENT_INITIAL_STATE,
} from "../src/demo-payment.mjs";
import { JsonStore } from "../src/json-store.mjs";
import { SellerService } from "../src/seller-service.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "demo-payment-test-"));
  const paymentStore = new JsonStore(join(root, "payments.json"), {
    initialState: DEMO_PAYMENT_INITIAL_STATE,
  });
  const sellerStore = new JsonStore(join(root, "seller.json"));
  await Promise.all([paymentStore.initialize(), sellerStore.initialize()]);
  const payments = new DemoPaymentClient({ store: paymentStore, clock: () => 1_800_000_000_000 });
  const producer = {
    calls: 0,
    async readiness() { return { configured: true }; },
    async execute() {
      this.calls += 1;
      return { provider: "test", buildId: "build-demo", artifacts: [{ name: "final.mp4" }] };
    },
  };
  const seller = new SellerService({
    store: sellerStore,
    payments,
    producer,
    clock: () => 1_800_000_000_000,
  });
  return { payments, seller, producer };
}

test("demo payment is durable, idempotent, and explicitly non-mainnet", async () => {
  const { payments } = await fixture();
  const first = await payments.createPayment({ amountSats: 1300, description: "Demo", externalId: "order-1" });
  const second = await payments.createPayment({ amountSats: 1300, description: "Demo", externalId: "order-1" });
  assert.equal(first.paymentId, second.paymentId);
  assert.match(first.paymentId, /^demo_pay_/u);
  assert.equal(first.simulated, true);
  assert.equal(first.status, "initiated");
  assert.deepEqual(first.transactions, []);
  assert.equal(payments.readiness().mainnet, false);
});

test("only explicit demo wallet submission authorizes production and never creates chain proof", async () => {
  const { seller, producer } = await fixture();
  const quote = await seller.createQuote({ productId: "proof_demo", budgetSats: 3000 });
  const order = await seller.createOrder({ quoteId: quote.id, idempotencyKey: "demo-order-idempotency" });
  assert.equal(order.payment.simulated, true);
  assert.equal(order.production.state, "locked");

  const wallet = new DemoInstantWalletClient({
    authorizePayment: (paymentId) => seller.authorizeDemoPayment(paymentId),
    clock: () => 1_800_000_000_000,
  });
  const prepared = await wallet.preparePayment({
    paymentId: order.payment.id,
    amountSats: order.amountSats,
    recipientAddress: order.payment.btcAddress,
  });
  assert.equal(prepared.simulated, true);
  assert.equal(prepared.validation.feeSats, 0);
  const receipt = await wallet.submitPrepared(prepared);
  assert.match(receipt.instantReceiptId, /^demo_receipt_/u);
  assert.equal(receipt.simulated, true);

  await seller.syncOrder(order.id, { awaitProduction: true });
  const completed = seller.getOrder(order.id);
  assert.equal(completed.production.state, "completed");
  assert.equal(producer.calls, 1);
  assert.equal(completed.payment.authorization, "authorized");
  assert.equal(completed.payment.settlement, "pending");
  assert.deepEqual(completed.payment.txids, []);
  assert.equal(completed.payment.network, "simulation");
});

test("real payment clients cannot access the demo authorization path", async () => {
  const root = await mkdtemp(join(tmpdir(), "demo-payment-disabled-test-"));
  const store = new JsonStore(join(root, "seller.json"));
  await store.initialize();
  const seller = new SellerService({
    store,
    payments: { readiness: () => ({ configured: true, simulated: false }) },
    producer: {},
  });
  await assert.rejects(
    seller.authorizeDemoPayment("demo_pay_unknown"),
    (error) => error.code === "demo_payment_disabled" && error.status === 404,
  );
});
