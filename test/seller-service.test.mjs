import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { JsonStore } from "../src/json-store.mjs";
import { SellerService } from "../src/seller-service.mjs";

class FakePayments {
  constructor() {
    this.created = [];
    this.status = "initiated";
    this.paidAt = null;
    this.transactions = [];
  }

  async createPayment(input) {
    this.created.push(input);
    return {
      paymentId: "payment-1",
      status: "initiated",
      amountSats: String(input.amountSats),
      btcAddress: "bc1qexample",
      checkoutUrl: "https://pay.example/payment-1",
      qrString: "bitcoin:bc1qexample",
      expiresAt: 1999999999,
      transactions: [],
      paidAt: null,
    };
  }

  async getPayment() {
    return {
      paymentId: "payment-1",
      status: this.status,
      amountSats: "1600",
      transactions: this.transactions,
      paidAt: this.paidAt,
    };
  }
}

class FakeProducer {
  constructor() { this.calls = 0; }
  async execute() {
    this.calls += 1;
    return { provider: "self-hosted-hypit", buildId: "build-1", artifacts: [{ name: "final.mp4" }] };
  }
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "hypit-seller-test-"));
  const store = new JsonStore(join(directory, "state.json"));
  await store.initialize();
  const payments = new FakePayments();
  const producer = new FakeProducer();
  const service = new SellerService({ store, payments, producer, clock: () => 1_800_000_000_000 });
  const quote = await service.createQuote({ productId: "ranking_listicle", budgetSats: 3000 });
  return { service, payments, producer, quote };
}

test("same Idempotency-Key cannot create a second payment", async () => {
  const { service, payments, quote } = await fixture();
  const first = await service.createOrder({ quoteId: quote.id, idempotencyKey: "campaign-order-001" });
  const second = await service.createOrder({ quoteId: quote.id, idempotencyKey: "campaign-order-001" });
  assert.equal(first.id, second.id);
  assert.equal(payments.created.length, 1);
  assert.equal(payments.created[0].externalId, first.externalId);
});

test("unpaid order cannot invoke Hypit", async () => {
  const { service, producer, quote } = await fixture();
  const order = await service.createOrder({ quoteId: quote.id, idempotencyKey: "campaign-order-002" });
  await service.syncOrder(order.id, { awaitProduction: true });
  assert.equal(producer.calls, 0);
  assert.equal(service.getOrder(order.id).production.state, "locked");
});

test("paid unlocks production exactly once while settlement remains separate", async () => {
  const { service, payments, producer, quote } = await fixture();
  const order = await service.createOrder({ quoteId: quote.id, idempotencyKey: "campaign-order-003" });
  payments.status = "paid";
  await service.syncOrder(order.id, { awaitProduction: true });
  await service.syncOrder(order.id, { awaitProduction: true });
  const completed = service.getOrder(order.id);
  assert.equal(producer.calls, 1);
  assert.equal(completed.production.state, "completed");
  assert.equal(completed.payment.authorization, "authorized");
  assert.equal(completed.payment.settlement, "pending");
  assert.deepEqual(completed.payment.txids, []);
});

test("later on-chain evidence records settlement and txid without re-running production", async () => {
  const { service, payments, producer, quote } = await fixture();
  const order = await service.createOrder({ quoteId: quote.id, idempotencyKey: "campaign-order-004" });
  payments.status = "paid";
  await service.syncOrder(order.id, { awaitProduction: true });
  payments.paidAt = "2026-09-19T01:00:00Z";
  payments.transactions = [{ txid: "real-chain-txid" }];
  await service.syncOrder(order.id, { awaitProduction: true });
  const settled = service.getOrder(order.id);
  assert.equal(producer.calls, 1);
  assert.equal(settled.payment.settlement, "settled");
  assert.deepEqual(settled.payment.txids, ["real-chain-txid"]);
});

test("restart reattaches a persisted Hypit build instead of starting paid production twice", async () => {
  const { service, payments, quote } = await fixture();
  const order = await service.createOrder({ quoteId: quote.id, idempotencyKey: "campaign-order-recover-build" });
  await service.store.transaction((state) => {
    const current = state.orders[order.id];
    current.payment.authorization = "authorized";
    current.production.state = "producing";
    current.production.buildId = "build-durable-1";
    current.state = "fulfilling";
  });
  const producer = {
    starts: 0,
    resumes: 0,
    async start() { this.starts += 1; return { buildId: "wrong-new-build" }; },
    async resume({ buildId }) {
      this.resumes += 1;
      assert.equal(buildId, "build-durable-1");
      return { provider: "self-hosted-hypit", buildId, artifacts: [{ name: "final.mp4" }] };
    },
  };
  const restarted = new SellerService({
    store: service.store,
    payments,
    producer,
    clock: () => 1_800_000_000_000,
  });
  await restarted.recover();
  assert.equal(producer.starts, 0);
  assert.equal(producer.resumes, 1);
  assert.equal(restarted.getOrder(order.id).production.state, "completed");
});

test("legacy producing order without a durable build id fails closed for manual retry", async () => {
  const { service, payments, producer, quote } = await fixture();
  const order = await service.createOrder({ quoteId: quote.id, idempotencyKey: "campaign-order-recover-missing" });
  await service.store.transaction((state) => {
    const current = state.orders[order.id];
    current.payment.authorization = "authorized";
    current.production.state = "producing";
    current.state = "fulfilling";
  });
  await service.recover();
  const failed = service.getOrder(order.id);
  assert.equal(producer.calls, 0);
  assert.equal(failed.production.state, "failed");
  assert.equal(failed.production.error.code, "production_recovery_missing_build");
  assert.equal(payments.created.length, 1);
});

test("unaccepted production is removed from the live catalog and cannot be quoted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hypit-seller-unready-test-"));
  const store = new JsonStore(join(directory, "state.json"));
  await store.initialize();
  const payments = new FakePayments();
  const service = new SellerService({
    store,
    payments,
    producer: {
      async readiness() {
        return { configured: false, workflowProducts: [], workflowIssues: { proof_demo: "readyForSale must be explicitly true" } };
      },
    },
  });
  const catalog = await service.catalog();
  assert.equal(catalog.products.find((item) => item.id === "proof_demo").availability, "unavailable");
  await assert.rejects(
    service.createQuote({ productId: "proof_demo", budgetSats: 3000 }),
    (error) => error.code === "product_production_unavailable",
  );
  assert.equal(payments.created.length, 0);
});
