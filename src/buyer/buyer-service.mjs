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

function audit(state, clock, type, campaignId, data = {}) {
  state.audit.push({ id: `evt_${randomUUID()}`, at: nowIso(clock), type, campaignId, data });
}

function publicCampaign(campaign) {
  const result = structuredClone(campaign);
  if (result.paymentAttempt?.prepared) delete result.paymentAttempt.prepared.signedPsbtBase64;
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

function reservationTotal(reservation) {
  if (reservation === null || reservation === undefined) return 0;
  return Number(reservation.totalSats ?? reservation.totalReservedSats ?? reservation.amountSats ?? 0);
}

function activeReservation(reservation) {
  if (reservation === null || reservation === undefined) return false;
  return reservation.status === undefined || ACTIVE_RESERVATION_STATES.has(reservation.status);
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
  if (order.amountSats > policy.maxPerOrderSats || order.amountSats > campaign.authorization.budgetSats) {
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
  if (order.payment.status !== "initiated") {
    throw new AppError("seller_payment_invalid", "Seller payment must be newly initiated before Buyer signing", 502, {
      status: order.payment.status ?? null,
    });
  }
  const numericExpiry = typeof order.payment.expiresAt === "number" || /^\d+$/u.test(order.payment.expiresAt ?? "")
    ? Number(order.payment.expiresAt)
    : null;
  const expiresAt = numericExpiry === null
    ? Date.parse(order.payment.expiresAt)
    : numericExpiry < 10_000_000_000 ? numericExpiry * 1000 : numericExpiry;
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    throw new AppError("seller_payment_expired", "Seller payment is expired or has an invalid expiry", 502);
  }
}

export class BuyerService {
  constructor({ store, seller, wallet, decisionEngine, completer = null, policy, policyLoader = null, clock = Date.now }) {
    this.store = store;
    this.seller = seller;
    this.wallet = wallet;
    this.decisionEngine = decisionEngine;
    this.completer = completer;
    this.policy = policy;
    this.policyLoader = policyLoader;
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
        maxPerOrderSats: this.policy.maxPerOrderSats,
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

  async createCampaign({ input: rawInput, idempotencyKey }) {
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
    if (!created.isNew) return publicCampaign(created.campaign);

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
    return await this.store.transaction((state) => {
      const campaign = state.campaigns[campaignId];
      if (campaign === undefined) throw new AppError("campaign_not_found", "Campaign not found", 404);
      if (["completed", "cancelled"].includes(campaign.state)) return publicCampaign(campaign);
      const paymentStatus = campaign.paymentAttempt?.status;
      if (["submitting", "submitted", "uncertain"].includes(paymentStatus)
        || campaign.sellerOrder?.payment?.authorization === "authorized") {
        throw new AppError(
          "cancellation_requires_resolution",
          "Payment may already have been submitted; cancellation requires payment reconciliation and human resolution",
          409,
        );
      }
      campaign.state = "cancelled";
      campaign.cancelledAt = nowIso(this.clock);
      campaign.spendReservation = null;
      discardSignedPsbt(campaign);
      campaign.updatedAt = nowIso(this.clock);
      audit(state, this.clock, "campaign.cancelled", campaignId);
      return publicCampaign(campaign);
    });
  }

  async retryFulfillment(campaignId) {
    const campaign = this.getCampaign(campaignId);
    if (campaign.state !== "fulfillment_failed" || campaign.sellerOrder === null) {
      throw new AppError("fulfillment_retry_not_expected", "Only a failed paid fulfillment can be retried", 409);
    }
    await this.seller.retryProduction(campaign.sellerOrder.id);
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
    if (["completed", "cancelled", "fulfillment_failed"].includes(campaign.state)) return campaign;
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
    if (campaign.sellerOrder === null) return campaign;
    try {
      const order = await this.seller.syncOrder(campaign.sellerOrder.id);
      const synced = await this.store.transaction((state) => {
        const current = state.campaigns[campaignId];
        const wasPaid = current.spentSats > 0;
        current.sellerOrder = order;
        current.updatedAt = nowIso(this.clock);
        current.lastError = null;
        if (order.payment?.authorization === "authorized") {
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
          current.state = "payment_failed";
          current.spendReservation = null;
          discardSignedPsbt(current);
          audit(state, this.clock, "payment.reservation_released", campaignId, {
            reason: `seller_status_${order.payment.status}`,
          });
        } else if (current.state !== "payment_uncertain") {
          current.state = "awaiting_payment";
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
          && ["awaiting_payment", "payment_submitted", "payment_uncertain", "fulfillment", "packaging", "packaging_failed", "completed"].includes(campaign.state)
          && campaign.sellerOrder?.payment?.settlement !== "settled");
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
    if (campaign.input.authorizationMode === "advisory_only") {
      throw new AppError("purchase_not_authorized", "This delegation authorizes advice only, not purchasing", 403);
    }
    if (campaign.input.authorizationMode === "confirm_before_purchase"
      && campaign.authorization.purchaseConfirmedAt == null) {
      const valid = purchaseAuthorization?.type === "delegation_purchase_confirmation"
        && purchaseAuthorization.delegationId === campaign.input.delegationId;
      if (!valid) {
        throw new AppError("purchase_confirmation_required", "Customer purchase confirmation is required", 403);
      }
      await this.store.transaction((state) => {
        const current = state.campaigns[campaignId];
        current.authorization.purchaseConfirmedAt = nowIso(this.clock);
        current.authorization.purchaseConfirmationSource = "delegation";
        audit(state, this.clock, "campaign.purchase_confirmed", campaignId, {
          delegationId: current.input.delegationId,
        });
      });
      campaign = this.getCampaign(campaignId);
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
    if (quote.amountSats > this.policy.maxPerOrderSats || quote.amountSats > campaign.authorization.budgetSats) {
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
      campaign = await this.#reserveSpend(campaignId, quote.amountSats);
    } catch (error) {
      await this.store.transaction((state) => {
        const current = state.campaigns[campaignId];
        current.state = "spend_blocked";
        current.lastError = errorView(error, this.clock);
        current.updatedAt = nowIso(this.clock);
        audit(state, this.clock, "payment.spend_blocked", campaignId, { code: current.lastError.code });
      });
      return this.getCampaign(campaignId);
    }

    if (campaign.sellerOrder === null) {
      await this.store.transaction((state) => {
        state.campaigns[campaignId].state = "ordering";
        state.campaigns[campaignId].updatedAt = nowIso(this.clock);
      });
      try {
        const order = await this.seller.createOrder(quote.id, `buyer-${campaignId}-${quote.id}`);
        validateSellerOrder(order, quote, campaign, this.policy, this.clock());
        campaign = await this.store.transaction((state) => {
          const current = state.campaigns[campaignId];
          current.sellerOrder = order;
          current.state = "awaiting_payment";
          current.updatedAt = nowIso(this.clock);
          audit(state, this.clock, "seller.order_created", campaignId, {
            orderId: order.id,
            paymentId: order.payment?.id,
            amountSats: order.amountSats,
          });
          return publicCampaign(current);
        });
      } catch (error) {
        await this.store.transaction((state) => {
          const current = state.campaigns[campaignId];
          current.spendReservation = null;
          current.state = "order_failed";
          current.lastError = errorView(error, this.clock);
          current.updatedAt = nowIso(this.clock);
          audit(state, this.clock, "seller.order_failed", campaignId, { code: current.lastError.code });
        });
        if (error.code === "quote_expired" && requoteAttempt < 1) {
          await this.#evaluate(campaignId);
          return await this.#execute(campaignId, { purchaseAuthorization, requoteAttempt: requoteAttempt + 1 });
        }
        return this.getCampaign(campaignId);
      }
    }

    campaign = this.getCampaign(campaignId);
    if (campaign.paymentAttempt?.status === "uncertain") return await this.syncCampaign(campaignId);
    if (campaign.paymentAttempt?.status === "submitted") return await this.syncCampaign(campaignId);

    if (campaign.paymentAttempt?.prepared === undefined) {
      await this.store.transaction((state) => {
        state.campaigns[campaignId].state = "signing";
        state.campaigns[campaignId].updatedAt = nowIso(this.clock);
      });
      try {
        await this.#assertPaymentsEnabled();
        const prepared = await this.wallet.preparePayment({
          paymentId: campaign.sellerOrder.payment.id,
          amountSats: campaign.sellerOrder.amountSats,
          recipientAddress: campaign.sellerOrder.payment.btcAddress,
        });
        await this.store.transaction((state) => {
          const current = state.campaigns[campaignId];
          const feeSats = Number(prepared.validation?.feeSats ?? prepared.summary?.feeSats ?? 0);
          const totalSats = current.sellerOrder.amountSats + feeSats;
          if (!Number.isSafeInteger(feeSats) || feeSats < 0 || totalSats > current.authorization.budgetSats) {
            throw new AppError("campaign_budget_exceeded", "Payment amount plus network fee exceeds the authorized budget", 403, {
              amountSats: current.sellerOrder.amountSats,
              feeSats,
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
          current.spendReservation = null;
          current.state = error.code === "payments_disabled" ? "spend_blocked" : "payment_preparation_failed";
          current.lastError = errorView(error, this.clock);
          current.updatedAt = nowIso(this.clock);
          audit(state, this.clock, "payment.prepare_failed", campaignId, { code: current.lastError.code });
        });
        return this.getCampaign(campaignId);
      }
    }

    const prepared = this.store.snapshot().campaigns[campaignId].paymentAttempt.prepared;
    try {
      await this.#assertPaymentsEnabled();
    } catch (error) {
      await this.store.transaction((state) => {
        const current = state.campaigns[campaignId];
        current.state = "spend_blocked";
        current.spendReservation = null;
        discardSignedPsbt(current);
        current.lastError = errorView(error, this.clock);
        current.updatedAt = nowIso(this.clock);
        audit(state, this.clock, "payment.spend_blocked", campaignId, { code: current.lastError.code });
      });
      return this.getCampaign(campaignId);
    }
    await this.store.transaction((state) => {
      const current = state.campaigns[campaignId];
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
    });
    try {
      const receipt = await this.wallet.submitPrepared(prepared);
      await this.store.transaction((state) => {
        const current = state.campaigns[campaignId];
        current.state = "payment_submitted";
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
        current.state = "payment_uncertain";
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
          current.state = "completed";
          current.completedAt = nowIso(this.clock);
          current.updatedAt = nowIso(this.clock);
          current.lastError = null;
          audit(state, this.clock, "campaign.completed", campaignId, {
            files: campaignPackage.files.map((file) => file.path),
            spentSats: current.spentSats,
            remainingBudgetSats: current.remainingBudgetSats,
          });
          return publicCampaign(current);
        });
      } catch (error) {
        return await this.store.transaction((state) => {
          const current = state.campaigns[campaignId];
          current.state = "packaging_failed";
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

  async #reserveSpend(campaignId, amountSats) {
    const policy = await this.#currentPolicy();
    return await this.store.transaction((state) => {
      const campaign = state.campaigns[campaignId];
      if (activeReservation(campaign.spendReservation) && campaign.spendReservation?.amountSats === amountSats) {
        if (policy.paymentsEnabled === false) {
          throw new AppError("payments_disabled", "Buyer payment execution is disabled by policy", 503);
        }
        return publicCampaign(campaign);
      }
      if (campaign.spentSats > 0) return publicCampaign(campaign);
      if (policy.paymentsEnabled === false) {
        throw new AppError("payments_disabled", "Buyer payment execution is disabled by policy", 503);
      }
      const feeReserveSats = Number(policy.maxPaymentFeeSats ?? 0);
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
