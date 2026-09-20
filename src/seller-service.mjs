import { createHash, randomUUID } from "node:crypto";

import { calculateQuote, publicCatalog } from "./catalog.mjs";
import { AppError } from "./errors.mjs";

function nowIso(clock) {
  return new Date(clock()).toISOString();
}

function audit(state, clock, type, orderId, data = {}) {
  state.audit.push({ id: `evt_${randomUUID()}`, at: nowIso(clock), type, orderId, data });
}

function txids(transactions) {
  if (!Array.isArray(transactions)) return [];
  return [...new Set(transactions.flatMap((item) => {
    if (typeof item === "string") return [item];
    const value = item?.txid ?? item?.txId ?? item?.transactionId;
    return typeof value === "string" && value !== "" ? [value] : [];
  }))];
}

function paymentView(payment) {
  const chainTxids = txids(payment.transactions);
  const simulated = payment.simulated === true;
  return {
    id: payment.paymentId,
    status: payment.status,
    amountSats: String(payment.amountSats),
    btcAddress: payment.btcAddress,
    checkoutUrl: payment.checkoutUrl,
    qrString: payment.qrString,
    expiresAt: payment.expiresAt,
    authorization: payment.status === "paid" ? "authorized" : "pending",
    settlement: payment.paidAt != null && chainTxids.length > 0 ? "settled" : "pending",
    paidAt: payment.paidAt ?? null,
    txids: chainTxids,
    mode: simulated ? "demo_simulated" : (payment.mode ?? "gobtcpay_mainnet"),
    simulated,
    network: simulated ? "simulation" : "bitcoin-mainnet",
    disclosure: simulated ? (payment.disclosure ?? "DEMO ONLY — no Bitcoin transfer.") : null,
  };
}

function publicOrder(order) {
  return structuredClone(order);
}

export class SellerService {
  constructor({
    store,
    payments,
    producer,
    clock = Date.now,
    quoteTtlMs = 30 * 60 * 1000,
    maxConcurrentProductions = 1,
  }) {
    this.store = store;
    this.payments = payments;
    this.producer = producer;
    this.clock = clock;
    this.quoteTtlMs = quoteTtlMs;
    this.maxConcurrentProductions = Math.max(1, maxConcurrentProductions);
    this.paymentTasks = new Map();
    this.productionTasks = new Map();
    this.pollTimer = undefined;
    this.polling = false;
  }

  async catalog() {
    const catalog = publicCatalog();
    const production = await (this.producer.readiness?.() ?? { configured: true });
    if (!Array.isArray(production.workflowProducts)) return catalog;
    const ready = new Set(production.workflowProducts);
    return {
      ...catalog,
      products: catalog.products.map((product) => (
        product.availability !== "available" || ready.has(product.id)
          ? product
          : { ...product, availability: "unavailable", unavailableReason: "production_workflow_not_ready" }
      )),
    };
  }

  async readiness() {
    const payment = this.payments.readiness?.() ?? { configured: true };
    const production = await (this.producer.readiness?.() ?? { configured: true });
    return {
      ready: payment.configured === true && production.configured === true,
      payment,
      production,
    };
  }

  async createQuote(input) {
    const production = await (this.producer.readiness?.() ?? { configured: true });
    if (production.configured !== true
      || (Array.isArray(production.workflowProducts) && !production.workflowProducts.includes(input?.productId))) {
      throw new AppError("product_production_unavailable", "The selected product does not have a ready production workflow", 503, {
        productId: input?.productId ?? null,
        workflowProducts: production.workflowProducts ?? [],
      });
    }
    const calculated = calculateQuote(input);
    const maxProviderCostSats = production.workflowEconomics?.[input.productId]?.maxProviderCostSats;
    if (Number.isSafeInteger(maxProviderCostSats) && calculated.amountSats <= maxProviderCostSats) {
      throw new AppError("unprofitable_quote", "Configured provider cost ceiling leaves no positive gross margin", 503, {
        productId: input.productId,
        amountSats: calculated.amountSats,
        maxProviderCostSats,
      });
    }
    const quote = {
      id: `qte_${randomUUID()}`,
      createdAt: nowIso(this.clock),
      expiresAt: new Date(this.clock() + this.quoteTtlMs).toISOString(),
      ...calculated,
      economics: Number.isSafeInteger(maxProviderCostSats) ? {
        maxProviderCostSats,
        minimumGrossMarginSats: calculated.amountSats - maxProviderCostSats,
      } : null,
    };
    await this.store.transaction((state) => {
      state.quotes[quote.id] = quote;
      return quote;
    });
    return quote;
  }

  async createOrder({ quoteId, idempotencyKey }) {
    if (typeof idempotencyKey !== "string" || idempotencyKey.trim().length < 8 || idempotencyKey.length > 200) {
      throw new AppError("invalid_idempotency_key", "Idempotency-Key must contain 8-200 characters");
    }
    const key = idempotencyKey.trim();
    const preview = this.store.snapshot();
    if (preview.idempotency[key] === undefined) {
      const quote = preview.quotes[quoteId];
      if (quote === undefined) throw new AppError("quote_not_found", "Quote not found", 404);
      const production = await (this.producer.readiness?.() ?? { configured: true });
      if (production.configured !== true
        || (Array.isArray(production.workflowProducts) && !production.workflowProducts.includes(quote.product.id))) {
        throw new AppError("product_production_unavailable", "Production became unavailable before payment creation", 503, {
          productId: quote.product.id,
        });
      }
    }
    const order = await this.store.transaction((state) => {
      const existingId = state.idempotency[key];
      if (existingId !== undefined) {
        const existing = state.orders[existingId];
        if (existing.quoteId !== quoteId) {
          throw new AppError("idempotency_conflict", "Idempotency-Key is already bound to another quote", 409);
        }
        return existing;
      }
      const quote = state.quotes[quoteId];
      if (quote === undefined) throw new AppError("quote_not_found", "Quote not found", 404);
      if (Date.parse(quote.expiresAt) <= this.clock()) throw new AppError("quote_expired", "Quote has expired", 409);
      const id = `ord_${randomUUID()}`;
      const externalId = `hypit-${createHash("sha256").update(`${key}:${quoteId}`).digest("hex").slice(0, 32)}`;
      const created = {
        id,
        quoteId,
        externalId,
        amountSats: quote.amountSats,
        state: "creating_payment",
        createdAt: nowIso(this.clock),
        updatedAt: nowIso(this.clock),
        payment: null,
        production: { state: "locked", attempts: 0, result: null, error: null },
      };
      state.orders[id] = created;
      state.idempotency[key] = id;
      audit(state, this.clock, "order.created", id, { quoteId, externalId, amountSats: quote.amountSats });
      return created;
    });
    return await this.#ensurePayment(order.id);
  }

  getOrder(orderId) {
    const order = this.store.snapshot().orders[orderId];
    if (order === undefined) throw new AppError("order_not_found", "Order not found", 404);
    return publicOrder(order);
  }

  audit(orderId) {
    const state = this.store.snapshot();
    if (state.orders[orderId] === undefined) throw new AppError("order_not_found", "Order not found", 404);
    return state.audit.filter((item) => item.orderId === orderId);
  }

  async authorizeDemoPayment(paymentId) {
    const readiness = this.payments.readiness?.() ?? {};
    if (readiness.simulated !== true || typeof this.payments.authorizePayment !== "function") {
      throw new AppError("demo_payment_disabled", "The simulated payment rail is not enabled", 404);
    }
    const order = Object.values(this.store.snapshot().orders)
      .find((candidate) => candidate.payment?.id === paymentId);
    if (order === undefined) throw new AppError("demo_payment_not_found", "Demo payment is not bound to an order", 404);
    const payment = await this.payments.authorizePayment(paymentId);
    await this.store.transaction((state) => {
      audit(state, this.clock, "payment.demo_authorized", order.id, {
        paymentId,
        receiptId: payment.simulationReceiptId,
        disclosure: "No Bitcoin transfer and no GoBTC API call.",
      });
    });
    return {
      instantReceiptId: payment.simulationReceiptId,
      submittedAt: payment.paidAt ?? nowIso(this.clock),
      mode: "demo_simulated",
      simulated: true,
      mainnet: false,
      disclosure: "DEMO ONLY — no Bitcoin transfer and no GoBTC API call.",
    };
  }

  async syncOrder(orderId, { awaitProduction = false } = {}) {
    let order = this.getOrder(orderId);
    if (order.payment === null) order = await this.#ensurePayment(orderId);
    const remote = await this.payments.getPayment(order.payment.id);
    const view = paymentView(remote);
    const expiry = Number(order.payment.expiresAt);
    const expiryMs = Number.isFinite(expiry) ? (expiry < 10_000_000_000 ? expiry * 1000 : expiry) : Date.parse(order.payment.expiresAt);
    if (view.status === "initiated" && Number.isFinite(expiryMs) && expiryMs <= this.clock()) {
      view.status = "expired";
    }
    order = await this.store.transaction((state) => {
      const current = state.orders[orderId];
      const wasAuthorized = current.payment?.authorization === "authorized";
      const changed = current.payment?.status !== view.status || current.payment?.settlement !== view.settlement;
      current.payment = { ...current.payment, ...view, lastCheckedAt: nowIso(this.clock) };
      current.payment.pollAttempts = changed ? 0 : Number(current.payment.pollAttempts ?? 0) + 1;
      const terminalUnpaid = ["expired", "cancelled", "canceled", "failed", "rejected"].includes(view.status);
      current.payment.nextCheckAt = terminalUnpaid || view.settlement === "settled"
        ? null
        : new Date(this.clock() + Math.min(300_000, 5_000 * (2 ** Math.min(current.payment.pollAttempts, 6)))).toISOString();
      current.updatedAt = nowIso(this.clock);
      if (terminalUnpaid && !wasAuthorized) current.state = "payment_expired";
      if (view.authorization === "authorized" && !wasAuthorized) {
        current.state = "paid";
        current.production.state = "queued";
        audit(state, this.clock, "payment.authorized", orderId, {
          paymentId: view.id,
          unlockSignal: "status=paid",
          settlement: view.settlement,
        });
      }
      if (view.settlement === "settled" && current.payment.settlementRecorded !== true) {
        current.payment.settlementRecorded = true;
        audit(state, this.clock, "payment.settled", orderId, { txids: view.txids, paidAt: view.paidAt });
      }
      return current;
    });
    if (["queued", "producing"].includes(order.production.state)) {
      const task = this.#startProduction(orderId);
      if (awaitProduction) await task;
    }
    return this.getOrder(orderId);
  }

  async retryProduction(orderId) {
    await this.store.transaction((state) => {
      const order = state.orders[orderId];
      if (order === undefined) throw new AppError("order_not_found", "Order not found", 404);
      if (order.payment?.authorization !== "authorized") {
        throw new AppError("payment_not_authorized", "Production remains locked until status is paid", 409);
      }
      if (order.production.state !== "failed") {
        throw new AppError("production_not_failed", "Only failed production can be retried", 409);
      }
      order.production.state = "queued";
      order.production.error = null;
      order.updatedAt = nowIso(this.clock);
      audit(state, this.clock, "production.retry_queued", orderId);
    });
    await this.#startProduction(orderId);
    return this.getOrder(orderId);
  }

  async recover() {
    const orders = Object.values(this.store.snapshot().orders)
      .filter((order) => order.payment?.authorization === "authorized"
        && ["queued", "producing"].includes(order.production?.state));
    return await Promise.allSettled(orders.map((order) => this.#startProduction(order.id)));
  }

  startPolling(intervalMs = 5000) {
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
      const orders = Object.values(this.store.snapshot().orders)
        .filter((order) => order.payment === null || (
          order.payment.settlement !== "settled" || ["locked", "queued", "producing"].includes(order.production.state)
        ))
        .filter((order) => order.payment === null
          || !["expired", "cancelled", "canceled", "failed", "rejected"].includes(order.payment.status)
          || ["queued", "producing"].includes(order.production.state))
        .filter((order) => order.payment?.nextCheckAt == null
          || Date.parse(order.payment.nextCheckAt) <= this.clock()
          || ["queued", "producing"].includes(order.production.state));
      const results = await Promise.allSettled(orders.map((order) => this.syncOrder(order.id)));
      for (const [index, result] of results.entries()) {
        if (result.status !== "rejected") continue;
        await this.store.transaction((state) => {
          audit(state, this.clock, "poll.sync_failed", orders[index].id, {
            code: result.reason?.code ?? "sync_failed",
          });
        });
      }
    } finally {
      this.polling = false;
    }
  }

  async #ensurePayment(orderId) {
    const existingTask = this.paymentTasks.get(orderId);
    if (existingTask !== undefined) return await existingTask;
    const task = (async () => {
      const state = this.store.snapshot();
      const order = state.orders[orderId];
      if (order === undefined) throw new AppError("order_not_found", "Order not found", 404);
      if (order.payment !== null) return publicOrder(order);
      const quote = state.quotes[order.quoteId];
      try {
        const created = await this.payments.createPayment({
          amountSats: order.amountSats,
          description: `${quote.product.name} · ${order.id}`,
          externalId: order.externalId,
        });
        return await this.store.transaction((draft) => {
          const current = draft.orders[orderId];
          current.payment = { ...paymentView(created), lastCheckedAt: nowIso(this.clock), settlementRecorded: false };
          current.state = "awaiting_payment";
          current.updatedAt = nowIso(this.clock);
          audit(draft, this.clock, "payment.created", orderId, {
            paymentId: current.payment.id,
            externalId: current.externalId,
          });
          return current;
        });
      } catch (error) {
        if (error.code === "hypit_build_still_running") {
          await this.store.transaction((draft) => {
            const current = draft.orders[orderId];
            current.state = "fulfilling";
            current.production.state = "producing";
            current.production.error = { code: error.code, message: error.message, transient: true };
            current.updatedAt = nowIso(this.clock);
            audit(draft, this.clock, "production.still_running", orderId, { buildId: current.production.buildId });
          });
          return;
        }
        await this.store.transaction((draft) => {
          const current = draft.orders[orderId];
          current.state = "payment_creation_failed";
          current.updatedAt = nowIso(this.clock);
          current.lastError = { code: error.code ?? "payment_error", message: error.message, at: nowIso(this.clock) };
          audit(draft, this.clock, "payment.create_failed", orderId, current.lastError);
        });
        throw error;
      }
    })().finally(() => this.paymentTasks.delete(orderId));
    this.paymentTasks.set(orderId, task);
    return await task;
  }

  #startProduction(orderId) {
    const existing = this.productionTasks.get(orderId);
    if (existing !== undefined) return existing;
    if (this.productionTasks.size >= this.maxConcurrentProductions) return Promise.resolve();
    const task = (async () => {
      const claim = await this.store.transaction((state) => {
        const order = state.orders[orderId];
        if (!['queued', 'producing'].includes(order.production.state)) return null;
        if (order.payment?.authorization !== "authorized") {
          throw new AppError("payment_not_authorized", "Production remains locked until status is paid", 409);
        }
        if (order.production.state === "producing") {
          if (typeof order.production.buildId !== "string" || order.production.buildId === "") {
            order.state = "fulfillment_failed";
            order.production.state = "failed";
            order.production.failedAt = nowIso(this.clock);
            order.production.error = {
              code: "production_recovery_missing_build",
              message: "Production was interrupted before a durable Hypit build id was recorded; manual retry is required",
            };
            order.updatedAt = nowIso(this.clock);
            audit(state, this.clock, "production.recovery_failed", orderId, order.production.error);
            return null;
          }
          audit(state, this.clock, "production.reattached", orderId, { buildId: order.production.buildId });
          return { mode: "resume", buildId: order.production.buildId };
        }
        order.state = "fulfilling";
        order.production.state = "producing";
        order.production.attempts += 1;
        order.production.startedAt = nowIso(this.clock);
        order.updatedAt = nowIso(this.clock);
        audit(state, this.clock, "production.started", orderId, { attempt: order.production.attempts });
        return { mode: "start", buildId: null };
      });
      if (claim === null) return;
      const state = this.store.snapshot();
      const order = state.orders[orderId];
      const quote = state.quotes[order.quoteId];
      try {
        let result;
        if (claim.mode === "resume") {
          if (typeof this.producer.resume !== "function") {
            throw new AppError("production_resume_unsupported", "Configured producer cannot resume a durable build", 503);
          }
          result = await this.producer.resume({
            buildId: claim.buildId,
            order: publicOrder(order),
            quote: structuredClone(quote),
          });
        } else if (typeof this.producer.start === "function" && typeof this.producer.resume === "function") {
          const submission = await this.producer.start({ order: publicOrder(order), quote: structuredClone(quote) });
          if (typeof submission?.buildId !== "string" || submission.buildId === "") {
            throw new AppError("production_submission_invalid", "Producer did not return a durable build id", 502);
          }
          await this.store.transaction((draft) => {
            const current = draft.orders[orderId];
            current.production.buildId = submission.buildId;
            current.production.submittedAt = nowIso(this.clock);
            current.updatedAt = nowIso(this.clock);
            audit(draft, this.clock, "production.submitted", orderId, { buildId: submission.buildId });
          });
          result = await this.producer.resume({
            buildId: submission.buildId,
            order: this.getOrder(orderId),
            quote: structuredClone(quote),
          });
        } else {
          result = await this.producer.execute({ order: publicOrder(order), quote: structuredClone(quote) });
        }
        await this.store.transaction((draft) => {
          const current = draft.orders[orderId];
          current.state = "completed";
          current.production.state = "completed";
          current.production.completedAt = nowIso(this.clock);
          current.production.result = result;
          current.production.buildId = result.buildId ?? current.production.buildId ?? null;
          current.production.error = null;
          current.updatedAt = nowIso(this.clock);
          audit(draft, this.clock, "production.completed", orderId, {
            buildId: result.buildId,
            artifacts: result.artifacts?.map((item) => item.name) ?? [],
          });
        });
      } catch (error) {
        await this.store.transaction((draft) => {
          const current = draft.orders[orderId];
          current.state = "fulfillment_failed";
          current.production.state = "failed";
          current.production.failedAt = nowIso(this.clock);
          current.production.error = { code: error.code ?? "production_error", message: error.message };
          current.updatedAt = nowIso(this.clock);
          audit(draft, this.clock, "production.failed", orderId, current.production.error);
        });
      }
    })().finally(() => {
      this.productionTasks.delete(orderId);
      queueMicrotask(() => this.#drainProductionQueue());
    });
    this.productionTasks.set(orderId, task);
    return task;
  }

  #drainProductionQueue() {
    if (this.productionTasks.size >= this.maxConcurrentProductions) return;
    const next = Object.values(this.store.snapshot().orders)
      .find((order) => order.production?.state === "queued" && order.payment?.authorization === "authorized");
    if (next !== undefined) void this.#startProduction(next.id);
  }
}
