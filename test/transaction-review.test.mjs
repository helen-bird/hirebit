import assert from "node:assert/strict";
import test from "node:test";

import { transactionReview } from "../src/transaction-review.mjs";

test("review queue surfaces obligations without exposing payment identifiers or secrets", () => {
  const now = Date.parse("2026-09-24T12:00:00.000Z");
  const report = transactionReview({
    now,
    seller: {
      audit: [{ type: "payment.authorized", orderId: "ord_1", at: "2026-09-22T10:00:00.000Z" }],
      orders: {
        ord_1: {
          id: "ord_1", amountSats: 1660, updatedAt: "2026-09-24T11:00:00.000Z",
          payment: { id: "secret-payment-id", btcAddress: "secret-address", authorization: "authorized", settlement: "pending" },
          production: { state: "failed", failedAt: "2026-09-24T10:00:00.000Z", error: { code: "production_voice_submission_uncertain" } },
          cancellation: { state: "refund_review_required", requestedAt: "2026-09-24T09:00:00.000Z" },
        },
      },
    },
    buyer: { campaigns: { cmp_1: { id: "cmp_1", state: "payment_uncertain", updatedAt: "2026-09-24T11:00:00.000Z", signedPsbtBase64: "secret-psbt" } } },
    intake: { delegations: { dlg_1: { id: "dlg_1", resolution: { state: "human_review_required", requestedAt: "2026-09-24T08:00:00.000Z", reason: "private-customer-text" } } } },
  });
  assert.deepEqual(report.issues.map((item) => item.kind), [
    "payment_uncertain", "dispute_review", "paid_production_failed", "refund_review_required", "settlement_followup",
  ]);
  assert.equal(report.issues.find((item) => item.kind === "paid_production_failed").action, "reconcile_paid_voice_attempt_no_resubmit");
  assert.equal(report.issues.find((item) => item.kind === "settlement_followup").ageHours, 50);
  for (const sensitive of ["secret-payment-id", "secret-address", "secret-psbt", "private-customer-text"]) {
    assert.equal(JSON.stringify(report).includes(sensitive), false);
  }
});

test("recent settlement and healthy paid production are not reported as failures", () => {
  const now = Date.parse("2026-09-24T12:00:00.000Z");
  const report = transactionReview({
    now,
    seller: {
      audit: [{ type: "payment.authorized", orderId: "ord_2", at: "2026-09-24T10:00:00.000Z" }],
      orders: { ord_2: { id: "ord_2", payment: { authorization: "authorized", settlement: "pending" }, production: { state: "completed" } } },
    },
  });
  assert.equal(report.issueCount, 0);
});

test("unattributed paid invoice is queued for payer and refund-owner reconciliation", () => {
  const report = transactionReview({
    buyer: { campaigns: { cmp_review: {
      id: "cmp_review", state: "payment_origin_review_required", updatedAt: "2026-09-24T11:00:00.000Z",
      sellerOrder: { payment: { id: "private-payment-id" } },
    } } },
    now: Date.parse("2026-09-24T12:00:00.000Z"),
  });
  assert.equal(report.issues[0].kind, "payment_origin_review_required");
  assert.equal(report.issues[0].action, "verify_payer_source_and_refund_owner_no_resubmit");
  assert.equal(JSON.stringify(report).includes("private-payment-id"), false);
});
