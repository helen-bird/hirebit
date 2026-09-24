import { createHash, randomUUID } from "node:crypto";

import { AppError } from "../errors.mjs";
import { validateRequest } from "./decision-engine.mjs";

export const BUYER_INITIAL_STATE = Object.freeze({
  version: 1,
  campaigns: {},
  idempotency: {},
  audit: [],
});

function nowIso(clock) {
  return new Date(clock()).toISOString();
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

export function purchaseSelectionDigest(campaign) {
  const selected = campaign?.decision?.selected;
  if (typeof selected?.productId !== "string" || selected.quote == null) return null;
  return digest({
    productId: selected.productId,
    planId: selected.planId ?? null,
    scope: selected.scope ?? null,
    totalAuthorizedSats: selected.totalAuthorizedSats ?? null,
    quote: selected.quote,
  });
}

function audit(state, clock, type, campaignId, data = {}) {
  state.audit.push({ id: `evt_${randomUUID()}`, at: nowIso(clock), type, campaignId, data });
}

function publicCampaign(campaign) {
  const result = structuredClone(campaign);
  if (result.paymentAttempt?.prepared) delete result.paymentAttempt.prepared.signedPsbtBase64;
  result.purchaseSelectionDigest = purchaseSelectionDigest(result);
  return result;
}

function errorView(error, clock) {
  return {
    code: error.code ?? "internal_error",
    message: error.message,
    at: nowIso(clock),
  };
}

function discardSignedPsbt(campaign) {
  const prepared = campaign.paymentAttempt?.prepared;
  if (typeof prepared?.signedPsbtBase64 !== "string") return null;
  const signedPsbtSha256 = createHash("sha256").update(prepared.signedPsbtBase64).digest("hex");
  delete prepared.signedPsbtBase64;
  prepared.signedPsbtSha256 = signedPsbtSha256;
  return signedPsbtSha256;
}

const ACTIVE_RESERVATION_STATES = new Set(["reserved", "prepared", "submitting", "submitted", "uncertain"]);
const TERMINAL_UNPAID_STATUSES = new Set(["expired", "cancelled", "canceled", "failed", "rejected"]);
const CANCELLATION_STATES = new Set(["cancelled", "cancellation_pending", "refund_review_required", "cost_review_required"]);

function reservationTotal(reservation) {
  if (reservation === null || reservation === undefined) return 0;
  return Number(reservation.totalSats ?? reservation.totalReservedSats ?? reservation.amountSats ?? 0);
}

function activeReservation(reservation) {
  if (reservation === null || reservation === undefined) return false;
  return reservation.status === undefined || ACTIVE_RESERVATION_STATES.has(reservation.status);
}

function exceedsConfiguredLimit(amountSats, limitSats) {
  return Number.isSafeInteger(limitSats) && limitSats > 0 && amountSats > limitSats;
}

function validateSellerOrder(order, quote, campaign, policy, now) {
  if (!Number.isSafeInteger(order?.amountSats) || order.amountSats <= 0) {
    throw new AppError("seller_order_invalid", "Seller returned an invalid order amount", 502);
  }
  if (order.amountSats !== quote.amountSats) {
    throw new AppError("seller_order_mismatch", "Seller order amount differs from the accepted quote", 502, {
      quoteAmountSats: quote.amountSats,
      orderAmountSats: order.amountSats,
    });
  }
  if (exceedsConfiguredLimit(order.amountSats, policy.maxPerOrderSats)
    || order.amountSats > campaign.authorization.budgetSats) {
    throw new AppError("spend_not_authorized", "Seller order exceeds Buyer spend authorization", 403);
  }
  if (typeof order.payment?.id !== "string" || order.payment.id === "") {
    throw new AppError("seller_order_invalid", "Seller order is missing its GoBTC payment ID", 502);
  }
  if (order.payment.amountSats === undefined || Number(order.payment.amountSats) !== order.amountSats) {
    throw new AppError("seller_payment_mismatch", "Seller payment amount differs from its order amount", 502);
  }
  if (typeof order.payment.btcAddress !== "string" || !order.payment.btcAddress.startsWith("bc1")) {
    throw new AppError("seller_payment_invalid", "Seller payment is missing a Bitcoin mainnet recipient address", 502);
  }
  if (!["initiated", "paid"].includes(order.payment.status)) {
    throw new AppError("seller_payment_invalid", "Seller payment is not available for new signing or payer review", 502, {
      status: order.payment.status ?? null,
    });
  }
  const numericExpiry = typeof order.payment.expiresAt === "number" || /^\d+$/u.test(order.payment.expiresAt ?? "")
    ? Number(order.payment.expiresAt)
    : null;
  const expiresAt = numericExpiry === null
    ? Date.parse(order.payment.expiresAt)
    : numericExpiry < 10_000_000_000 ? numericExpiry * 1000 : numericExpiry;
  if (!Number.isFinite(expiresAt) || (order.payment.status === "initiated" && expiresAt <= now)) {
    throw new AppError("seller_payment_expired", "Seller payment is expired or has an invalid expiry", 502);
  }
}

function assertSamePaymentIntent(order, original) {
  if (order?.id !== original.id
    || order?.quoteId !== original.quoteId
    || order?.externalId !== original.externalId
    || order?.amountSats !== original.amountSats
    || order.payment?.id !== original.payment?.id
    || String(order.payment?.amountSats) !== String(original.payment?.amountSats)
    || order.payment?.btcAddress !== original.payment?.btcAddress
    || order.payment?.simulated !== original.payment?.simulated
    || order.payment?.network !== original.payment?.network) {
    throw new AppError("seller_payment_intent_changed", "Seller payment intent changed after the order was accepted", 502);
  }
}

function assertCancellationProgress(order, original) {
  const previous = original?.cancellation?.state;
  if (previous == null) return;
  const incoming = order?.cancellation?.state;
  const progress = { stop_requested: 1, cancelled_unpaid: 2, refund_review_required: 3, cost_review_required: 3 };
  if (incoming == null || progress[incoming] === undefined
    || progress[previous] === undefined || progress[incoming] < progress[previous]
    || (progress[previous] === 3 && incoming !== previous)) {
    throw new AppError("seller_cancellation_regressed", "Seller cancellation state needs reconciliation", 502);
  }
}

function hasBuyerSubmissionReceipt(campaign, order) {
  const attempt = campaign.paymentAttempt;
  return attempt?.status === "submitted"
    && attempt.prepared?.paymentId === order.payment.id
    && typeof attempt.receipt?.instantReceiptId === "string"
    && attempt.receipt.instantReceiptId !== "";
}

function cancellationResolution(state, clock, campaignId, campaign, order) {
  const resolution = order.cancellation?.state;
  const submissionMayHaveReachedProvider = ["submitting", "submitted", "uncertain"].includes(campaign.paymentAttempt?.status)
    || campaign.spentSats > 0;
  const conflictingUnpaidCancellation = resolution === "cancelled_unpaid" && submissionMayHaveReachedProvider;
  campaign.state = resolution === "cancelled_unpaid" && !conflictingUnpaidCancellation ? "cancelled"
    : resolution === "refund_review_required" ? "refund_review_required"
      : resolution === "cost_review_required" ? "cost_review_required" : "cancellation_pending";
  campaign.cancellation = {
    ...campaign.cancellation,
    state: campaign.state,
    refund: order.cancellation?.refund ?? campaign.cancellation?.refund ?? null,
    productionStartedAt: order.cancellation?.productionStartedAt ?? campaign.cancellation?.productionStartedAt ?? null,
  };
  if (conflictingUnpaidCancellation) {
    if (campaign.spentSats === 0) {
      const feeSats = Number(campaign.paymentAttempt?.prepared?.validation?.feeSats
        ?? campaign.decision?.selected?.quote?.sellerFeeAllowanceSats ?? 0);
      campaign.spendReservation ??= {
        amountSats: order.amountSats,
        feeSats,
        totalSats: order.amountSats + feeSats,
      };
      campaign.spendReservation.status = "uncertain";
    }
    campaign.lastError = {
      code: "payment_status_conflicts_submission",
      message: "Seller reports an unpaid cancellation after Buyer payment submission; payment needs reconciliation",
      at: nowIso(clock),
    };
    if (campaign.paymentStatusConflictAt == null) {
      campaign.paymentStatusConflictAt = nowIso(clock);
      audit(state, clock, "payment.status_conflicts_submission", campaignId, {
        paymentId: order.payment?.id,
        sellerStatus: order.payment?.status ?? null,
      });
    }
  }
  if (campaign.state === "cancelled") {
    campaign.cancelledAt ??= nowIso(clock);
    campaign.spendReservation = null;
  }
}

export class BuyerService {
  constructor({
    store,
    seller,
    wallet,
    decisionEngine,
    completer = null,
    policy,
    policyLoader = null,
    paymentFeeReserveSats = null,
    clock = Date.now,
  }) {
    this.store = store;
    this.seller = seller;
    this.wallet = wallet;
    this.decisionEngine = decisionEngine;
    this.completer = completer;
    this.policy = policy;
    this.policyLoader = policyLoader;
    this.paymentFeeReserveSats = Number.isSafeInteger(paymentFeeReserveSats) ? paymentFeeReserveSats : null;
    this.clock = clock;
    this.executionTasks = new Map();
    this.completionTasks = new Map();
    this.pollTimer = undefined;
    this.polling = false;
  }

  async readiness() {
    const [seller, wallet] = await Promise.all([this.seller.health(), this.wallet.readiness()]);
    const completion = this.completer?.readiness?.() ?? { configured: false };
    return {
      ready: seller.reachable === true && wallet.configured === true && completion.configured === true,
      policy: {
        version: this.policy.version,
        sellerOrigin: this.seller.origin,
        maxPerOrderSats: this.policy.maxPerOrderSats ?? null,
        maxCampaignSats: this.policy.maxCampaignSats,
        maxDailySpendSats: this.policy.maxDailySpendSats,
        maxLifetimeSpendSats: this.policy.maxLifetimeSpendSats,
        maxPendingPayments: this.policy.maxPendingPayments,
        paymentsEnabled: this.policy.paymentsEnabled !== false,
        defaultAutoExecute: this.policy.defaultAutoExecute,
      },
      seller,
      wallet,
      completion,
    };
  }

  async createCampaign({ input: rawInput, idempotencyKey, onCreated = null }) {
    if (typeof idempotencyKey !== "string" || idempotencyKey.trim().length < 8 || idempotencyKey.length > 200) {
      throw new AppError("invalid_idempotency_key", "Idempotency-Key must contain 8-200 characters");
    }
    const input = validateRequest({
      ...rawInput,
      autoExecute: rawInput?.autoExecute ?? this.policy.defaultAutoExecute,
    });
    const key = idempotencyKey.trim();
    const inputHash = digest(input);
    const created = await this.store.transaction((state) => {
      const existingId = state.idempotency[key];
      if (existingId !== undefined) {
        const existing = state.campaigns[existingId];
        if (existing.inputHash !== inputHash) {
          throw new AppError("idempotency_conflict", "Idempotency-Key is already bound to another campaign", 409);
        }
        return { campaign: existing, isNew: false };
      }
      const id = `cmp_${randomUUID()}`;
      const campaign = {
        id,
        state: "analyzing",
        createdAt: nowIso(this.clock),
        updatedAt: nowIso(this.clock),
        input,
        inputHash,
        authorization: {
          autoExecute: input.autoExecute,
          budgetSats: input.budgetSats,
          authorizedAt: input.autoExecute ? nowIso(this.clock) : null,
          scope: "one_campaign_one_order",
        },
        decision: null,
        sellerOrder: null,
        paymentAttempt: null,
        spentSats: 0,
        remainingBudgetSats: input.budgetSats,
        result: null,
        fulfillmentResult: null,
        package: null,
        lastError: null,
      };
      state.campaigns[id] = campaign;
      state.idempotency[key] = id;
      audit(state, this.clock, "campaign.created", id, {
        objective: input.objective,
        budgetSats: input.budgetSats,
        autoExecute: input.autoExecute,
      });
      return { campaign, isNew: true };
    });
    if (onCreated !== null) await onCreated(publicCampaign(created.campaign));
    const linked = this.getCampaign(created.campaign.id);
    if (!created.isNew || CANCELLATION_STATES.has(linked.state)) return linked;

    let campaign = await this.#evaluate(created.campaign.id);
    if (campaign.state === "decision_ready" && campaign.authorization.autoExecute) {
      campaign = await this.executeCampaign(campaign.id);
    }
    return campaign;
  }

  getCampaign(campaignId) {
    const campaign = this.store.snapshot().campaigns[campaignId];
    if (campaign === undefined) throw new AppError("campaign_not_found", "Campaign not found", 404);
    return publicCampaign(campaign);
  }

  audit(campaignId) {
    const state = this.store.snapshot();
    if (state.campaigns[campaignId] === undefined) throw new AppError("campaign_not_found", "Campaign not found", 404);
    return state.audit.filter((event) => event.campaignId === campaignId);
  }

  async cancelCampaign(campaignId) {
    const pending = await this.store.transaction((state) => {
      const campaign = state.campaigns[campaignId];
      if (campaign === undefined) throw new AppError("campaign_not_found", "Campaign not found", 404);
      if (["completed", "cancelled", "refund_review_required", "cost_review_required"].includes(campaign.state)) {
        return publicCampaign(campaign);
      }
      const mayHaveRemoteOrder = campaign.cancellation?.orderMayExist === true
        || campaign.state === "ordering" || campaign.sellerOrder !== null;
      campaign.state = mayHaveRemoteOrder ? "cancellation_pending" : "cancelled";
      const firstRequest = campaign.cancellation == null;
      campaign.cancellation ??= { requestedAt: nowIso(this.clock), state: campaign.state, orderMayExist: mayHaveRemoteOrder };
      if (!mayHaveRemoteOrder) {
        campaign.cancelledAt = nowIso(this.clock);
        campaign.spendReservation = null;
      }
      discardSignedPsbt(campaign);
      campaign.updatedAt = nowIso(this.clock);
      if (firstRequest) audit(state, this.clock, mayHaveRemoteOrder ? "campaign.cancellation_requested" : "campaign.cancelled", campaignId);
      return publicCampaign(campaign);
    });
    if (["cancelled", "refund_review_required", "cost_review_required"].includes(pending.state)) return pending;
    if (pending.sellerOrder === null) {
      try {
        const quote = pending.decision?.selected?.quote;
        if (quote === undefined) return pending;
        const order = await this.seller.createOrder(quote.id, `buyer-${campaignId}-${quote.id}`);
        validateSellerOrder(order, quote, pending, this.policy, this.clock());
        await this.store.transaction((state) => {
          const current = state.campaigns[campaignId];
          if (current.sellerOrder !== null) assertSamePaymentIntent(order, current.sellerOrder);
          current.sellerOrder = order;
          current.updatedAt = nowIso(this.clock);
        });
        return await this.cancelCampaign(campaignId);
      } catch (error) {
        await this.store.transaction((state) => {
          state.campaigns[campaignId].cancellation.lastError = errorView(error, this.clock);
        });
        return this.getCampaign(campaignId);
      }
    }
    try {
      const order = await this.seller.requestCancellation(pending.sellerOrder.id);
      const reconciled = await this.store.transaction((state) => {
        const current = state.campaigns[campaignId];
        assertSamePaymentIntent(order, current.sellerOrder);
        assertCancellationProgress(order, current.sellerOrder);
        current.sellerOrder = order;
        cancellationResolution(state, this.clock, campaignId, current, order);
        current.updatedAt = nowIso(this.clock);
        audit(state, this.clock, "campaign.cancellation_reconciled", campaignId, { state: current.state });
        return publicCampaign(current);
      });
      return ["refund_review_required", "cost_review_required"].includes(reconciled.state)
        ? await this.syncCampaign(campaignId) : reconciled;
    } catch (error) {
      await this.store.transaction((state) => {
        const current = state.campaigns[campaignId];
        current.cancellation.lastError = errorView(error, this.clock);
        current.updatedAt = nowIso(this.clock);
      });
      return this.getCampaign(campaignId);
    }
  }

  async retryFulfillment(campaignId) {
    const campaign = this.getCampaign(campaignId);
    if (campaign.state !== "fulfillment_failed" || campaign.sellerOrder === null) {
      throw new AppError("fulfillment_retry_not_expected", "Only a failed paid fulfillment can be retried", 409);
    }

    // The Seller request may have outlived Buyer's HTTP timeout. Reconcile the
    // durable order first so a completed or still-running build is never
    // mistaken for a reason to start production again.
    const reconciled = await this.syncCampaign(campaignId);
    if (reconciled.state !== "fulfillment_failed") return reconciled;
    const productionError = reconciled.sellerOrder?.production?.error?.code;
    if (reconciled.sellerOrder?.production?.state !== "failed"
      || reconciled.lastError?.code !== productionError) {
      return reconciled;
    }
    if (["google_veo_generation_failed", "google_veo_output_invalid"].includes(productionError)) {
      throw new AppError(
        "production_review_required",
        "The Veo operation ended without a usable video; review the input before any new generation",
        409,
      );
    }
    await this.seller.retryProduction(reconciled.sellerOrder.id);
    return await this.syncCampaign(campaignId);
  }

  async executeCampaign(campaignId, options = {}) {
    const existing = this.executionTasks.get(campaignId);
    if (existing !== undefined) return await existing;
    const task = this.#execute(campaignId, options).finally(() => this.executionTasks.delete(campaignId));
    this.executionTasks.set(campaignId, task);
    return await task;
  }

  async resumeCampaign(campaignId) {
    let campaign = this.getCampaign(campaignId);
    if (campaign.state === "submitting_payment") {
      campaign = await this.store.transaction((state) => {
        const current = state.campaigns[campaignId];
        current.state = "payment_uncertain";
        current.paymentAttempt.status = "uncertain";
        current.paymentAttempt.error = {
          code: "submission_interrupted",
          message: "Process stopped while payment submission outcome was unknown",
          at: nowIso(this.clock),
        };
        current.updatedAt = nowIso(this.clock);
        audit(state, this.clock, "payment.submission_interrupted", campaignId, {
          policy: "reconcile seller status; never blindly resubmit",
        });
        return publicCampaign(current);
      });
    }
    if (["analyzing", "decision_failed"].includes(campaign.state)) {
      campaign = await this.#evaluate(campaignId);
    }
    if (campaign.state === "decision_ready" && !campaign.authorization.autoExecute) return campaign;
    if (["completed", "cancelled", "fulfillment_failed", "payment_origin_review_required"].includes(campaign.state)) return campaign;
    if (CANCELLATION_STATES.has(campaign.state)) return await this.cancelCampaign(campaignId);
    return await this.executeCampaign(campaignId);
  }

  async recover() {
    const recoverable = Object.values(this.store.snapshot().campaigns).filter((campaign) => (
      campaign.state === "submitting_payment"
      || campaign.state === "analyzing"
      || ["packaging", "packaging_failed"].includes(campaign.state)
      || campaign.authorization?.autoExecute === true
      || campaign.authorization?.purchaseConfirmedAt != null
    ) && !["completed", "cancelled", "fulfillment_failed"].includes(campaign.state));
    return await Promise.allSettled(recoverable.map((campaign) => this.resumeCampaign(campaign.id)));
  }

  async syncCampaign(campaignId) {
    const campaign = this.getCampaign(campaignId);
    if (["cancelled", "refund_review_required", "cost_review_required"].includes(campaign.state)) {
      const next = Date.parse(campaign.sellerOrder?.payment?.nextCheckAt ?? "");
      if (Number.isFinite(next) && next > this.clock()) return campaign;
    }
    if (campaign.state === "cancellation_pending") {
      const next = Date.parse(campaign.sellerOrder?.payment?.nextCheckAt ?? "");
      if ((campaign.sellerOrder?.cancellation?.state === "stop_requested" || campaign.paymentStatusConflictAt != null)
        && Number.isFinite(next) && next > this.clock()) return campaign;
      if (campaign.paymentStatusConflictAt == null) return await this.cancelCampaign(campaignId);
    }
    if (campaign.sellerOrder === null) return campaign;
    try {
      const order = await this.seller.syncOrder(campaign.sellerOrder.id);
      const synced = await this.store.transaction((state) => {
        const current = state.campaigns[campaignId];
        assertSamePaymentIntent(order, current.sellerOrder);
        assertCancellationProgress(order, current.sellerOrder);
        const wasPaid = current.spentSats > 0;
        current.sellerOrder = order;
        current.updatedAt = nowIso(this.clock);
        current.lastError = null;
        if (order.payment?.authorization === "authorized") {
          if (!hasBuyerSubmissionReceipt(current, order) && !wasPaid) {
            // A GoBTC invoice can also be paid from an unrelated external wallet.
            // The provider's paid status proves the Seller may fulfill; it does
            // not prove this Buyer's wallet incurred the debit or network fee.
            current.lastError = {
              code: "payment_origin_unverified",
              message: "Seller payment is paid, but this Buyer has no matching submission receipt",
              at: nowIso(this.clock),
            };
            if (current.spendReservation) current.spendReservation.status = "uncertain";
            if (current.paymentOriginReviewAt == null) {
              current.paymentOriginReviewAt = nowIso(this.clock);
              audit(state, this.clock, "payment.origin_review_required", campaignId, {
                paymentId: order.payment.id,
                reason: "paid_without_buyer_submission_receipt",
              });
            }
            if (current.cancellation?.requestedAt) {
              if (order.production?.state === "completed") current.fulfillmentResult = order.production.result;
              cancellationResolution(state, this.clock, campaignId, current, order);
            } else {
              current.state = "payment_origin_review_required";
            }
            return publicCampaign(current);
          }
          const feeSats = Number(current.paymentAttempt?.prepared?.validation?.feeSats
            ?? current.spendReservation?.feeSats ?? 0);
          const totalDebitSats = order.amountSats + feeSats;
          current.invoiceSpentSats = order.amountSats;
          current.networkFeeSats = feeSats;
          current.spentSats = totalDebitSats;
          current.remainingBudgetSats = current.input.budgetSats - totalDebitSats;
          current.spendReservation = {
            ...(current.spendReservation ?? {}),
            amountSats: order.amountSats,
            feeSats,
            totalSats: totalDebitSats,
            status: "committed",
            committedAt: nowIso(this.clock),
          };
          discardSignedPsbt(current);
          if (!wasPaid) {
            audit(state, this.clock, "payment.authorized", campaignId, {
              paymentId: order.payment.id,
              amountSats: order.amountSats,
              feeSats,
              totalDebitSats,
              settlement: order.payment.settlement,
            });
          }
          current.state = order.state === "completed" ? "packaging" : "fulfillment";
        } else if (TERMINAL_UNPAID_STATUSES.has(String(order.payment?.status ?? "").toLowerCase())) {
          const mayHaveSubmitted = ["submitting", "submitted", "uncertain"].includes(current.paymentAttempt?.status);
          if (mayHaveSubmitted) {
            // A submission receipt (or an interrupted submission) conflicts with
            // a later unpaid status. Keep the allocation until the provider
            // outcome is reconciled; another purchase must not reuse it.
            const feeSats = Number(current.paymentAttempt?.prepared?.validation?.feeSats
              ?? current.decision?.selected?.quote?.sellerFeeAllowanceSats ?? 0);
            current.spendReservation ??= {
              amountSats: order.amountSats,
              feeSats,
              totalSats: order.amountSats + feeSats,
            };
            current.spendReservation.status = "uncertain";
            current.state = "payment_uncertain";
            current.lastError = {
              code: "payment_status_conflicts_submission",
              message: "Seller reports an unpaid invoice after Buyer payment submission; payment needs reconciliation",
              at: nowIso(this.clock),
            };
            if (current.paymentStatusConflictAt == null) {
              current.paymentStatusConflictAt = nowIso(this.clock);
              audit(state, this.clock, "payment.status_conflicts_submission", campaignId, {
                paymentId: order.payment.id,
                sellerStatus: order.payment.status,
              });
            }
            discardSignedPsbt(current);
          } else {
            current.state = "payment_failed";
            current.spendReservation = null;
            discardSignedPsbt(current);
            audit(state, this.clock, "payment.reservation_released", campaignId, {
              reason: `seller_status_${order.payment.status}`,
            });
          }
        } else if (current.state !== "payment_uncertain") {
          current.state = "awaiting_payment";
        }
        if (current.cancellation?.requestedAt) {
          if (order.production?.state === "completed") current.fulfillmentResult = order.production.result;
          cancellationResolution(state, this.clock, campaignId, current, order);
          return publicCampaign(current);
        }
        if (order.state === "completed") {
          current.fulfillmentResult = order.production.result;
          if (current.package?.state === "completed") {
            current.state = "completed";
          } else if (this.completer === null) {
            current.state = "completed";
            current.result = order.production.result;
            current.completedAt ??= nowIso(this.clock);
          } else {
            current.state = "packaging";
          }
          if (current.fulfillmentReceivedAt === undefined) {
            current.fulfillmentReceivedAt = nowIso(this.clock);
            audit(state, this.clock, "fulfillment.received", campaignId, {
              orderId: order.id,
              artifacts: order.production.result?.artifacts?.map((item) => item.name) ?? [],
            });
          }
        } else if (order.production?.state === "failed") {
          current.state = "fulfillment_failed";
          current.lastError = {
            code: order.production.error?.code ?? "fulfillment_failed",
            message: order.production.error?.message ?? "Seller fulfillment failed",
            at: nowIso(this.clock),
          };
        }
        return publicCampaign(current);
      });
      if (synced.state === "packaging") return await this.#startCompletion(campaignId);
      if (synced.package?.state === "completed"
        && this.completer?.refreshPaymentProof
        && (synced.package.paymentProof?.settlement !== synced.sellerOrder?.payment?.settlement
          || JSON.stringify(synced.package.paymentProof?.txids ?? []) !== JSON.stringify(synced.sellerOrder?.payment?.txids ?? []))) {
        const refreshed = await this.completer.refreshPaymentProof(synced, synced.package);
        return await this.store.transaction((state) => {
          const current = state.campaigns[campaignId];
          current.package = refreshed;
          current.result.campaignPackage = refreshed;
          current.updatedAt = nowIso(this.clock);
          audit(state, this.clock, "campaign.payment_proof_refreshed", campaignId, {
            settlement: refreshed.paymentProof.settlement,
            txids: refreshed.paymentProof.txids,
          });
          return publicCampaign(current);
        });
      }
      return synced;
    } catch (error) {
      return await this.store.transaction((state) => {
        const current = state.campaigns[campaignId];
        current.lastError = errorView(error, this.clock);
        current.updatedAt = nowIso(this.clock);
        audit(state, this.clock, "seller.sync_failed", campaignId, { code: current.lastError.code });
        return publicCampaign(current);
      });
    }
  }

  startPolling(intervalMs = this.policy.pollIntervalMs ?? 5000) {
    if (this.pollTimer !== undefined) return;
    this.pollTimer = setInterval(() => { void this.pollOnce(); }, intervalMs);
    this.pollTimer.unref();
    void this.pollOnce();
  }

  stopPolling() {
    if (this.pollTimer !== undefined) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  async pollOnce() {
    if (this.polling) return;
    this.polling = true;
    try {
      const active = Object.values(this.store.snapshot().campaigns)
        .filter((campaign) => campaign.sellerOrder !== null
          && (["awaiting_payment", "payment_submitted", "payment_uncertain", "payment_origin_review_required", "fulfillment", "packaging", "packaging_failed", "completed", "cancellation_pending", "refund_review_required", "cost_review_required"].includes(campaign.state)
            || (campaign.state === "cancelled" && campaign.cancellation?.requestedAt
              && this.clock() < Date.parse(campaign.cancellation.requestedAt) + 7 * 24 * 60 * 60 * 1000))
          && (campaign.sellerOrder?.payment?.settlement !== "settled"
            || ["fulfillment", "packaging", "packaging_failed"].includes(campaign.state)))
        .filter((campaign) => {
          const watchingCancellation = campaign.state === "cancellation_pending"
            && (campaign.sellerOrder?.cancellation?.state === "stop_requested"
              || campaign.paymentStatusConflictAt != null);
          if (!["completed", "cancelled", "refund_review_required", "cost_review_required"].includes(campaign.state)
            && !watchingCancellation) return true;
          const nextCheckAt = Date.parse(campaign.sellerOrder.payment?.nextCheckAt ?? "");
          return !Number.isFinite(nextCheckAt) || nextCheckAt <= this.clock();
        });
      await Promise.allSettled(active.map((campaign) => this.syncCampaign(campaign.id)));
    } finally {
      this.polling = false;
    }
  }

  async #evaluate(campaignId) {
    const campaign = this.getCampaign(campaignId);
    try {
      const decision = await this.decisionEngine.evaluate(campaign.input);
      return await this.store.transaction((state) => {
        const current = state.campaigns[campaignId];
        if (CANCELLATION_STATES.has(current.state)) return publicCampaign(current);
        const priorSelectionDigest = current.authorization.purchaseSelectionDigest;
        const nextSelectionDigest = purchaseSelectionDigest({ decision });
        if (current.input.authorizationMode === "confirm_before_purchase"
          && current.authorization.purchaseConfirmedAt != null
          && priorSelectionDigest !== nextSelectionDigest) {
          current.authorization.purchaseConfirmedAt = null;
          current.authorization.purchaseConfirmationSource = null;
          current.authorization.purchaseSelectionDigest = null;
          current.authorization.autoExecute = false;
          current.authorization.authorizedAt = null;
          current.spendReservation = null;
          audit(state, this.clock, "campaign.purchase_confirmation_expired", campaignId, {
            reason: "selected_quote_changed",
          });
        }
        current.decision = decision;
        current.state = "decision_ready";
        current.updatedAt = nowIso(this.clock);
        audit(state, this.clock, "decision.selected", campaignId, {
          productId: decision.selected.productId,
          quoteId: decision.selected.quote.id,
          amountSats: decision.selected.quote.amountSats,
          score: decision.selected.score,
          method: decision.method ?? "deterministic_fallback",
          advisorError: decision.advisorError?.code ?? null,
        });
        return publicCampaign(current);
      });
    } catch (error) {
      return await this.store.transaction((state) => {
        const current = state.campaigns[campaignId];
        if (CANCELLATION_STATES.has(current.state)) return publicCampaign(current);
        current.state = "decision_failed";
        current.lastError = errorView(error, this.clock);
        current.updatedAt = nowIso(this.clock);
        audit(state, this.clock, "decision.failed", campaignId, { code: current.lastError.code });
        return publicCampaign(current);
      });
    }
  }

  async #execute(campaignId, { purchaseAuthorization, requoteAttempt = 0 } = {}) {
    let campaign = this.getCampaign(campaignId);
    if (CANCELLATION_STATES.has(campaign.state)) return await this.cancelCampaign(campaignId);
    if (campaign.state === "payment_origin_review_required") return campaign;
    if (campaign.input.authorizationMode === "advisory_only") {
      throw new AppError("purchase_not_authorized", "This delegation authorizes advice only, not purchasing", 403);
    }
    if (campaign.input.authorizationMode === "confirm_before_purchase"
      && (campaign.authorization.purchaseConfirmedAt == null
        || campaign.authorization.purchaseSelectionDigest !== purchaseSelectionDigest(campaign))) {
      const valid = purchaseAuthorization?.type === "delegation_purchase_confirmation"
        && purchaseAuthorization.delegationId === campaign.input.delegationId
        && typeof purchaseAuthorization.selectionDigest === "string";
      if (!valid) {
        throw new AppError("purchase_confirmation_required", "Customer purchase confirmation is required", 403);
      }
      if (purchaseAuthorization.selectionDigest !== purchaseSelectionDigest(campaign)) {
        throw new AppError("purchase_confirmation_stale", "The selected package or quote changed; review the current offer before confirming", 409);
      }
      await this.store.transaction((state) => {
        const current = state.campaigns[campaignId];
        if (CANCELLATION_STATES.has(current.state)) return;
        if (purchaseSelectionDigest(current) !== purchaseAuthorization.selectionDigest) {
          throw new AppError("purchase_confirmation_stale", "The selected package or quote changed; review the current offer before confirming", 409);
        }
        current.authorization.purchaseConfirmedAt = nowIso(this.clock);
        current.authorization.purchaseConfirmationSource = "delegation";
        current.authorization.purchaseSelectionDigest = purchaseAuthorization.selectionDigest;
        audit(state, this.clock, "campaign.purchase_confirmed", campaignId, {
          delegationId: current.input.delegationId,
          selectionDigest: purchaseAuthorization.selectionDigest,
        });
      });
      campaign = this.getCampaign(campaignId);
      if (CANCELLATION_STATES.has(campaign.state)) return await this.cancelCampaign(campaignId);
    }
    if (["packaging", "packaging_failed"].includes(campaign.state)) {
      return await this.#startCompletion(campaignId);
    }
    if (["completed", "fulfillment", "payment_submitted"].includes(campaign.state)
      || (campaign.state === "awaiting_payment" && campaign.paymentAttempt !== null)) {
      return await this.syncCampaign(campaignId);
    }
    if (campaign.state === "payment_uncertain") {
      return await this.syncCampaign(campaignId);
    }
    if (!["decision_ready", "ordering", "order_failed", "spend_blocked"].includes(campaign.state) && campaign.sellerOrder === null) {
      throw new AppError("campaign_not_executable", `Campaign cannot execute from state: ${campaign.state}`, 409);
    }
    if (!campaign.authorization.autoExecute) {
      await this.store.transaction((state) => {
        const current = state.campaigns[campaignId];
        current.authorization.autoExecute = true;
        current.authorization.authorizedAt = nowIso(this.clock);
        audit(state, this.clock, "campaign.execution_authorized", campaignId, {
          budgetSats: current.authorization.budgetSats,
        });
      });
      campaign = this.getCampaign(campaignId);
    }
    const quote = campaign.decision?.selected?.quote;
    if (quote === undefined) throw new AppError("decision_missing", "Campaign has no selected quote", 409);
    if ((this.paymentFeeReserveSats ?? 0) > 0
      && (!Number.isSafeInteger(quote.sellerFeeAllowanceSats)
        || quote.customerPriceSats !== quote.amountSats + quote.sellerFeeAllowanceSats)) {
      throw new AppError("fee_inclusive_quote_required", "A new fee-inclusive quote is required before payment", 409);
    }
    const quotedTotalSats = quote.customerPriceSats ?? (quote.amountSats + (quote.sellerFeeAllowanceSats ?? this.paymentFeeReserveSats ?? Number(this.policy.maxPaymentFeeSats ?? 0)));
    if (exceedsConfiguredLimit(quotedTotalSats, this.policy.maxPerOrderSats)
      || quotedTotalSats > campaign.authorization.budgetSats) {
      throw new AppError("spend_not_authorized", "Selected quote exceeds Buyer spend authorization", 403);
    }
    if (campaign.input.deadlineType !== "preferred" && campaign.input.deadlineAt !== undefined) {
      const remainingMinutes = Math.floor((Date.parse(campaign.input.deadlineAt) - this.clock()) / 60_000);
      if (remainingMinutes <= 0 || quote.estimatedTurnaroundMinutes > remainingMinutes) {
        throw new AppError("deadline_no_longer_feasible", "The selected quote can no longer meet the hard deadline; re-evaluation is required", 409, {
          remainingMinutes,
          estimatedTurnaroundMinutes: quote.estimatedTurnaroundMinutes,
        });
      }
    }

    try {
      campaign = await this.#reserveSpend(campaignId, quote.amountSats, quote.sellerFeeAllowanceSats);
    } catch (error) {
      await this.store.transaction((state) => {
        const current = state.campaigns[campaignId];
        if (CANCELLATION_STATES.has(current.state)) return;
        current.state = "spend_blocked";
        current.lastError = errorView(error, this.clock);
        current.updatedAt = nowIso(this.clock);
        audit(state, this.clock, "payment.spend_blocked", campaignId, { code: current.lastError.code });
      });
      return this.getCampaign(campaignId);
    }
    if (CANCELLATION_STATES.has(campaign.state)) return await this.cancelCampaign(campaignId);

    if (campaign.sellerOrder === null) {
      const canOrder = await this.store.transaction((state) => {
        if (CANCELLATION_STATES.has(state.campaigns[campaignId].state)) return false;
        state.campaigns[campaignId].state = "ordering";
        state.campaigns[campaignId].updatedAt = nowIso(this.clock);
        return true;
      });
      if (!canOrder) return await this.cancelCampaign(campaignId);
      try {
        const order = await this.seller.createOrder(quote.id, `buyer-${campaignId}-${quote.id}`);
        validateSellerOrder(order, quote, campaign, this.policy, this.clock());
        campaign = await this.store.transaction((state) => {
          const current = state.campaigns[campaignId];
          current.sellerOrder = order;
          if (!CANCELLATION_STATES.has(current.state)) {
            if (order.payment.status === "paid") {
              current.state = "payment_origin_review_required";
              current.paymentOriginReviewAt ??= nowIso(this.clock);
              current.lastError = {
                code: "payment_origin_unverified",
                message: "Seller invoice is already paid before this Buyer submitted a payment",
                at: nowIso(this.clock),
              };
              current.spendReservation.status = "uncertain";
              audit(state, this.clock, "payment.origin_review_required", campaignId, {
                paymentId: order.payment.id,
                reason: "invoice_paid_before_buyer_submission",
              });
            } else {
              current.state = "awaiting_payment";
            }
          }
          current.updatedAt = nowIso(this.clock);
          audit(state, this.clock, "seller.order_created", campaignId, {
            orderId: order.id,
            paymentId: order.payment?.id,
            amountSats: order.amountSats,
          });
          return publicCampaign(current);
        });
        if (CANCELLATION_STATES.has(campaign.state)) return await this.cancelCampaign(campaignId);
      } catch (error) {
        await this.store.transaction((state) => {
          const current = state.campaigns[campaignId];
          if (CANCELLATION_STATES.has(current.state)) {
            current.cancellation.lastError = errorView(error, this.clock);
            return;
          }
          // A timeout or mismatched Seller response may follow an invoice that
          // was actually created. Keep its allocation until the original
          // idempotent order is reconciled; only a confirmed expired quote
          // proves no invoice was issued.
          if (error.code === "quote_expired") current.spendReservation = null;
          else if (current.spendReservation) current.spendReservation.status = "uncertain";
          current.state = "order_failed";
          current.lastError = errorView(error, this.clock);
          current.updatedAt = nowIso(this.clock);
          audit(state, this.clock, "seller.order_failed", campaignId, { code: current.lastError.code });
        });
        if (CANCELLATION_STATES.has(this.getCampaign(campaignId).state)) return this.getCampaign(campaignId);
        if (error.code === "quote_expired" && requoteAttempt < 1) {
          const reselected = await this.#evaluate(campaignId);
          if (reselected.state !== "decision_ready"
            || (reselected.input.authorizationMode === "confirm_before_purchase"
              && reselected.authorization.purchaseConfirmedAt == null)) return reselected;
          return await this.#execute(campaignId, { purchaseAuthorization, requoteAttempt: requoteAttempt + 1 });
        }
        return this.getCampaign(campaignId);
      }
    }

    campaign = this.getCampaign(campaignId);
    if (CANCELLATION_STATES.has(campaign.state)) return await this.cancelCampaign(campaignId);
    if (campaign.state === "payment_origin_review_required") return campaign;
    if (campaign.paymentAttempt?.status === "uncertain") return await this.syncCampaign(campaignId);
    if (campaign.paymentAttempt?.status === "submitted") return await this.syncCampaign(campaignId);

    if (campaign.paymentAttempt?.prepared === undefined) {
      const canPrepare = await this.store.transaction((state) => {
        if (CANCELLATION_STATES.has(state.campaigns[campaignId].state)) return false;
        state.campaigns[campaignId].state = "signing";
        state.campaigns[campaignId].updatedAt = nowIso(this.clock);
        return true;
      });
      if (!canPrepare) return await this.cancelCampaign(campaignId);
      try {
        await this.#assertPaymentsEnabled();
        const prepared = await this.wallet.preparePayment({
          paymentId: campaign.sellerOrder.payment.id,
          amountSats: campaign.sellerOrder.amountSats,
          recipientAddress: campaign.sellerOrder.payment.btcAddress,
          maxFeeSats: quote.sellerFeeAllowanceSats ?? this.paymentFeeReserveSats ?? Number(this.policy.maxPaymentFeeSats ?? 0),
        });
        await this.store.transaction((state) => {
          const current = state.campaigns[campaignId];
          if (CANCELLATION_STATES.has(current.state)) return;
          const feeSats = Number(prepared.validation?.feeSats ?? prepared.summary?.feeSats ?? 0);
          const totalSats = current.sellerOrder.amountSats + feeSats;
          const quotedTotalSats = quote.customerPriceSats ?? (quote.amountSats + (quote.sellerFeeAllowanceSats ?? this.paymentFeeReserveSats ?? Number(this.policy.maxPaymentFeeSats ?? 0)));
          if (!Number.isSafeInteger(feeSats) || feeSats < 0
            || totalSats > quotedTotalSats || totalSats > current.authorization.budgetSats) {
            throw new AppError("campaign_budget_exceeded", "Payment amount plus network fee exceeds the authorized budget", 403, {
              amountSats: current.sellerOrder.amountSats,
              feeSats,
              quotedTotalSats,
              budgetSats: current.authorization.budgetSats,
            });
          }
          current.spendReservation = {
            ...current.spendReservation,
            status: "prepared",
            feeSats,
            totalSats,
            preparedAt: nowIso(this.clock),
          };
          current.paymentAttempt = { status: "prepared", prepared, receipt: null, error: null };
          current.updatedAt = nowIso(this.clock);
          audit(state, this.clock, prepared.simulated === true ? "payment.demo_prepared" : "payment.psbt_prepared", campaignId, {
            paymentId: prepared.paymentId,
            jobId: prepared.jobId,
            ...(prepared.simulated === true ? { disclosure: "No PSBT was created or signed." } : {}),
          });
        });
      } catch (error) {
        await this.store.transaction((state) => {
          const current = state.campaigns[campaignId];
          if (CANCELLATION_STATES.has(current.state)) return;
          current.spendReservation = null;
          current.state = error.code === "payments_disabled" ? "spend_blocked" : "payment_preparation_failed";
          current.lastError = errorView(error, this.clock);
          current.updatedAt = nowIso(this.clock);
          audit(state, this.clock, "payment.prepare_failed", campaignId, { code: current.lastError.code });
        });
        return this.getCampaign(campaignId);
      }
    }

    campaign = this.getCampaign(campaignId);
    if (CANCELLATION_STATES.has(campaign.state)) return await this.cancelCampaign(campaignId);
    const prepared = this.store.snapshot().campaigns[campaignId].paymentAttempt.prepared;
    try {
      await this.#assertPaymentsEnabled();
    } catch (error) {
      await this.store.transaction((state) => {
        const current = state.campaigns[campaignId];
        if (CANCELLATION_STATES.has(current.state)) return;
        current.state = "spend_blocked";
        current.spendReservation = null;
        discardSignedPsbt(current);
        current.lastError = errorView(error, this.clock);
        current.updatedAt = nowIso(this.clock);
        audit(state, this.clock, "payment.spend_blocked", campaignId, { code: current.lastError.code });
      });
      return this.getCampaign(campaignId);
    }
    const canSubmit = await this.store.transaction((state) => {
      const current = state.campaigns[campaignId];
      if (CANCELLATION_STATES.has(current.state)) return false;
      current.state = "submitting_payment";
      current.paymentAttempt.status = "submitting";
      current.spendReservation ??= {
        amountSats: current.sellerOrder.amountSats,
        feeSats: Number(prepared.validation?.feeSats ?? 0),
        totalSats: current.sellerOrder.amountSats + Number(prepared.validation?.feeSats ?? 0),
      };
      current.spendReservation.status = "submitting";
      current.paymentAttempt.submissionStartedAt = nowIso(this.clock);
      current.updatedAt = nowIso(this.clock);
      return true;
    });
    if (!canSubmit) return await this.cancelCampaign(campaignId);
    try {
      const receipt = await this.wallet.submitPrepared(prepared);
      await this.store.transaction((state) => {
        const current = state.campaigns[campaignId];
        if (!CANCELLATION_STATES.has(current.state)) current.state = "payment_submitted";
        current.paymentAttempt.status = "submitted";
        current.spendReservation.status = "submitted";
        current.paymentAttempt.receipt = receipt;
        current.paymentAttempt.error = null;
        const signedPsbtSha256 = discardSignedPsbt(current);
        current.updatedAt = nowIso(this.clock);
        audit(state, this.clock, receipt.simulated === true ? "payment.demo_submitted" : "payment.submitted", campaignId, {
          paymentId: prepared.paymentId,
          instantReceiptId: receipt.instantReceiptId,
          signedPsbtSha256,
          note: receipt.simulated === true
            ? "demo receipt only; no Bitcoin transfer, GoBTC API call, or on-chain transaction"
            : "platform receipt; not an on-chain txid",
        });
      });
    } catch (error) {
      await this.store.transaction((state) => {
        const current = state.campaigns[campaignId];
        if (!CANCELLATION_STATES.has(current.state)) current.state = "payment_uncertain";
        current.paymentAttempt.status = "uncertain";
        current.spendReservation.status = "uncertain";
        current.paymentAttempt.error = errorView(error, this.clock);
        current.updatedAt = nowIso(this.clock);
        audit(state, this.clock, "payment.submission_uncertain", campaignId, {
          paymentId: prepared.paymentId,
          jobId: prepared.jobId,
          code: current.paymentAttempt.error.code,
          policy: "reconcile seller status; never blindly resubmit",
        });
      });
      return await this.syncCampaign(campaignId);
    }
    return await this.syncCampaign(campaignId);
  }

  #startCompletion(campaignId) {
    const existing = this.completionTasks.get(campaignId);
    if (existing !== undefined) return existing;
    if (this.completer === null) return Promise.resolve(this.getCampaign(campaignId));
    const task = (async () => {
      const claimed = await this.store.transaction((state) => {
        const campaign = state.campaigns[campaignId];
        if (!["packaging", "packaging_failed"].includes(campaign.state)) return false;
        campaign.state = "packaging";
        campaign.lastError = null;
        campaign.updatedAt = nowIso(this.clock);
        audit(state, this.clock, "campaign.packaging_started", campaignId);
        return true;
      });
      if (!claimed) return this.getCampaign(campaignId);
      try {
        const campaignPackage = await this.completer.complete(this.getCampaign(campaignId));
        return await this.store.transaction((state) => {
          const current = state.campaigns[campaignId];
          current.package = campaignPackage;
          current.result = {
            fulfillment: current.fulfillmentResult,
            campaignPackage,
          };
          current.packagingCompletedAt = nowIso(this.clock);
          if (!current.cancellation?.requestedAt) {
            current.state = "completed";
            current.completedAt = nowIso(this.clock);
          }
          current.updatedAt = nowIso(this.clock);
          current.lastError = null;
          audit(state, this.clock, current.cancellation?.requestedAt
            ? "campaign.packaging_completed_during_review" : "campaign.completed", campaignId, {
            files: campaignPackage.files.map((file) => file.path),
            spentSats: current.spentSats,
            remainingBudgetSats: current.remainingBudgetSats,
          });
          return publicCampaign(current);
        });
      } catch (error) {
        return await this.store.transaction((state) => {
          const current = state.campaigns[campaignId];
          if (!current.cancellation?.requestedAt) current.state = "packaging_failed";
          current.lastError = errorView(error, this.clock);
          current.updatedAt = nowIso(this.clock);
          audit(state, this.clock, "campaign.packaging_failed", campaignId, { code: current.lastError.code });
          return publicCampaign(current);
        });
      }
    })().finally(() => this.completionTasks.delete(campaignId));
    this.completionTasks.set(campaignId, task);
    return task;
  }

  async #reserveSpend(campaignId, amountSats, quoteFeeReserveSats) {
    const policy = await this.#currentPolicy();
    return await this.store.transaction((state) => {
      const campaign = state.campaigns[campaignId];
      if (CANCELLATION_STATES.has(campaign.state)) return publicCampaign(campaign);
      const feeReserveSats = quoteFeeReserveSats ?? this.paymentFeeReserveSats ?? Number(policy.maxPaymentFeeSats ?? 0);
      if (!Number.isSafeInteger(feeReserveSats) || feeReserveSats < 0
        || feeReserveSats > Number(policy.maxPaymentFeeSats ?? this.paymentFeeReserveSats ?? 0)) {
        throw new AppError("invalid_fee_allowance", "Quote network-fee allowance exceeds Buyer policy", 403);
      }
      if (activeReservation(campaign.spendReservation)
        && campaign.spendReservation?.amountSats === amountSats
        && campaign.spendReservation?.feeReserveSats === feeReserveSats) {
        if (policy.paymentsEnabled === false) {
          throw new AppError("payments_disabled", "Buyer payment execution is disabled by policy", 503);
        }
        return publicCampaign(campaign);
      }
      if (activeReservation(campaign.spendReservation)) {
        throw new AppError("spend_reservation_conflict", "An existing payment reservation belongs to a different quote", 409);
      }
      if (campaign.spentSats > 0) return publicCampaign(campaign);
      if (policy.paymentsEnabled === false) {
        throw new AppError("payments_disabled", "Buyer payment execution is disabled by policy", 503);
      }
      const totalReservedSats = amountSats + feeReserveSats;
      if (totalReservedSats > campaign.authorization.budgetSats) {
        throw new AppError("campaign_budget_exceeded", "Order amount plus the maximum network fee exceeds the authorized budget", 403, {
          amountSats,
          feeReserveSats,
          budgetSats: campaign.authorization.budgetSats,
        });
      }
      const windowStart = this.clock() - (24 * 60 * 60 * 1000);
      const spent = state.audit
        .filter((event) => event.type === "payment.authorized" && Date.parse(event.at) >= windowStart)
        .reduce((total, event) => total + Number(event.data?.totalDebitSats ?? event.data?.amountSats ?? 0), 0);
      const lifetimeSpent = state.audit
        .filter((event) => event.type === "payment.authorized")
        .reduce((total, event) => total + Number(event.data?.totalDebitSats ?? event.data?.amountSats ?? 0), 0);
      const reservations = Object.values(state.campaigns)
        .filter((item) => item.id !== campaignId && activeReservation(item.spendReservation))
        .map((item) => reservationTotal(item.spendReservation));
      const dailyLimit = policy.maxDailySpendSats ?? policy.maxCampaignSats;
      if (spent + reservations.reduce((total, value) => total + value, 0) + totalReservedSats > dailyLimit) {
        throw new AppError("daily_spend_limit", "Buyer daily spend limit would be exceeded", 403, {
          spentSats: spent,
          reservedSats: reservations.reduce((total, value) => total + value, 0),
          requestedSats: totalReservedSats,
          maxDailySpendSats: dailyLimit,
        });
      }
      const lifetimeLimit = policy.maxLifetimeSpendSats;
      if (Number.isSafeInteger(lifetimeLimit)
        && lifetimeSpent + reservations.reduce((total, value) => total + value, 0) + totalReservedSats > lifetimeLimit) {
        throw new AppError("lifetime_spend_limit", "Buyer lifetime wallet allocation would be exceeded", 403, {
          spentSats: lifetimeSpent,
          reservedSats: reservations.reduce((total, value) => total + value, 0),
          requestedSats: totalReservedSats,
          maxLifetimeSpendSats: lifetimeLimit,
        });
      }
      if (reservations.length >= (policy.maxPendingPayments ?? 1)) {
        throw new AppError("pending_payment_limit", "Buyer already has the maximum number of pending payments", 409);
      }
      campaign.spendReservation = {
        amountSats,
        feeReserveSats,
        totalReservedSats,
        status: "reserved",
        reservedAt: nowIso(this.clock),
      };
      campaign.updatedAt = nowIso(this.clock);
      audit(state, this.clock, "payment.spend_reserved", campaignId, { amountSats, feeReserveSats, totalReservedSats });
      return publicCampaign(campaign);
    });
  }

  async #currentPolicy() {
    if (this.policyLoader === null) return this.policy;
    const loaded = await this.policyLoader();
    if (loaded === null || typeof loaded !== "object") {
      throw new AppError("payment_policy_unavailable", "Buyer payment policy could not be loaded", 503);
    }
    this.policy = { ...this.policy, ...loaded };
    return this.policy;
  }

  async #assertPaymentsEnabled() {
    const policy = await this.#currentPolicy();
    if (policy.paymentsEnabled === false) {
      throw new AppError("payments_disabled", "Buyer payment execution is disabled by policy", 503);
    }
  }
}
