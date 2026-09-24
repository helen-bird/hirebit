import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { JsonStore } from "../src/json-store.mjs";
import { SellerService } from "../src/seller-service.mjs";
import { AppError } from "../src/errors.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

class FakePayments {
  constructor() {
    this.created = [];
    this.status = "initiated";
    this.paidAt = null;
    this.transactions = [];
    this.simulated = false;
    this.paymentId = "payment-1";
    this.amountSats = "1600";
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
      simulated: this.simulated,
    };
  }

  async getPayment() {
    return {
      paymentId: this.paymentId,
      status: this.status,
      amountSats: this.amountSats,
      transactions: this.transactions,
      paidAt: this.paidAt,
      simulated: this.simulated,
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

test("one provider payment ID cannot authorize two different Seller orders", async () => {
  const { service, payments, quote } = await fixture();
  const first = await service.createOrder({ quoteId: quote.id, idempotencyKey: "unique-payment-order-one" });
  await assert.rejects(
    service.createOrder({ quoteId: quote.id, idempotencyKey: "unique-payment-order-two" }),
    (error) => error.code === "payment_creation_mismatch",
  );
  assert.equal(payments.created.length, 2);
  const orders = Object.values(service.store.snapshot().orders);
  assert.equal(orders.length, 2);
  assert.equal(orders.find((order) => order.id !== first.id).payment, null);
  assert.equal(orders.find((order) => order.id !== first.id).state, "payment_creation_failed");
});

test("Seller includes the network fee inside the customer price and invoices less", async () => {
  const { service, payments } = await fixture();
  service.producer.readiness = () => ({ configured: true, workflowEconomics: {
    creator_pitch: { maxProviderCostSats: 500 },
    proof_demo: { maxProviderCostSats: 500 },
    ranking_listicle: { maxProviderCostSats: 500 },
    two_person_podcast: { maxProviderCostSats: 500 },
  } });
  const quote = await service.createQuote({ productId: "proof_demo", sellerFeeAllowanceSats: 500 });
  assert.equal(quote.customerPriceSats, 1300);
  assert.equal(quote.sellerFeeAllowanceSats, 500);
  assert.equal(quote.amountSats, 800);
  const order = await service.createOrder({ quoteId: quote.id, idempotencyKey: "fee-inclusive-order" });
  assert.equal(order.amountSats, 800);
  assert.equal(payments.created.at(-1).amountSats, 800);
  const cheap = await service.createQuote({ productId: "creator_pitch", sellerFeeAllowanceSats: 500 });
  assert.equal(cheap.customerPriceSats, 900);
  assert.equal(cheap.sellerFeeAllowanceSats, 354);
  assert.equal(cheap.amountSats, 546);
  for (const productId of ["creator_pitch", "proof_demo", "ranking_listicle", "two_person_podcast"]) {
    const offered = await service.createQuote({ productId, sellerFeeAllowanceSats: 500 });
    assert.ok(offered.amountSats > 500, `${productId} retains a positive provider margin`);
    assert.equal(offered.customerPriceSats, offered.amountSats + offered.sellerFeeAllowanceSats);
  }
  await assert.rejects(service.createQuote({ productId: "proof_demo", sellerFeeAllowanceSats: 501 }),
    (error) => error.code === "invalid_fee_allowance");
});

test("unpaid order cannot invoke Hypit", async () => {
  const { service, producer, quote } = await fixture();
  const order = await service.createOrder({ quoteId: quote.id, idempotencyKey: "campaign-order-002" });
  await service.syncOrder(order.id, { awaitProduction: true });
  assert.equal(producer.calls, 0);
  assert.equal(service.getOrder(order.id).production.state, "locked");
});

test("payment/get omission preserves the locked invoice address and expiry", async () => {
  const { service, quote } = await fixture();
  const order = await service.createOrder({ quoteId: quote.id, idempotencyKey: "payment-get-omits-invoice-fields" });
  const synced = await service.syncOrder(order.id);
  assert.equal(synced.payment.btcAddress, order.payment.btcAddress);
  assert.equal(synced.payment.expiresAt, order.payment.expiresAt);
});

test("Seller rejects a provider response that changes the invoice recipient", async () => {
  const { service, payments, producer, quote } = await fixture();
  const order = await service.createOrder({ quoteId: quote.id, idempotencyKey: "payment-recipient-drift" });
  payments.getPayment = async () => ({
    paymentId: order.payment.id,
    amountSats: String(order.amountSats),
    btcAddress: "bc1qattacker",
    status: "paid",
    transactions: [],
    paidAt: null,
  });
  await assert.rejects(service.syncOrder(order.id, { awaitProduction: true }), (error) => error.code === "payment_reconciliation_mismatch");
  assert.equal(service.getOrder(order.id).payment.status, "initiated");
  assert.equal(service.getOrder(order.id).payment.btcAddress, order.payment.btcAddress);
  assert.equal(producer.calls, 0);
});

test("Seller does not persist a created invoice for the wrong amount", async () => {
  const { service, payments, quote } = await fixture();
  payments.createPayment = async (input) => ({
    paymentId: "wrong-invoice",
    amountSats: String(input.amountSats + 1),
    btcAddress: "bc1qexample",
    status: "initiated",
    expiresAt: 1999999999,
  });
  await assert.rejects(service.createOrder({ quoteId: quote.id, idempotencyKey: "wrong-amount-invoice" }),
    (error) => error.code === "payment_creation_mismatch");
  const order = Object.values(service.store.snapshot().orders)[0];
  assert.equal(order.payment, null);
  assert.equal(order.state, "payment_creation_failed");
});

test("pre-production cancellation prevents paid production and records an unpaid refund obligation", async () => {
  const { service, payments, producer, quote } = await fixture();
  const order = await service.createOrder({ quoteId: quote.id, idempotencyKey: "campaign-cancel-before-start" });
  const stopped = await service.requestCancellation(order.id);
  assert.equal(stopped.cancellation.state, "stop_requested");
  payments.status = "paid";
  const paid = await service.syncOrder(order.id, { awaitProduction: true });
  assert.equal(producer.calls, 0);
  assert.equal(paid.production.state, "stopped");
  assert.equal(paid.cancellation.state, "refund_review_required");
  assert.equal(paid.cancellation.refund.amountSats, order.amountSats);
  assert.equal(paid.cancellation.refund.state, "not_issued");
  const restarted = new SellerService({ store: service.store, payments, producer, clock: () => 1_800_000_000_000 });
  await restarted.recover();
  assert.equal(producer.calls, 0);
});

test("recovery ignores a cancelled queued order without repeatedly draining it", async () => {
  const { service, quote, producer } = await fixture();
  const order = await service.createOrder({ quoteId: quote.id, idempotencyKey: "cancelled-queue-recovery" });
  await service.store.transaction((state) => {
    const current = state.orders[order.id];
    current.payment.authorization = "authorized";
    current.production.state = "queued";
    current.cancellation = { state: "stop_requested", requestedAt: new Date(1_800_000_000_000).toISOString() };
  });
  await service.recover();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(producer.calls, 0);
  assert.equal(service.getOrder(order.id).production.state, "queued");
});

test("payment creation failure cannot erase an in-flight cancellation", async () => {
  const { service, payments, quote } = await fixture();
  const entered = deferred();
  const release = deferred();
  payments.createPayment = async () => {
    entered.resolve();
    await release.promise;
    throw new AppError("provider_unavailable", "Payment provider unavailable", 503);
  };
  const creating = service.createOrder({ quoteId: quote.id, idempotencyKey: "campaign-cancel-payment-create-error" });
  await entered.promise;
  const id = Object.values(service.store.snapshot().orders)[0].id;
  const pending = await service.requestCancellation(id);
  assert.equal(pending.state, "cancellation_pending");
  release.resolve();
  await assert.rejects(creating, (error) => error.code === "provider_unavailable");
  const after = service.getOrder(id);
  assert.equal(after.state, "cancellation_pending");
  assert.equal(after.cancellation.state, "stop_requested");
  assert.equal(after.lastError.code, "provider_unavailable");
});

test("an expired local clock does not claim a cancelled invoice is unpaid until GoBTC confirms it", async () => {
  const { service, payments, quote } = await fixture();
  const order = await service.createOrder({ quoteId: quote.id, idempotencyKey: "campaign-cancel-expiry" });
  const pending = await service.requestCancellation(order.id);
  assert.equal(pending.cancellation.state, "stop_requested");
  assert.equal(pending.payment.status, "initiated");
  payments.status = "expired";
  const confirmed = await service.syncOrder(order.id);
  assert.equal(confirmed.cancellation.state, "cancelled_unpaid");
  payments.status = "paid";
  const late = await service.syncOrder(order.id, { awaitProduction: true });
  assert.equal(late.cancellation.state, "refund_review_required");
  assert.equal(late.production.state, "stopped");
});

test("local invoice deadline alone does not release a normal unpaid order", async () => {
  const { service, quote } = await fixture();
  const order = await service.createOrder({ quoteId: quote.id, idempotencyKey: "campaign-local-expiry-only" });
  await service.store.transaction((state) => { state.orders[order.id].payment.expiresAt = 1_700_000_000; });
  const current = await service.syncOrder(order.id);
  assert.equal(current.payment.status, "initiated");
  assert.equal(current.payment.expiredLocally, true);
  assert.equal(current.state, "awaiting_payment");
});

test("cancellation after billable production begins freezes a cost-review cutoff without inventing a refund", async () => {
  const { service, payments, quote } = await fixture();
  const order = await service.createOrder({ quoteId: quote.id, idempotencyKey: "campaign-cancel-after-start" });
  payments.status = "paid";
  await service.store.transaction((state) => {
    const current = state.orders[order.id];
    current.payment.authorization = "authorized";
    current.production.state = "producing";
    current.production.startedAt = "2026-09-20T00:00:00.000Z";
    current.production.buildId = "build-already-running";
  });
  const reviewed = await service.requestCancellation(order.id);
  assert.equal(reviewed.cancellation.state, "cost_review_required");
  assert.equal(reviewed.cancellation.costCutoffAt, "2027-01-15T08:00:00.000Z");
  assert.equal(reviewed.cancellation.refund.amountSats, null);
  assert.equal(reviewed.cancellation.refund.state, "not_issued");
});

for (const outcome of ["completed", "failed"]) {
  test(`production ${outcome} after cancellation retains cost review and sends one stop signal`, async () => {
    const { service, payments, quote } = await fixture();
    const order = await service.createOrder({ quoteId: quote.id, idempotencyKey: `campaign-cancel-inflight-${outcome}` });
    const started = deferred();
    const release = deferred();
    let stopSignals = 0;
    service.producer = {
      async execute() {
        started.resolve();
        await release.promise;
        if (outcome === "failed") throw new AppError("production_failed", "Provider failed", 502);
        return { buildId: "build-in-flight", artifacts: [{ name: "final.mp4" }] };
      },
      async requestCancellation(requestedOrderId) {
        assert.equal(requestedOrderId, order.id);
        stopSignals += 1;
      },
    };
    payments.status = "paid";
    const production = service.syncOrder(order.id, { awaitProduction: true });
    await started.promise;
    const cancellation = await service.requestCancellation(order.id);
    assert.equal(cancellation.state, "cost_review_required");
    assert.equal(cancellation.cancellation.state, "cost_review_required");
    await service.requestCancellation(order.id);
    release.resolve();
    await production;
    const finished = service.getOrder(order.id);
    assert.equal(finished.state, "cost_review_required");
    assert.equal(finished.cancellation.state, "cost_review_required");
    assert.equal(finished.production.state, outcome);
    assert.equal(stopSignals, 1);
  });
}

test("on-chain fields without paid status do not unlock or settle an order", async () => {
  const { service, payments, producer, quote } = await fixture();
  const order = await service.createOrder({ quoteId: quote.id, idempotencyKey: "campaign-order-unpaid-chain-fields" });
  payments.paidAt = "2026-09-19T01:00:00Z";
  payments.transactions = [{ txid: "unexpected-txid" }];
  await service.syncOrder(order.id, { awaitProduction: true });
  const synced = service.getOrder(order.id);
  assert.equal(synced.payment.authorization, "pending");
  assert.equal(synced.payment.settlement, "pending");
  assert.equal(producer.calls, 0);
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

test("simulated payment cannot claim on-chain settlement even with legacy fields", async () => {
  const { service, payments, quote } = await fixture();
  payments.simulated = true;
  const order = await service.createOrder({ quoteId: quote.id, idempotencyKey: "campaign-order-simulated-evidence" });
  payments.status = "paid";
  payments.paidAt = "2026-09-19T01:00:00Z";
  payments.transactions = [{ txid: "synthetic-txid" }];
  await service.syncOrder(order.id, { awaitProduction: true });
  const synced = service.getOrder(order.id);
  assert.equal(synced.payment.authorization, "authorized");
  assert.equal(synced.payment.settlement, "pending");
  assert.equal(synced.payment.paidAt, null);
  assert.deepEqual(synced.payment.txids, []);
});

test("Seller refuses a paid response for a different payment or amount", async () => {
  const { service, payments, producer, quote } = await fixture();
  const order = await service.createOrder({ quoteId: quote.id, idempotencyKey: "campaign-order-wrong-payment" });
  payments.status = "paid";
  payments.paymentId = "another-payment";
  await assert.rejects(service.syncOrder(order.id), (error) => error.code === "payment_reconciliation_mismatch");
  payments.paymentId = order.payment.id;
  payments.amountSats = "1601";
  await assert.rejects(service.syncOrder(order.id), (error) => error.code === "payment_reconciliation_mismatch");
  assert.equal(producer.calls, 0);
  assert.equal(service.getOrder(order.id).payment.authorization, "pending");
});

test("stale status cannot erase a previously authorized payment", async () => {
  const { service, payments, producer, quote } = await fixture();
  const order = await service.createOrder({ quoteId: quote.id, idempotencyKey: "campaign-order-stale-payment" });
  payments.status = "paid";
  await service.syncOrder(order.id, { awaitProduction: true });
  payments.status = "initiated";
  await assert.rejects(service.syncOrder(order.id), (error) => error.code === "payment_status_regressed");
  assert.equal(service.getOrder(order.id).payment.authorization, "authorized");
  assert.equal(producer.calls, 1);
});

test("stale settlement response cannot erase recorded chain evidence", async () => {
  const { service, payments, quote } = await fixture();
  const order = await service.createOrder({ quoteId: quote.id, idempotencyKey: "campaign-order-stale-settlement" });
  payments.status = "paid";
  payments.paidAt = "2026-09-19T01:00:00Z";
  payments.transactions = [{ txid: "settled-txid" }];
  await service.syncOrder(order.id, { awaitProduction: true });
  payments.paidAt = null;
  payments.transactions = [];
  await assert.rejects(service.syncOrder(order.id), (error) => error.code === "payment_settlement_regressed");
  const preserved = service.getOrder(order.id);
  assert.equal(preserved.payment.settlement, "settled");
  assert.deepEqual(preserved.payment.txids, ["settled-txid"]);
});

test("a slower unpaid response cannot overwrite concurrently committed paid status", async () => {
  const { service, payments, producer, quote } = await fixture();
  const order = await service.createOrder({ quoteId: quote.id, idempotencyKey: "campaign-concurrent-paid-polls" });
  const fetched = deferred();
  const release = deferred();
  let calls = 0;
  payments.getPayment = async () => {
    calls += 1;
    if (calls === 1) {
      fetched.resolve();
      await release.promise;
      return { paymentId: order.payment.id, amountSats: order.amountSats, status: "initiated" };
    }
    return { paymentId: order.payment.id, amountSats: order.amountSats, status: "paid" };
  };
  const stale = service.syncOrder(order.id);
  await fetched.promise;
  await service.syncOrder(order.id, { awaitProduction: true });
  release.resolve();
  await assert.rejects(stale, (error) => error.code === "payment_status_regressed");
  const current = service.getOrder(order.id);
  assert.equal(current.payment.authorization, "authorized");
  assert.equal(current.production.state, "completed");
  assert.equal(producer.calls, 1);
  await service.syncOrder(order.id, { awaitProduction: true });
  assert.equal(producer.calls, 1);
});

test("a slower unsettled response cannot erase concurrently committed settlement", async () => {
  const { service, payments, quote } = await fixture();
  const order = await service.createOrder({ quoteId: quote.id, idempotencyKey: "campaign-concurrent-chain-polls" });
  const fetched = deferred();
  const release = deferred();
  let calls = 0;
  payments.getPayment = async () => {
    calls += 1;
    if (calls === 1) {
      fetched.resolve();
      await release.promise;
      return { paymentId: order.payment.id, amountSats: order.amountSats, status: "paid", transactions: [] };
    }
    return {
      paymentId: order.payment.id, amountSats: order.amountSats, status: "paid",
      paidAt: "2026-09-19T01:00:00Z", transactions: [{ txid: "concurrent-txid" }],
    };
  };
  const stale = service.syncOrder(order.id);
  await fetched.promise;
  await service.syncOrder(order.id, { awaitProduction: true });
  release.resolve();
  await assert.rejects(stale, (error) => error.code === "payment_settlement_regressed");
  assert.equal(service.getOrder(order.id).payment.settlement, "settled");
  assert.deepEqual(service.getOrder(order.id).payment.txids, ["concurrent-txid"]);
});

test("a Hypit watch timeout retains its build and retry reattaches without a second submission", async () => {
  const { service, payments, quote } = await fixture();
  const order = await service.createOrder({ quoteId: quote.id, idempotencyKey: "campaign-hypit-still-running" });
  const producer = {
    starts: 0,
    resumes: 0,
    async start() { this.starts += 1; return { buildId: "build-in-flight" }; },
    async resume({ buildId }) {
      this.resumes += 1;
      assert.equal(buildId, "build-in-flight");
      if (this.resumes === 1) throw new AppError("hypit_build_still_running", "Still running", 409);
      return { provider: "self-hosted-hypit", buildId, artifacts: [{ name: "final.mp4" }] };
    },
  };
  service.producer = producer;
  payments.status = "paid";
  const pending = await service.syncOrder(order.id, { awaitProduction: true });
  assert.equal(pending.production.state, "producing");
  assert.equal(pending.production.buildId, "build-in-flight");
  assert.equal(pending.production.error.transient, true);
  const complete = await service.retryProduction(order.id);
  assert.equal(complete.production.state, "completed");
  assert.equal(complete.production.attempts, 1);
  assert.equal(producer.starts, 1);
  assert.equal(producer.resumes, 2);
});

test("an uncertain status failure after Hypit submission self-repairs against the saved build", async () => {
  const { service, payments, quote } = await fixture();
  const order = await service.createOrder({ quoteId: quote.id, idempotencyKey: "campaign-hypit-uncertain-result" });
  const producer = {
    starts: 0,
    resumes: 0,
    async start() { this.starts += 1; return { buildId: "build-saved-before-error" }; },
    async resume({ buildId }) {
      this.resumes += 1;
      assert.equal(buildId, "build-saved-before-error");
      if (this.resumes === 1) throw new AppError("hypit_status_unavailable", "Could not read status", 502);
      return { provider: "self-hosted-hypit", buildId, artifacts: [{ name: "final.mp4" }] };
    },
  };
  service.producer = producer;
  payments.status = "paid";
  const complete = await service.syncOrder(order.id, { awaitProduction: true });
  assert.equal(complete.production.state, "completed");
  assert.equal(producer.starts, 1);
  assert.equal(producer.resumes, 2);
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

test("restart safely resumes Seller inputs before a Build without another Buyer payment", async () => {
  const { service, payments, quote } = await fixture();
  const order = await service.createOrder({ quoteId: quote.id, idempotencyKey: "campaign-prebuild-recovery" });
  await service.store.transaction((state) => {
    const current = state.orders[order.id];
    current.payment.authorization = "authorized";
    current.production.state = "producing";
    current.state = "fulfilling";
  });
  const producer = {
    recovered: 0, started: 0, resumed: 0,
    async recoverUnsubmitted() { this.recovered += 1; return { buildId: "build-recovered" }; },
    async start() { this.started += 1; return { buildId: "wrong-duplicate" }; },
    async resume({ buildId }) {
      this.resumed += 1;
      assert.equal(buildId, "build-recovered");
      return { provider: "self-hosted-hypit", buildId, artifacts: [{ name: "final.mp4" }] };
    },
  };
  const restarted = new SellerService({ store: service.store, payments, producer, clock: () => 1_800_000_000_000 });
  await restarted.recover();
  assert.equal(producer.recovered, 1);
  assert.equal(producer.started, 0);
  assert.equal(producer.resumed, 1);
  assert.equal(payments.created.length, 1);
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
  await assert.rejects(service.retryProduction(order.id), (error) => error.code === "production_reconciliation_required");
  assert.equal(producer.calls, 0);
});

test("terminal Veo failure cannot be retried as the same paid production", async () => {
  const { service, payments, producer, quote } = await fixture();
  const order = await service.createOrder({ quoteId: quote.id, idempotencyKey: "veo-terminal-failure" });
  await service.store.transaction((state) => {
    const current = state.orders[order.id];
    current.payment.authorization = "authorized";
    current.state = "fulfillment_failed";
    current.production.state = "failed";
    current.production.error = { code: "google_veo_generation_failed", message: "Veo generation failed" };
  });
  await assert.rejects(service.retryProduction(order.id), (error) => error.code === "production_review_required");
  assert.equal(service.getOrder(order.id).production.state, "failed");
  assert.equal(producer.calls, 0);
  assert.equal(payments.created.length, 1);
});

test("an ambiguous Hypit submission timeout cannot create a second build on retry", async () => {
  const { service, payments, quote } = await fixture();
  const order = await service.createOrder({ quoteId: quote.id, idempotencyKey: "campaign-hypit-ambiguous-submission" });
  const producer = {
    starts: 0,
    async start() {
      this.starts += 1;
      throw new AppError("hypit_timeout", "Build request timed out", 502);
    },
    async resume() { throw new Error("No known build to resume"); },
  };
  service.producer = producer;
  payments.status = "paid";
  const failed = await service.syncOrder(order.id, { awaitProduction: true });
  assert.equal(failed.production.state, "failed");
  await assert.rejects(service.retryProduction(order.id), (error) => error.code === "production_reconciliation_required");
  assert.equal(producer.starts, 1);
});

test("a failed pre-Build probe self-repairs once on the same paid order only with producer evidence", async () => {
  const { service, payments, quote } = await fixture();
  const order = await service.createOrder({ quoteId: quote.id, idempotencyKey: "campaign-prebuild-probe-retry" });
  const producer = {
    starts: 0,
    async start() {
      this.starts += 1;
      if (this.starts === 1) throw new AppError("hypit_command_failed", "Probe failed", 502);
      return { buildId: "build-after-probe" };
    },
    async canRetryBeforeBuild() { return true; },
    async recoverUnsubmitted() { return await this.start(); },
    async resume() { return { provider: "self-hosted-hypit", buildId: "build-after-probe", artifacts: [{ name: "final.mp4" }] }; },
  };
  service.producer = producer;
  payments.status = "paid";
  const completed = await service.syncOrder(order.id, { awaitProduction: true });
  assert.equal(completed.production.state, "completed");
  assert.equal(producer.starts, 2);
  assert.equal(completed.production.attempts, 2);
  assert.equal(payments.created.length, 1);
});

test("pre-Build self-repair stops after one retry and does not repeat payment", async () => {
  const { service, payments, quote } = await fixture();
  const order = await service.createOrder({ quoteId: quote.id, idempotencyKey: "prebuild-internal-retry-exhausted" });
  const producer = {
    starts: 0,
    async start() { this.starts += 1; throw new AppError("hypit_command_failed", "Probe failed", 502); },
    async recoverUnsubmitted() { return await this.start(); },
    async canRetryBeforeBuild() { return true; },
    async resume() { throw new Error("No Build should exist"); },
  };
  service.producer = producer;
  payments.status = "paid";
  const failed = await service.syncOrder(order.id, { awaitProduction: true });
  assert.equal(failed.production.state, "failed");
  assert.equal(failed.production.error.code, "hypit_command_failed", JSON.stringify(failed.production.error));
  assert.equal(failed.production.attempts, 2);
  assert.equal(producer.starts, 2);
  assert.equal(payments.created.length, 1);
});

test("uncertain pre-Build evidence prevents an automatic second submission", async () => {
  const { service, payments, quote } = await fixture();
  const order = await service.createOrder({ quoteId: quote.id, idempotencyKey: "prebuild-proof-missing" });
  const producer = {
    starts: 0,
    recoveries: 0,
    async start() { this.starts += 1; throw new AppError("hypit_command_failed", "Command stopped", 502); },
    async recoverUnsubmitted() { this.recoveries += 1; return { buildId: "unexpected" }; },
    async canRetryBeforeBuild() { return false; },
    async resume() { throw new Error("No confirmed Build exists"); },
  };
  service.producer = producer;
  payments.status = "paid";
  const failed = await service.syncOrder(order.id, { awaitProduction: true });
  assert.equal(failed.production.state, "failed");
  assert.equal(failed.production.error.code, "hypit_command_failed");
  assert.equal(producer.starts, 1);
  assert.equal(producer.recoveries, 0);
  assert.equal(payments.created.length, 1);
});

test("two status-read failures surface a failed order without a second Build or payment", async () => {
  const { service, payments, quote } = await fixture();
  const order = await service.createOrder({ quoteId: quote.id, idempotencyKey: "status-reattach-exhausted" });
  const producer = {
    starts: 0,
    resumes: 0,
    async start() { this.starts += 1; return { buildId: "durable-build" }; },
    async resume() { this.resumes += 1; throw new AppError("hypit_status_unavailable", "Status unavailable", 502); },
  };
  service.producer = producer;
  payments.status = "paid";
  const failed = await service.syncOrder(order.id, { awaitProduction: true });
  assert.equal(failed.production.state, "failed");
  assert.equal(failed.production.error.code, "hypit_status_unavailable");
  assert.equal(failed.production.buildId, "durable-build");
  assert.equal(producer.starts, 1);
  assert.equal(producer.resumes, 2);
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
