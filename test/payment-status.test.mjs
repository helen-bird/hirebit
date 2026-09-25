import assert from "node:assert/strict";
import test from "node:test";

import { paymentStatusView } from "../web/payment-status.js";

function delegation(overrides = {}) {
  return {
    state: "in_progress",
    campaign: {
      state: "decision_ready",
      authorization: { budgetSats: 2000 },
      spentSats: 0,
      spendReservation: null,
      sellerOrder: null,
      ...overrides,
    },
  };
}

test("payment status is absent before a campaign and does not imply a reservation at decision time", () => {
  assert.equal(paymentStatusView({ state: "in_progress", campaign: null }, true), null);
  const view = paymentStatusView(delegation(), true);
  assert.match(view.steps[0].value, /nothing set aside/u);
  assert.equal(view.steps[1].value, "Not authorized");
  assert.match(view.location, /0 BTC transferred/u);
  const unknownMode = paymentStatusView(delegation());
  assert.equal(unknownMode.mode, "PAYMENT");
  assert.equal(unknownMode.location, "No payment has been authorized yet.");
});

test("demo reservation is internal bookkeeping, not a Bitcoin lock", () => {
  const view = paymentStatusView(delegation({
    state: "awaiting_payment",
    spendReservation: { status: "reserved", totalReservedSats: 1660 },
    sellerOrder: { payment: { simulated: true, authorization: "pending", settlement: "pending" } },
  }), true);
  assert.match(view.steps[0].value, /1,660 sats set aside in Hirebit/u);
  assert.equal(view.steps[1].value, "Not authorized");
  assert.equal(view.steps[2].value, "Not applicable in demo");
  assert.match(view.location, /not Bitcoin held on-chain/u);
  const legacy = paymentStatusView(delegation({
    spendReservation: { totalReservedSats: 1660 },
  }), true);
  assert.match(legacy.steps[0].value, /1,660 sats set aside/u);
});

test("demo authorization never appears as an on-chain settlement", () => {
  const view = paymentStatusView(delegation({
    state: "fulfillment",
    spentSats: 1660,
    spendReservation: { status: "committed", totalSats: 1660 },
    sellerOrder: { payment: { simulated: true, authorization: "authorized", settlement: "pending" } },
  }), true);
  assert.equal(view.steps[1].value, "Authorized in demo");
  assert.equal(view.steps[2].value, "Not applicable in demo");
  assert.match(view.location, /0 BTC transferred/u);
});

test("real authorization leaves funds in Buyer multisig until separately recorded settlement", () => {
  const item = delegation({
    state: "fulfillment",
    spentSats: 1660,
    sellerOrder: { payment: { simulated: false, authorization: "authorized", settlement: "pending" } },
  });
  const pending = paymentStatusView(item, false);
  assert.equal(pending.steps[1].value, "Authorized by GoBTC");
  assert.equal(pending.steps[2].value, "Awaiting on-chain settlement");
  assert.match(pending.location, /Buyer's 2-of-3 multisig wallet/u);

  item.campaign.sellerOrder.payment = {
    ...item.campaign.sellerOrder.payment,
    settlement: "settled",
    paidAt: "2026-09-25T00:00:00.000Z",
    txids: ["chain-txid"],
  };
  const settled = paymentStatusView(item, false);
  assert.equal(settled.steps[2].value, "Recorded on-chain");
});

test("uncertain payment and unverified payer never claim Buyer debit", () => {
  const uncertain = paymentStatusView(delegation({
    state: "payment_uncertain",
    spendReservation: { status: "uncertain", totalSats: 1660 },
    paymentAttempt: { status: "uncertain" },
    sellerOrder: { payment: { simulated: false, authorization: "pending", settlement: "pending" } },
  }), false);
  assert.equal(uncertain.steps[1].value, "Checking original payment");
  assert.match(uncertain.location, /will not submit another payment/u);

  const unverified = paymentStatusView({
    ...delegation({
      state: "payment_origin_review_required",
      sellerOrder: { payment: { simulated: false, authorization: "authorized", settlement: "pending" } },
    }),
    state: "payment_origin_review_required",
  }, false);
  assert.equal(unverified.steps[1].value, "Payer under review");
  assert.match(unverified.location, /No Buyer debit is recorded/u);
});

test("cancelled unpaid and refund review remain distinct", () => {
  const cancelled = paymentStatusView(delegation({ state: "cancelled" }), false);
  assert.equal(cancelled.steps[0].value, "Reservation released");
  assert.equal(cancelled.steps[1].value, "Not authorized");

  const review = paymentStatusView({
    ...delegation({
      state: "refund_review_required",
      spentSats: 1660,
      sellerOrder: { payment: { simulated: true, authorization: "authorized", settlement: "pending" } },
    }),
    resolution: { state: "human_review_required" },
  }, true);
  assert.match(review.note, /No refund payout has been issued/u);
});
