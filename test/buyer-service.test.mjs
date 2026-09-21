import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BuyerService, BUYER_INITIAL_STATE } from "../src/buyer/buyer-service.mjs";
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
        amountSats: 1300,
        state: "awaiting_payment",
        payment: { id: "payment-1", authorization: "pending", settlement: "pending" },
        production: { state: "locked", result: null },
      };
    }
    return {
      id: "order-1",
      amountSats: 1300,
      state: "completed",
      payment: { id: "payment-1", authorization: "authorized", settlement: "pending", txids: [] },
      production: { state: "completed", result: { artifacts: [{ name: "final.mp4" }] } },
    };
  }
  async retryProduction() {
    this.retried += 1;
    return await this.syncOrder();
  }
}

class FakeWallet {
  constructor({ uncertain = false, onPrepared = null } = {}) {
    this.prepared = 0;
    this.submitted = 0;
    this.uncertain = uncertain;
    this.onPrepared = onPrepared;
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
      validation: { feeSats: 25 },
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
    decisionEngine: new FixedDecision(),
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
      payment: { id: "payment-1", authorization: "authorized", settlement: "pending" },
      production: {
        state: "failed",
        error: { code: "seller_unavailable", message: "Seller request timed out" },
      },
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
    },
  });
  assert.equal(completed.state, "completed");
  assert.equal(seller.created, 1);
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
      payment: { id: "payment-1", authorization: "pending" },
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
