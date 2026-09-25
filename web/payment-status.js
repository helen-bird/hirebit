const ACTIVE_RESERVATIONS = new Set(["reserved", "prepared", "submitting", "submitted", "uncertain"]);
const UNCERTAIN_PAYMENTS = new Set(["submitting", "submitted", "uncertain"]);

function sats(value) {
  return Number.isSafeInteger(value) && value >= 0 ? `${value.toLocaleString()} sats` : null;
}

export function paymentStatusView(delegation, demoMode = null) {
  const campaign = delegation?.campaign;
  if (!campaign) return null;

  const payment = campaign.sellerOrder?.payment ?? null;
  const simulated = payment?.simulated === true
    || campaign.paymentAttempt?.receipt?.simulated === true
    || campaign.package?.paymentProof?.simulated === true
    || (payment == null && demoMode === true);
  const originReview = delegation.state === "payment_origin_review_required"
    || campaign.state === "payment_origin_review_required";
  const reservation = campaign.spendReservation;
  const reserved = reservation && (reservation.status === undefined || ACTIVE_RESERVATIONS.has(reservation.status));
  const authorized = payment?.authorization === "authorized" && !originReview;
  const settled = !simulated && authorized && payment?.settlement === "settled"
    && payment.paidAt != null && Array.isArray(payment.txids) && payment.txids.length > 0;
  const uncertain = !authorized && (UNCERTAIN_PAYMENTS.has(campaign.paymentAttempt?.status)
    || ["payment_submitted", "payment_uncertain", "cancellation_pending"].includes(campaign.state));
  const stoppedUnpaid = campaign.state === "cancelled" && !authorized && !originReview && !uncertain;
  const refundPending = delegation.resolution != null
    || ["refund_review_required", "cost_review_required"].includes(campaign.state);
  const reservedAmount = sats(reservation?.totalReservedSats ?? reservation?.totalSats);
  const committedAmount = campaign.spentSats > 0 ? sats(campaign.spentSats) : null;
  const limitAmount = sats(campaign.authorization?.budgetSats ?? campaign.input?.budgetSats);

  const budget = authorized
    ? { label: "Budget", value: `${committedAmount ?? "Payment"} recorded${simulated ? " in demo" : ""}`, state: "done" }
    : reserved
      ? { label: "Budget", value: `${reservedAmount ?? "Amount"} set aside in Hirebit`, state: "active" }
      : { label: "Budget", value: stoppedUnpaid ? "Reservation released" : `${limitAmount ?? "No amount"} · nothing set aside`, state: "idle" };
  const authorization = originReview
    ? { label: "Payment", value: "Payer under review", state: "review" }
    : authorized
      ? { label: "Payment", value: simulated ? "Authorized in demo" : "Authorized by GoBTC", state: "done" }
      : uncertain
        ? { label: "Payment", value: "Checking original payment", state: "review" }
        : { label: "Payment", value: "Not authorized", state: "idle" };
  const settlement = simulated
    ? { label: "Settlement", value: "Not applicable in demo", state: "idle" }
    : settled
      ? { label: "Settlement", value: "Recorded on-chain", state: "done" }
      : authorized
        ? { label: "Settlement", value: "Awaiting on-chain settlement", state: "active" }
        : { label: "Settlement", value: "Not started", state: "idle" };

  let location;
  if (originReview) {
    location = "The Seller invoice reports paid, but this Buyer's payment has not been verified. No Buyer debit is recorded while the source is checked.";
  } else if (simulated) {
    location = "Demo only: 0 BTC transferred. The status above is an internal demo record, not Bitcoin held on-chain.";
  } else if (settled) {
    location = "GoBTC has recorded the on-chain settlement.";
  } else if (authorized) {
    location = "BTC remains in the Buyer's 2-of-3 multisig wallet until GoBTC settles the payment on-chain.";
  } else if (uncertain) {
    location = "The original payment is being reconciled. Hirebit will not submit another payment while its outcome is unclear.";
  } else if (demoMode === false || payment?.simulated === false) {
    location = "No BTC has been authorized for this order. Any available funds remain in the Buyer's multisig wallet.";
  } else {
    location = "No payment has been authorized yet.";
  }

  return {
    mode: simulated ? "DEMO · 0 BTC MOVED" : payment?.simulated === false || demoMode === false ? "BITCOIN" : "PAYMENT",
    steps: [budget, authorization, settlement],
    location,
    note: refundPending ? "A refund or delivery issue is under review. No refund payout has been issued." : null,
  };
}
