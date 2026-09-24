import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BuyerService, BUYER_INITIAL_STATE, purchaseSelectionDigest } from "../src/buyer/buyer-service.mjs";
import { JsonStore } from "../src/json-store.mjs";

const policy = {
  version: 1,
  maxPerOrderSats: 3000,
  maxCampaignSats: 3000,
  defaultAutoExecute: false,
  pollIntervalMs: 5000,
  maxDailySpendSats: 60000,
  maxLifetimeSpendSats: 60000,
  maxPendingPayments: 1,
  maxPaymentFeeSats: 25,
  paymentsEnabled: true,
};

class FixedDecision {
  async evaluate() {
    return {
      selected: {
        productId: "proof_demo",
        score: 0.9,
        quote: { id: "quote-1", amountSats: 1300 },
      },
      candidates: [],
    };
  }
}

test("purchase confirmation binds the displayed plan, scope and total authorized amount", () => {
  const selected = {
    productId: "product_showcase",
    planId: "product_showcase:h3",
    scope: { hookVariants: 3, languages: ["en-US"] },
    totalAuthorizedSats: 1825,
    quote: { id: "quote-1", amountSats: 1800 },
  };
  const fingerprint = purchaseSelectionDigest({ decision: { selected } });
  assert.notEqual(fingerprint, purchaseSelectionDigest({ decision: {
    selected: { ...selected, totalAuthorizedSats: 1850 },
  } }));
  assert.notEqual(fingerprint, purchaseSelectionDigest({ decision: {
    selected: { ...selected, scope: { ...selected.scope, hookVariants: 1 } },
  } }));
});

class FakeSeller {
  constructor({ completed = true, orderAmountSats = 1300 } = {}) {
    this.created = 0;
    this.synced = 0;
    this.retried = 0;
    this.completed = completed;
    this.orderAmountSats = orderAmountSats;
    this.origin = "http://seller.test";
  }
  async health() { return { reachable: true, origin: this.origin }; }
  async createOrder() {
    this.created += 1;
    return {
      id: "order-1",
      amountSats: this.orderAmountSats,
      state: "awaiting_payment",
      payment: {
        id: "payment-1",
        status: "initiated",
        amountSats: String(this.orderAmountSats),
        btcAddress: "bc1qmerchant",
        expiresAt: 1_999_999_999,
        authorization: "pending",
        settlement: "pending",
      },
      production: { state: "locked", result: null },
    };
  }
  async syncOrder() {
    this.synced += 1;
    if (!this.completed) {
      return {
        id: "order-1",
        amountSats: this.orderAmountSats,
        state: "awaiting_payment",
        payment: { id: "payment-1", amountSats: String(this.orderAmountSats), btcAddress: "bc1qmerchant", authorization: "pending", settlement: "pending" },
        production: { state: "locked", result: null },
      };
    }
    return {
      id: "order-1",
      amountSats: this.orderAmountSats,
      state: "completed",
      payment: { id: "payment-1", amountSats: String(this.orderAmountSats), btcAddress: "bc1qmerchant", authorization: "authorized", settlement: "pending", txids: [] },
      production: { state: "completed", result: { artifacts: [{ name: "final.mp4" }] } },
    };
  }
  async requestCancellation() {
    return {
      id: "order-1",
      amountSats: this.orderAmountSats,
      state: "cancellation_pending",
      payment: { id: "payment-1", amountSats: String(this.orderAmountSats), btcAddress: "bc1qmerchant", status: "initiated", authorization: "pending", settlement: "pending" },
      production: { state: "stopped", result: null },
      cancellation: { state: "stop_requested", refund: { state: "not_issued", amountSats: null } },
    };
  }
  async retryProduction() {
    this.retried += 1;
    return await this.syncOrder();
  }
}

class FakeWallet {
  constructor({ uncertain = false, onPrepared = null, feeSats = 25 } = {}) {
    this.prepared = 0;
    this.submitted = 0;
    this.uncertain = uncertain;
    this.onPrepared = onPrepared;
    this.feeSats = feeSats;
  }
  async readiness() { return { configured: true }; }
  async preparePayment({ paymentId }) {
    this.prepared += 1;
    this.onPrepared?.();
    return {
      paymentId,
      jobId: "job-1",
      signedPsbtBase64: "signed",
      summary: null,
      validation: { feeSats: this.feeSats },
    };
  }
  async submitPrepared() {
    this.submitted += 1;
    if (this.uncertain) throw Object.assign(new Error("timeout"), { code: "gobtcpay_unavailable" });
    return { instantReceiptId: "platform-receipt-1" };
  }
}

async function fixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "buyer-service-test-"));
  const store = new JsonStore(join(directory, "state.json"), { initialState: BUYER_INITIAL_STATE });
  await store.initialize();
  const seller = new FakeSeller(options);
  const wallet = new FakeWallet(options);
  const service = new BuyerService({
    store,
    seller,
    wallet,
    decisionEngine: options.decisionEngine ?? new FixedDecision(),
    completer: options.completer ?? null,
    policy,
    clock: () => 1_800_000_000_000,
  });
  return { service, seller, wallet, store };
}

test("completed fulfillment is assembled before the campaign becomes complete", async () => {
  const completer = {
    calls: 0,
    readiness() { return { configured: true }; },
    async complete(campaign) {
      this.calls += 1;
      assert.equal(campaign.state, "packaging");
      assert.equal(campaign.fulfillmentResult.artifacts[0].name, "final.mp4");
      return {
        state: "completed",
        summary: { spend: { spentSats: 1300, remainingBudgetSats: 1700 } },
        files: [{ path: "manifest.json" }],
      };
    },
  };
  const { service } = await fixture({ completer });
  const completed = await service.createCampaign({
    input: { objective: "conversion", budgetSats: 3000, autoExecute: true },
    idempotencyKey: "buyer-campaign-package",
  });
  assert.equal(completed.state, "completed");
  assert.equal(completed.result.fulfillment.artifacts[0].name, "final.mp4");
  assert.equal(completed.result.campaignPackage.files[0].path, "manifest.json");
  assert.equal(completer.calls, 1);
  assert.equal(service.audit(completed.id).filter((event) => event.type === "campaign.completed").length, 1);
});

test("Buyer never submits a payment above the Seller-funded all-in quote", async () => {
  const decisionEngine = { async evaluate() {
    return { selected: { productId: "proof_demo", score: 0.9,
      quote: { id: "quote-1", amountSats: 1300, sellerFeeAllowanceSats: 25, customerPriceSats: 1325 } },
    candidates: [] };
  } };
  const { service, wallet } = await fixture({ decisionEngine, feeSats: 26 });
  const result = await service.createCampaign({
    input: { objective: "conversion", budgetSats: 3000, autoExecute: true },
    idempotencyKey: "buyer-fee-over-inclusive-price",
  });
  assert.equal(result.state, "payment_preparation_failed");
  assert.equal(result.lastError.code, "campaign_budget_exceeded");
  assert.equal(wallet.submitted, 0);
});

test("lost Seller order response keeps its spend reserved until the original invoice is reconciled", async () => {
  const { service, seller } = await fixture();
  seller.createOrder = async () => {
    seller.created += 1;
    throw Object.assign(new Error("response lost after remote invoice creation"), { code: "seller_unavailable" });
  };
  const first = await service.createCampaign({
    input: { objective: "conversion", budgetSats: 3000, autoExecute: true },
    idempotencyKey: "buyer-unknown-seller-invoice-1",
  });
  assert.equal(first.state, "order_failed");
  assert.equal(first.spendReservation.status, "uncertain");
  const second = await service.createCampaign({
    input: { objective: "conversion", budgetSats: 3000, autoExecute: true },
    idempotencyKey: "buyer-unknown-seller-invoice-2",
  });
  assert.equal(second.state, "spend_blocked");
  assert.equal(second.lastError.code, "pending_payment_limit");
  assert.equal(seller.created, 1);
});

test("durable campaign linkage can stop autonomous execution before a quote or payment", async () => {
  const { service, seller, wallet } = await fixture();
  const cancelled = await service.createCampaign({
    input: { objective: "conversion", budgetSats: 3000, autoExecute: true },
    idempotencyKey: "buyer-campaign-link-before-execution",
    onCreated: async (campaign) => {
      assert.equal(campaign.state, "analyzing");
      await service.cancelCampaign(campaign.id);
    },
  });
  assert.equal(cancelled.state, "cancelled");
  assert.equal(seller.created, 0);
  assert.equal(wallet.submitted, 0);
});

test("campaign is decision-only until autoExecute or explicit execute", async () => {
  const { service, seller, wallet } = await fixture();
  const campaign = await service.createCampaign({
    input: { objective: "conversion", budgetSats: 3000 },
    idempotencyKey: "buyer-campaign-001",
  });
  assert.equal(campaign.state, "decision_ready");
  assert.equal(seller.created, 0);
  assert.equal(wallet.submitted, 0);
});

test("an idempotently recovered invoice already paid before Buyer submission is linked for review", async () => {
  const { service, seller, wallet } = await fixture();
  const originalCreate = seller.createOrder.bind(seller);
  seller.createOrder = async (...args) => {
    const order = await originalCreate(...args);
    return {
      ...order,
      payment: { ...order.payment, status: "paid", authorization: "authorized" },
    };
  };
  const campaign = await service.createCampaign({
    input: { objective: "conversion", budgetSats: 3000, autoExecute: true },
    idempotencyKey: "buyer-paid-before-create-replay",
  });
  assert.equal(campaign.state, "payment_origin_review_required");
  assert.equal(campaign.sellerOrder.id, "order-1");
  assert.equal(campaign.spentSats, 0);
  assert.equal(campaign.spendReservation.status, "uncertain");
  assert.equal(wallet.submitted, 0);
});

test("cancellation during asynchronous signing cannot submit a payment", async () => {
  let entered;
  let release;
  const preparing = new Promise((resolve) => { entered = resolve; });
  const proceed = new Promise((resolve) => { release = resolve; });
  const { service, wallet } = await fixture();
  const campaign = await service.createCampaign({
    input: { objective: "conversion", budgetSats: 3000 },
    idempotencyKey: "buyer-campaign-cancel-signing",
  });
  const originalPrepare = wallet.preparePayment.bind(wallet);
  wallet.preparePayment = async (input) => {
    entered();
    await proceed;
    return await originalPrepare(input);
  };
  const execution = service.executeCampaign(campaign.id);
  await preparing;
  const cancelled = await service.cancelCampaign(campaign.id);
  assert.equal(cancelled.state, "cancellation_pending");
  release();
  await execution;
  assert.equal(wallet.submitted, 0);
  assert.equal(service.getCampaign(campaign.id).state, "cancellation_pending");
});

test("cancellation after submission starts stays pending and preserves the payment receipt", async () => {
  let entered;
  let release;
  const submitting = new Promise((resolve) => { entered = resolve; });
  const proceed = new Promise((resolve) => { release = resolve; });
  const { service, wallet } = await fixture();
  const campaign = await service.createCampaign({
    input: { objective: "conversion", budgetSats: 3000 },
    idempotencyKey: "buyer-campaign-cancel-submitting",
  });
  const originalSubmit = wallet.submitPrepared.bind(wallet);
  wallet.submitPrepared = async (prepared) => {
    entered();
    await proceed;
    return await originalSubmit(prepared);
  };
  const execution = service.executeCampaign(campaign.id);
  await submitting;
  const pending = await service.cancelCampaign(campaign.id);
  assert.equal(pending.state, "cancellation_pending");
  release();
  await execution;
  const final = service.getCampaign(campaign.id);
  assert.equal(final.state, "cancellation_pending");
  assert.equal(final.paymentAttempt.status, "submitted");
  assert.equal(wallet.submitted, 1);
});

test("fulfillment retry reconciles a Seller build that completed after Buyer timed out", async () => {
  const { service, seller, store } = await fixture();
  const campaign = await service.createCampaign({
    input: { objective: "conversion", budgetSats: 3000 },
    idempotencyKey: "buyer-campaign-late-completion",
  });
  await store.transaction((state) => {
    const current = state.campaigns[campaign.id];
    current.state = "fulfillment_failed";
    current.sellerOrder = {
      id: "order-1",
      amountSats: 1300,
      state: "fulfillment_failed",
      payment: { id: "payment-1", amountSats: "1300", btcAddress: "bc1qmerchant", authorization: "authorized", settlement: "pending" },
      production: {
        state: "failed",
        error: { code: "seller_unavailable", message: "Seller request timed out" },
      },
    };
    current.paymentAttempt = {
      status: "submitted",
      prepared: { paymentId: "payment-1", validation: { feeSats: 25 } },
      receipt: { instantReceiptId: "platform-receipt-1" },
    };
    current.lastError = { code: "seller_unavailable", message: "Seller request timed out" };
  });

  const recovered = await service.retryFulfillment(campaign.id);
  assert.equal(recovered.state, "completed");
  assert.equal(seller.retried, 0);
  assert.equal(seller.synced, 1);
});

test("delegated purchase confirmation cannot be bypassed through the Campaign endpoint", async () => {
  const { service, seller } = await fixture();
  const campaign = await service.createCampaign({
    input: {
      objective: "conversion",
      budgetSats: 3000,
      authorizationMode: "confirm_before_purchase",
      delegationId: "delegation-1",
    },
    idempotencyKey: "buyer-campaign-confirm-gate",
  });
  await assert.rejects(
    service.executeCampaign(campaign.id),
    (error) => error.code === "purchase_confirmation_required" && error.status === 403,
  );
  assert.equal(seller.created, 0);
  const completed = await service.executeCampaign(campaign.id, {
    purchaseAuthorization: {
      type: "delegation_purchase_confirmation",
      delegationId: "delegation-1",
      selectionDigest: campaign.purchaseSelectionDigest,
    },
  });
  assert.equal(completed.state, "completed");
  assert.equal(seller.created, 1);
});

test("expired quote changing the plan requires a fresh exact purchase confirmation", async () => {
  const { service, seller, wallet } = await fixture({ completed: false });
  let decisions = 0;
  service.decisionEngine.evaluate = async () => {
    decisions += 1;
    const revised = decisions > 1;
    return {
      selected: {
        productId: revised ? "product_showcase" : "proof_demo",
        planId: revised ? "product_showcase:h3" : "proof_demo:h1",
        scope: { hookVariants: revised ? 3 : 1 },
        totalAuthorizedSats: revised ? 1825 : 1325,
        score: 0.9,
        quote: { id: revised ? "quote-2" : "quote-1", amountSats: revised ? 1800 : 1300,
          addOns: { hookVariants: revised ? 3 : 1, languages: ["en-US"], aspectRatios: ["9:16"] } },
      },
      candidates: [],
    };
  };
  const originalCreate = seller.createOrder.bind(seller);
  seller.createOrder = async (...args) => {
    if (seller.created === 0) {
      seller.created += 1;
      throw Object.assign(new Error("expired"), { code: "quote_expired" });
    }
    seller.orderAmountSats = 1800;
    return await originalCreate(...args);
  };
  const campaign = await service.createCampaign({
    input: { objective: "conversion", budgetSats: 3000,
      authorizationMode: "confirm_before_purchase", delegationId: "delegation-requote" },
    idempotencyKey: "buyer-campaign-requote-confirm",
  });
  const oldDigest = campaign.purchaseSelectionDigest;
  const awaiting = await service.executeCampaign(campaign.id, {
    purchaseAuthorization: { type: "delegation_purchase_confirmation",
      delegationId: "delegation-requote", selectionDigest: oldDigest },
  });
  assert.equal(awaiting.state, "decision_ready");
  assert.equal(awaiting.authorization.purchaseConfirmedAt, null);
  assert.equal(awaiting.authorization.autoExecute, false);
  assert.notEqual(awaiting.purchaseSelectionDigest, oldDigest);
  assert.equal(awaiting.decision.selected.quote.amountSats, 1800);
  assert.equal(wallet.submitted, 0);
  await assert.rejects(service.executeCampaign(campaign.id, {
    purchaseAuthorization: { type: "delegation_purchase_confirmation",
      delegationId: "delegation-requote", selectionDigest: oldDigest },
  }), (error) => error.code === "purchase_confirmation_stale");
  const purchased = await service.executeCampaign(campaign.id, {
    purchaseAuthorization: { type: "delegation_purchase_confirmation",
      delegationId: "delegation-requote", selectionDigest: awaiting.purchaseSelectionDigest },
  });
  assert.equal(purchased.authorization.purchaseSelectionDigest, awaiting.purchaseSelectionDigest);
  assert.equal(seller.created, 2);
  assert.equal(wallet.submitted, 1);
});

test("advisory-only delegation can never enter the purchasing path", async () => {
  const { service, seller } = await fixture();
  const campaign = await service.createCampaign({
    input: {
      objective: "conversion",
      budgetSats: 3000,
      authorizationMode: "advisory_only",
      delegationId: "delegation-2",
    },
    idempotencyKey: "buyer-campaign-advisory-gate",
  });
  await assert.rejects(
    service.executeCampaign(campaign.id),
    (error) => error.code === "purchase_not_authorized" && error.status === 403,
  );
  assert.equal(seller.created, 0);
});

test("upfront autoExecute authorization completes one order and one payment", async () => {
  const { service, seller, wallet, store } = await fixture();
  const input = { objective: "conversion", budgetSats: 3000, autoExecute: true };
  const first = await service.createCampaign({ input, idempotencyKey: "buyer-campaign-002" });
  const second = await service.createCampaign({ input, idempotencyKey: "buyer-campaign-002" });
  assert.equal(first.id, second.id);
  assert.equal(first.state, "completed");
  assert.equal(first.invoiceSpentSats, 1300);
  assert.equal(first.networkFeeSats, 25);
  assert.equal(first.spentSats, 1325);
  assert.equal(first.remainingBudgetSats, 1675);
  assert.equal(first.paymentAttempt.receipt.instantReceiptId, "platform-receipt-1");
  assert.equal(first.paymentAttempt.prepared.signedPsbtBase64, undefined);
  assert.equal(store.snapshot().campaigns[first.id].paymentAttempt.prepared.signedPsbtBase64, undefined);
  assert.match(store.snapshot().campaigns[first.id].paymentAttempt.prepared.signedPsbtSha256, /^[a-f0-9]{64}$/u);
  assert.equal(seller.created, 1);
  assert.equal(wallet.prepared, 1);
  assert.equal(wallet.submitted, 1);
});

test("completed campaign respects Seller's next settlement check instead of polling every tick", async () => {
  const { service, seller, store } = await fixture();
  const completed = await service.createCampaign({
    input: { objective: "conversion", budgetSats: 3000, autoExecute: true },
    idempotencyKey: "buyer-campaign-settlement-backoff",
  });
  const previousSyncs = seller.synced;
  await store.transaction((state) => {
    state.campaigns[completed.id].sellerOrder.payment.nextCheckAt = "2027-01-15T08:05:00.000Z";
  });
  await service.pollOnce();
  assert.equal(seller.synced, previousSyncs);
  await store.transaction((state) => {
    state.campaigns[completed.id].sellerOrder.payment.nextCheckAt = "2027-01-15T07:59:00.000Z";
  });
  await service.pollOnce();
  assert.equal(seller.synced, previousSyncs + 1);
});

test("settled payment still polls until paid fulfillment reaches delivery", async () => {
  const { service, seller, store } = await fixture({ completed: false });
  const campaign = await service.createCampaign({
    input: { objective: "conversion", budgetSats: 3000, autoExecute: true },
    idempotencyKey: "buyer-settled-before-delivery",
  });
  await store.transaction((state) => {
    const current = state.campaigns[campaign.id];
    current.state = "fulfillment";
    current.sellerOrder.payment.authorization = "authorized";
    current.sellerOrder.payment.settlement = "settled";
  });
  seller.completed = true;
  const before = seller.synced;
  await service.pollOnce();
  assert.equal(seller.synced, before + 1);
  assert.equal(service.getCampaign(campaign.id).state, "completed");
});

for (const outcome of ["completed", "failed"]) {
  test(`packaging ${outcome} cannot overwrite a cancellation review`, async () => {
    let started;
    let release;
    const entered = new Promise((resolve) => { started = resolve; });
    const proceed = new Promise((resolve) => { release = resolve; });
    const completer = {
      async complete() {
        started();
        await proceed;
        if (outcome === "failed") throw Object.assign(new Error("package unavailable"), { code: "package_unavailable" });
        return { state: "completed", files: [{ path: "manifest.json" }] };
      },
    };
    const { service, store } = await fixture({ completer });
    const work = service.createCampaign({
      input: { objective: "conversion", budgetSats: 3000, autoExecute: true },
      idempotencyKey: `buyer-campaign-packaging-review-${outcome}`,
    });
    await entered;
    const campaignId = Object.keys(store.snapshot().campaigns)[0];
    await store.transaction((state) => {
      const current = state.campaigns[campaignId];
      current.cancellation = { requestedAt: "2027-01-15T08:00:00.000Z", state: "cost_review_required" };
      current.state = "cost_review_required";
    });
    release();
    const result = await work;
    assert.equal(result.state, "cost_review_required");
    assert.equal(result.completedAt, undefined);
    if (outcome === "completed") assert.equal(result.package.state, "completed");
    else assert.equal(result.lastError.code, "package_unavailable");
    assert.equal(service.audit(campaignId).filter((event) => event.type === "campaign.completed").length, 0);
  });
}

test("uncertain submission is reconciled without blind resubmission", async () => {
  const { service, seller, wallet } = await fixture({ uncertain: true, completed: false });
  const campaign = await service.createCampaign({
    input: { objective: "conversion", budgetSats: 3000, autoExecute: true },
    idempotencyKey: "buyer-campaign-003",
  });
  assert.equal(campaign.state, "payment_uncertain");
  await service.executeCampaign(campaign.id);
  assert.equal(seller.created, 1);
  assert.equal(wallet.prepared, 1);
  assert.equal(wallet.submitted, 1);
  assert.ok(seller.synced >= 2);
  assert.equal(service.audit(campaign.id).filter((event) => event.type === "payment.submission_uncertain").length, 1);
});

test("a terminal unpaid Seller status after a Buyer submission receipt keeps the spend reserved", async () => {
  const { service, seller, wallet } = await fixture({ completed: false });
  seller.syncOrder = async () => ({
    id: "order-1", amountSats: 1300, state: "payment_expired",
    payment: { id: "payment-1", amountSats: "1300", btcAddress: "bc1qmerchant",
      status: "expired", authorization: "pending", settlement: "pending" },
    production: { state: "locked", result: null },
  });
  const campaign = await service.createCampaign({
    input: { objective: "conversion", budgetSats: 3000, autoExecute: true },
    idempotencyKey: "buyer-submitted-then-expired-conflict",
  });
  assert.equal(campaign.paymentAttempt.status, "submitted");
  assert.equal(campaign.state, "payment_uncertain");
  assert.equal(campaign.spendReservation.status, "uncertain");
  assert.equal(campaign.lastError.code, "payment_status_conflicts_submission");
  await service.executeCampaign(campaign.id);
  assert.equal(wallet.submitted, 1);
});

test("a cancelled invoice after uncertain submission cannot free the Buyer's allocation", async () => {
  const { service, seller, wallet, store } = await fixture({ uncertain: true, completed: false });
  const cancelledOrder = {
    id: "order-1", amountSats: 1300, state: "cancelled_unpaid",
    payment: { id: "payment-1", amountSats: "1300", btcAddress: "bc1qmerchant",
      status: "cancelled", authorization: "pending", settlement: "pending" },
    production: { state: "stopped", result: null },
    cancellation: { state: "cancelled_unpaid", refund: { state: "not_issued", amountSats: null } },
  };
  let polls = 0;
  seller.syncOrder = async () => { polls += 1; return cancelledOrder; };
  seller.requestCancellation = async () => cancelledOrder;
  const campaign = await service.createCampaign({
    input: { objective: "conversion", budgetSats: 3000, autoExecute: true },
    idempotencyKey: "buyer-uncertain-submission-then-cancelled",
  });
  assert.equal(campaign.state, "payment_uncertain");
  const cancelled = await service.cancelCampaign(campaign.id);
  assert.equal(cancelled.state, "cancellation_pending");
  assert.equal(cancelled.spendReservation.status, "uncertain");
  assert.equal(wallet.submitted, 1);
  await store.transaction((state) => {
    state.campaigns[campaign.id].sellerOrder.payment.nextCheckAt = "2027-01-15T08:05:00.000Z";
  });
  const previousPolls = polls;
  await service.pollOnce();
  assert.equal(polls, previousPolls);
  await store.transaction((state) => {
    state.campaigns[campaign.id].sellerOrder.payment.nextCheckAt = "2027-01-15T07:59:00.000Z";
  });
  seller.syncOrder = async () => ({
    ...cancelledOrder,
    state: "refund_review_required",
    payment: { ...cancelledOrder.payment, status: "paid", authorization: "authorized" },
    cancellation: { state: "refund_review_required", refund: { state: "not_issued", amountSats: 1300 } },
  });
  const latePaid = await service.syncCampaign(campaign.id);
  assert.equal(latePaid.state, "refund_review_required");
  assert.equal(latePaid.spentSats, 0);
  assert.equal(latePaid.spendReservation.status, "uncertain");
  assert.equal(latePaid.cancellation.refund.amountSats, 1300);
});

test("a paid invoice without this Buyer's submission receipt is not charged to the Buyer", async () => {
  const { service, store, wallet } = await fixture();
  const campaign = await service.createCampaign({
    input: { objective: "conversion", budgetSats: 3000, autoExecute: false },
    idempotencyKey: "buyer-external-wallet-payment",
  });
  await store.transaction((state) => {
    const current = state.campaigns[campaign.id];
    current.state = "awaiting_payment";
    current.sellerOrder = {
      id: "order-1", amountSats: 1300, state: "awaiting_payment",
      payment: { id: "payment-1", amountSats: "1300", btcAddress: "bc1qmerchant", authorization: "pending", settlement: "pending" },
      production: { state: "locked" },
    };
  });
  const reviewed = await service.syncCampaign(campaign.id);
  assert.equal(reviewed.state, "payment_origin_review_required");
  assert.equal(reviewed.spentSats, 0);
  assert.equal(reviewed.lastError.code, "payment_origin_unverified");
  assert.equal(service.audit(campaign.id).filter((event) => event.type === "payment.authorized").length, 0);
  assert.equal(service.audit(campaign.id).filter((event) => event.type === "payment.origin_review_required").length, 1);
  assert.equal(wallet.submitted, 0);
  assert.equal((await service.executeCampaign(campaign.id)).state, "payment_origin_review_required");
});

test("external payment review does not erase a requested cancellation or invent Buyer spend", async () => {
  const { service, store, seller } = await fixture();
  const campaign = await service.createCampaign({
    input: { objective: "conversion", budgetSats: 3000, autoExecute: false },
    idempotencyKey: "buyer-external-payment-cancellation",
  });
  await store.transaction((state) => {
    const current = state.campaigns[campaign.id];
    current.state = "refund_review_required";
    current.cancellation = { requestedAt: "2027-01-15T07:00:00.000Z", state: "refund_review_required" };
    current.sellerOrder = {
      id: "order-1", amountSats: 1300, state: "refund_review_required",
      payment: { id: "payment-1", amountSats: "1300", btcAddress: "bc1qmerchant", authorization: "pending", settlement: "pending" },
      production: { state: "stopped" },
    };
  });
  const original = seller.syncOrder.bind(seller);
  seller.syncOrder = async () => ({
    ...await original(),
    cancellation: { state: "refund_review_required", refund: { state: "not_issued", amountSats: 1300 } },
  });
  const reviewed = await service.syncCampaign(campaign.id);
  assert.equal(reviewed.state, "refund_review_required");
  assert.equal(reviewed.cancellation.state, "refund_review_required");
  assert.equal(reviewed.paymentOriginReviewAt, "2027-01-15T08:00:00.000Z");
  assert.equal(reviewed.spentSats, 0);
});

test("an older Seller poll cannot roll back a cancellation review", async () => {
  const { service, store, seller } = await fixture();
  const campaign = await service.createCampaign({
    input: { objective: "conversion", budgetSats: 3000 },
    idempotencyKey: "buyer-stale-cancellation-poll",
  });
  await store.transaction((state) => {
    const current = state.campaigns[campaign.id];
    current.state = "refund_review_required";
    current.cancellation = {
      requestedAt: "2027-01-15T07:00:00.000Z",
      state: "refund_review_required",
      refund: { state: "not_issued", amountSats: 1300 },
    };
    current.sellerOrder = {
      id: "order-1", amountSats: 1300, state: "refund_review_required",
      payment: { id: "payment-1", amountSats: "1300", btcAddress: "bc1qmerchant", authorization: "authorized", settlement: "pending" },
      production: { state: "stopped" },
      cancellation: { state: "refund_review_required", refund: { state: "not_issued", amountSats: 1300 } },
    };
    current.paymentAttempt = {
      status: "submitted",
      prepared: { paymentId: "payment-1", validation: { feeSats: 25 } },
      receipt: { instantReceiptId: "platform-receipt-1" },
    };
    current.spentSats = 1325;
  });
  seller.syncOrder = async () => ({
    id: "order-1", amountSats: 1300, state: "paid",
    payment: { id: "payment-1", amountSats: "1300", btcAddress: "bc1qmerchant", authorization: "authorized", settlement: "pending" },
    production: { state: "locked" },
  });
  const result = await service.syncCampaign(campaign.id);
  assert.equal(result.state, "refund_review_required");
  assert.equal(result.cancellation.refund.amountSats, 1300);
  assert.equal(result.sellerOrder.cancellation.state, "refund_review_required");
});

test("repeating cancellation during refund review cannot downgrade the review on Seller outage", async () => {
  const { service, store, seller } = await fixture();
  const campaign = await service.createCampaign({
    input: { objective: "conversion", budgetSats: 3000 },
    idempotencyKey: "buyer-repeat-refund-review-cancellation",
  });
  await store.transaction((state) => {
    const current = state.campaigns[campaign.id];
    current.state = "refund_review_required";
    current.cancellation = {
      requestedAt: "2027-01-15T07:00:00.000Z",
      state: "refund_review_required",
      refund: { state: "not_issued", amountSats: 1300 },
    };
    current.sellerOrder = {
      id: "order-1", amountSats: 1300, state: "refund_review_required",
      payment: { id: "payment-1", amountSats: "1300", btcAddress: "bc1qmerchant", authorization: "authorized", settlement: "pending" },
      production: { state: "stopped" },
      cancellation: { state: "refund_review_required", refund: { state: "not_issued", amountSats: 1300 } },
    };
  });
  seller.requestCancellation = async () => {
    throw Object.assign(new Error("temporary outage"), { code: "seller_unavailable" });
  };
  const repeated = await service.cancelCampaign(campaign.id);
  assert.equal(repeated.state, "refund_review_required");
  assert.equal(repeated.cancellation.refund.amountSats, 1300);
});

test("a timed-out Buyer submission followed by paid remains unattributed until manually reconciled", async () => {
  const { service, wallet } = await fixture({ uncertain: true });
  const campaign = await service.createCampaign({
    input: { objective: "conversion", budgetSats: 3000, autoExecute: true },
    idempotencyKey: "buyer-timeout-then-paid-attribution",
  });
  assert.equal(campaign.state, "payment_origin_review_required");
  assert.equal(campaign.paymentAttempt.status, "uncertain");
  assert.equal(campaign.spentSats, 0);
  assert.equal(campaign.spendReservation.status, "uncertain");
  assert.equal(wallet.submitted, 1);
  await service.resumeCampaign(campaign.id);
  assert.equal(wallet.submitted, 1);
});

test("Buyer rejects drift in the locked Seller order before recording payment", async () => {
  const { service, seller } = await fixture({ completed: false });
  const campaign = await service.createCampaign({
    input: { objective: "conversion", budgetSats: 3000, autoExecute: true },
    idempotencyKey: "buyer-order-intent-drift",
  });
  const original = seller.syncOrder.bind(seller);
  for (const mutate of [
    (order) => { order.id = "other-order"; },
    (order) => { order.quoteId = "other-quote"; },
    (order) => { order.amountSats = 1800; },
    (order) => { order.payment.id = "other-payment"; },
    (order) => { order.payment.amountSats = "1800"; },
    (order) => { order.payment.btcAddress = "bc1qattacker"; },
    (order) => { order.payment.simulated = true; },
  ]) {
    seller.syncOrder = async () => {
      const order = await original();
      mutate(order);
      return order;
    };
    const result = await service.syncCampaign(campaign.id);
    assert.equal(result.lastError.code, "seller_payment_intent_changed");
    assert.equal(result.spentSats, 0);
    assert.equal(result.sellerOrder.id, "order-1");
    assert.equal(result.sellerOrder.payment.btcAddress, "bc1qmerchant");
  }
});

test("Buyer refuses a Seller order whose amount changed after quote acceptance", async () => {
  const { service, seller, wallet } = await fixture({ orderAmountSats: 1600 });
  const campaign = await service.createCampaign({
    input: { objective: "conversion", budgetSats: 3000, autoExecute: true },
    idempotencyKey: "buyer-campaign-amount-mismatch",
  });
  assert.equal(campaign.state, "order_failed");
  assert.equal(campaign.lastError.code, "seller_order_mismatch");
  assert.equal(seller.created, 1);
  assert.equal(wallet.prepared, 0);
  assert.equal(wallet.submitted, 0);
});

test("global daily spend policy blocks an otherwise valid autonomous order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "buyer-spend-test-"));
  const store = new JsonStore(join(directory, "state.json"), { initialState: BUYER_INITIAL_STATE });
  await store.initialize();
  const seller = new FakeSeller();
  const wallet = new FakeWallet();
  const service = new BuyerService({
    store,
    seller,
    wallet,
    decisionEngine: new FixedDecision(),
    policy: { ...policy, maxDailySpendSats: 1_000 },
    clock: () => 1_800_000_000_000,
  });
  const campaign = await service.createCampaign({
    input: { objective: "conversion", budgetSats: 3000, autoExecute: true },
    idempotencyKey: "buyer-daily-limit",
  });
  assert.equal(campaign.state, "spend_blocked");
  assert.equal(campaign.lastError.code, "daily_spend_limit");
  assert.equal(seller.created, 0);
  assert.equal(wallet.prepared, 0);
});

test("restart during submission becomes uncertain and never re-broadcasts", async () => {
  const { service, store, wallet } = await fixture({ completed: false });
  const campaign = await service.createCampaign({
    input: { objective: "conversion", budgetSats: 3000 },
    idempotencyKey: "buyer-campaign-004",
  });
  await store.transaction((state) => {
    const current = state.campaigns[campaign.id];
    current.authorization.autoExecute = true;
    current.state = "submitting_payment";
    current.sellerOrder = {
      id: "order-1",
      amountSats: 1300,
      payment: { id: "payment-1", amountSats: "1300", btcAddress: "bc1qmerchant", authorization: "pending" },
      production: { state: "locked" },
    };
    current.paymentAttempt = {
      status: "submitting",
      prepared: { paymentId: "payment-1", jobId: "job-1", signedPsbtBase64: "signed" },
    };
  });
  const resumed = await service.resumeCampaign(campaign.id);
  assert.equal(resumed.state, "payment_uncertain");
  assert.equal(wallet.submitted, 0);
  assert.equal(service.audit(campaign.id).filter((event) => event.type === "payment.submission_interrupted").length, 1);
});

test("submitted and uncertain payments retain spend reservations and block another pending payment", async () => {
  const { service, wallet } = await fixture({ completed: false });
  const first = await service.createCampaign({
    input: { objective: "conversion", budgetSats: 3000, autoExecute: true },
    idempotencyKey: "buyer-pending-reservation-1",
  });
  const second = await service.createCampaign({
    input: { objective: "conversion", budgetSats: 3000, autoExecute: true },
    idempotencyKey: "buyer-pending-reservation-2",
  });
  assert.equal(first.spendReservation.status, "submitted");
  assert.equal(first.spendReservation.totalSats, 1325);
  assert.equal(second.state, "spend_blocked");
  assert.equal(second.lastError.code, "pending_payment_limit");
  assert.equal(wallet.submitted, 1);
});

test("hot payment kill switch is rechecked after signing and before submission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "buyer-kill-switch-test-"));
  const store = new JsonStore(join(directory, "state.json"), { initialState: BUYER_INITIAL_STATE });
  await store.initialize();
  let enabled = true;
  const wallet = new FakeWallet({ onPrepared: () => { enabled = false; } });
  const service = new BuyerService({
    store,
    seller: new FakeSeller({ completed: false }),
    wallet,
    decisionEngine: new FixedDecision(),
    policy,
    policyLoader: async () => ({ ...policy, paymentsEnabled: enabled }),
    clock: () => 1_800_000_000_000,
  });
  const campaign = await service.createCampaign({
    input: { objective: "conversion", budgetSats: 3000, autoExecute: true },
    idempotencyKey: "buyer-hot-kill-switch",
  });
  assert.equal(campaign.state, "spend_blocked");
  assert.equal(campaign.lastError.code, "payments_disabled");
  assert.equal(wallet.prepared, 1);
  assert.equal(wallet.submitted, 0);
  assert.equal(campaign.spendReservation, null);
});
