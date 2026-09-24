import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { transactionReview } from "../src/transaction-review.mjs";

test("review command keeps local and public demo state profiles separate", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hirebit-review-profiles-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const buyerDir = join(directory, "buyer");
  const sellerDir = join(directory, "seller");
  await Promise.all([mkdir(buyerDir), mkdir(sellerDir)]);
  for (const [prefix, id] of [["demo", "cmp_local"], ["public-demo", "cmp_public"]]) {
    await writeFile(join(buyerDir, `${prefix}-state.json`), JSON.stringify({
      campaigns: { [id]: { id, state: "payment_uncertain", updatedAt: "2026-09-24T11:00:00.000Z" } },
    }));
    await writeFile(join(buyerDir, `${prefix}-intake-state.json`), JSON.stringify({ delegations: {} }));
    await writeFile(join(sellerDir, `${prefix}-state.json`), JSON.stringify({ orders: {}, audit: [] }));
  }
  const script = resolve(import.meta.dirname, "../scripts/transaction-review.mjs");
  for (const [mode, expectedId] of [["demo", "cmp_local"], ["public-demo", "cmp_public"]]) {
    const output = execFileSync(process.execPath, [script, mode], {
      encoding: "utf8", env: { ...process.env, BUYER_DATA_DIR: buyerDir, SELLER_DATA_DIR: sellerDir },
    });
    const report = JSON.parse(output);
    assert.equal(report.mode, mode);
    assert.deepEqual(report.issues.map((item) => item.id), [expectedId]);
  }
});

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
