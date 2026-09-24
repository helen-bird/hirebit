const HOUR = 60 * 60 * 1000;

function ageHours(value, now) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp > now) return null;
  return Math.round(((now - timestamp) / HOUR) * 10) / 10;
}

function safeId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,120}$/u.test(value)
    ? value : "invalid-id";
}

function expiryIso(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    const date = new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function issue({ kind, entity, id, since, now, action, amountSats = null }) {
  return {
    kind, entity, id: safeId(id), since: typeof since === "string" ? since : null,
    ageHours: ageHours(since, now), action,
    ...(Number.isSafeInteger(amountSats) && amountSats >= 0 ? { amountSats } : {}),
  };
}

/** Read-only operational triage. Never treats an issue as proof of a refund or chain settlement. */
export function transactionReview({ buyer = {}, seller = {}, intake = {}, now = Date.now() } = {}) {
  const issues = [];
  const authorizedAt = new Map();
  for (const event of seller.audit ?? []) {
    if (event?.type !== "payment.authorized" || typeof event.orderId !== "string") continue;
    const prior = authorizedAt.get(event.orderId);
    if (prior === undefined || Date.parse(event.at) < Date.parse(prior)) authorizedAt.set(event.orderId, event.at);
  }
  for (const order of Object.values(seller.orders ?? {})) {
    const payment = order?.payment ?? {};
    const production = order?.production ?? {};
    const cancellation = order?.cancellation ?? {};
    if (["refund_review_required", "cost_review_required"].includes(cancellation.state)) {
      issues.push(issue({
        kind: cancellation.state, entity: "seller_order", id: order.id,
        since: cancellation.requestedAt, now, action: "review_payment_and_documented_costs",
        amountSats: order.amountSats,
      }));
    }
    const paidAt = authorizedAt.get(order.id);
    if (payment.simulated !== true && payment.authorization === "authorized"
      && payment.settlement !== "settled" && ageHours(paidAt, now) >= 24) {
      issues.push(issue({
        kind: "settlement_followup", entity: "seller_order", id: order.id,
        since: paidAt, now, action: "check_original_provider_payment",
      }));
    }
    if (payment.authorization === "authorized" && production.state === "failed") {
      const code = production.error?.code;
      issues.push(issue({
        kind: "paid_production_failed", entity: "seller_order", id: order.id,
        since: production.failedAt ?? order.updatedAt, now,
        action: code === "production_voice_submission_uncertain" ? "reconcile_paid_voice_attempt_no_resubmit"
          : code === "google_veo_submission_uncertain" ? "reconcile_veo_operation_no_resubmit"
            : "reconcile_build_before_retry",
      }));
    }
    if (production.state === "producing" && ageHours(production.startedAt, now) >= 1) {
      issues.push(issue({
        kind: "production_stalled", entity: "seller_order", id: order.id,
        since: production.startedAt, now, action: "check_existing_build_without_resubmitting",
      }));
    }
    if (payment.status === "initiated" && payment.expiredLocally === true) {
      issues.push(issue({
        kind: "invoice_expiry_unconfirmed", entity: "seller_order", id: order.id,
        since: expiryIso(payment.expiresAt), now, action: "query_provider_before_releasing_reservation",
      }));
    }
  }
  for (const campaign of Object.values(buyer.campaigns ?? {})) {
    if (["payment_uncertain", "payment_origin_review_required", "fulfillment_failed", "packaging_failed"].includes(campaign?.state)) {
      issues.push(issue({
        kind: campaign.state, entity: "buyer_campaign", id: campaign.id,
        since: campaign.updatedAt, now,
        action: campaign.state === "payment_uncertain" ? "reconcile_original_payment_no_resubmit"
          : campaign.state === "payment_origin_review_required" ? "verify_payer_source_and_refund_owner_no_resubmit"
          : "check_original_fulfillment_and_evidence",
      }));
    }
    if (campaign?.state === "cancellation_pending" && ageHours(campaign.cancellation?.requestedAt, now) >= 0.1) {
      issues.push(issue({
        kind: "cancellation_stalled", entity: "buyer_campaign", id: campaign.id,
        since: campaign.cancellation.requestedAt, now, action: "reconcile_seller_order_and_payment",
      }));
    }
  }
  for (const delegation of Object.values(intake.delegations ?? {})) {
    if (delegation?.resolution?.state === "human_review_required") {
      issues.push(issue({
        kind: "dispute_review", entity: "delegation", id: delegation.id,
        since: delegation.resolution.requestedAt, now, action: "review_frozen_delivery_evidence",
      }));
    }
    if (delegation?.state === "cancellation_pending" && ageHours(delegation.cancellationRequestedAt, now) >= 0.1) {
      issues.push(issue({
        kind: "delegation_cancellation_stalled", entity: "delegation", id: delegation.id,
        since: delegation.cancellationRequestedAt, now, action: "reconcile_linked_campaign",
      }));
    }
  }
  issues.sort((left, right) => left.entity.localeCompare(right.entity) || left.id.localeCompare(right.id) || left.kind.localeCompare(right.kind));
  return { checkedAt: new Date(now).toISOString(), issueCount: issues.length, issues };
}
