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
  assert.equal(first.paidAt, null);
  assert.equal(first.simulatedAuthorizedAt, null);
  assert.deepEqual(first.transactions, []);
  assert.equal(payments.readiness().mainnet, false);
});

test("demo wallet rejects invalid simulated fee configuration", () => {
  assert.throws(
    () => new DemoInstantWalletClient({ authorizePayment() {}, feeSats: -1 }),
    /feeSats must be a non-negative integer/u,
  );
});

test("only explicit demo wallet submission authorizes production and never creates chain proof", async () => {
  const { seller, producer } = await fixture();
  const quote = await seller.createQuote({ productId: "proof_demo", budgetSats: 3000 });
  const order = await seller.createOrder({ quoteId: quote.id, idempotencyKey: "demo-order-idempotency" });
  assert.equal(order.payment.simulated, true);
  assert.equal(order.production.state, "locked");

  const wallet = new DemoInstantWalletClient({
    authorizePayment: (paymentId) => seller.authorizeDemoPayment(paymentId),
    feeSats: 500,
    clock: () => 1_800_000_000_000,
  });
  const prepared = await wallet.preparePayment({
    paymentId: order.payment.id,
    amountSats: order.amountSats,
    recipientAddress: order.payment.btcAddress,
  });
  assert.equal(prepared.simulated, true);
  assert.equal(prepared.validation.feeSats, 500);
  assert.equal(prepared.validation.feeBasis, "simulated_policy_reserve");
  assert.equal(prepared.summary.feeSats, 500);
  assert.equal((await wallet.readiness()).simulatedFeeSats, 500);
  const receipt = await wallet.submitPrepared(prepared);
  assert.match(receipt.instantReceiptId, /^demo_receipt_/u);
  assert.equal(receipt.simulated, true);
  assert.equal(receipt.submittedAt, "2027-01-15T08:00:00.000Z");

  const accepted = await seller.payments.getPayment(order.payment.id);
  assert.equal(accepted.status, "paid");
  assert.equal(accepted.paidAt, null);
  assert.equal(accepted.simulatedAuthorizedAt, receipt.submittedAt);
  assert.deepEqual(accepted.transactions, []);

  await seller.syncOrder(order.id, { awaitProduction: true });
  const completed = seller.getOrder(order.id);
  assert.equal(completed.production.state, "completed");
  assert.equal(producer.calls, 1);
  assert.equal(completed.payment.authorization, "authorized");
  assert.equal(completed.payment.settlement, "pending");
  assert.equal(completed.payment.paidAt, null);
  assert.deepEqual(completed.payment.txids, []);
  assert.equal(completed.payment.network, "simulation");
});

test("legacy demo authorization timestamps cannot appear as on-chain settlement", async () => {
  const { payments } = await fixture();
  const created = await payments.createPayment({ amountSats: 1300, description: "Legacy demo", externalId: "legacy-order" });
  await payments.store.transaction((state) => {
    const payment = state.payments[created.paymentId];
    payment.status = "paid";
    payment.paidAt = "2026-09-20T08:00:00.000Z";
    delete payment.simulatedAuthorizedAt;
  });
  const legacy = await payments.getPayment(created.paymentId);
  assert.equal(legacy.paidAt, null);
  assert.equal(legacy.simulatedAuthorizedAt, "2026-09-20T08:00:00.000Z");
  assert.deepEqual(legacy.transactions, []);
});

test("expired demo payment cannot be authorized", async () => {
  const { payments } = await fixture();
  const created = await payments.createPayment({ amountSats: 1300, description: "Expired demo", externalId: "expired-order" });
  payments.clock = () => 1_800_000_000_000 + (31 * 60 * 1000);
  await assert.rejects(payments.authorizePayment(created.paymentId), (error) => error.code === "demo_payment_expired");
  assert.equal((await payments.getPayment(created.paymentId)).status, "initiated");
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
