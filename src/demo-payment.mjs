import { createHash } from "node:crypto";

import { AppError } from "./errors.mjs";

export const DEMO_PAYMENT_INITIAL_STATE = Object.freeze({
  version: 1,
  payments: {},
});

const DEMO_RECIPIENT = "bc1q_demo_only_not_a_real_bitcoin_address";

function nowIso(clock) {
  return new Date(clock()).toISOString();
}

function identifier(prefix, value) {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function publicPayment(payment) {
  return structuredClone(payment);
}

export class DemoPaymentClient {
  constructor({ store, clock = Date.now }) {
    this.store = store;
    this.clock = clock;
  }

  readiness() {
    return {
      configured: true,
      mode: "demo_simulated",
      simulated: true,
      mainnet: false,
      disclosure: "No Bitcoin is transferred and no GoBTC API is called.",
      externalBlocker: "gobtcpay_http_503",
    };
  }

  async createPayment({ amountSats, description, externalId }) {
    if (!Number.isSafeInteger(amountSats) || amountSats <= 0) {
      throw new AppError("invalid_demo_payment", "Demo payment amount must be a positive integer");
    }
    if (typeof externalId !== "string" || externalId === "") {
      throw new AppError("invalid_demo_payment", "Demo payment externalId is required");
    }
    const paymentId = identifier("demo_pay", externalId);
    return await this.store.transaction((state) => {
      const existing = state.payments[paymentId];
      if (existing !== undefined) {
        if (existing.externalId !== externalId || Number(existing.amountSats) !== amountSats) {
          throw new AppError("demo_payment_conflict", "Demo payment id is already bound to another intent", 409);
        }
        return publicPayment(existing);
      }
      const payment = {
        paymentId,
        externalId,
        description,
        status: "initiated",
        amountSats: String(amountSats),
        btcAddress: DEMO_RECIPIENT,
        checkoutUrl: null,
        qrString: null,
        expiresAt: Math.floor((this.clock() + (30 * 60 * 1000)) / 1000),
        transactions: [],
        paidAt: null,
        mode: "demo_simulated",
        simulated: true,
        simulationReceiptId: null,
        disclosure: "DEMO ONLY — no Bitcoin transfer and no GoBTC API call.",
      };
      state.payments[paymentId] = payment;
      return publicPayment(payment);
    });
  }

  async getPayment(paymentId) {
    const payment = this.store.snapshot().payments[paymentId];
    if (payment === undefined) throw new AppError("demo_payment_not_found", "Demo payment not found", 404);
    return publicPayment(payment);
  }

  async authorizePayment(paymentId) {
    return await this.store.transaction((state) => {
      const payment = state.payments[paymentId];
      if (payment === undefined) throw new AppError("demo_payment_not_found", "Demo payment not found", 404);
      if (payment.status === "paid") return publicPayment(payment);
      if (payment.status !== "initiated") {
        throw new AppError("demo_payment_not_authorizable", "Demo payment is not awaiting authorization", 409);
      }
      payment.status = "paid";
      payment.paidAt = nowIso(this.clock);
      payment.simulationReceiptId = identifier("demo_receipt", paymentId);
      payment.transactions = [];
      return publicPayment(payment);
    });
  }
}

export class DemoInstantWalletClient {
  constructor({ authorizePayment, clock = Date.now }) {
    if (typeof authorizePayment !== "function") throw new TypeError("authorizePayment must be a function");
    this.authorizePayment = authorizePayment;
    this.clock = clock;
  }

  async readiness() {
    return {
      configured: true,
      mode: "demo_simulated",
      simulated: true,
      mainnet: false,
      payerKeyConfigured: false,
      walletRegistration: "simulated",
      multisigAddress: null,
      disclosure: "No private key, PSBT, Bitcoin balance, or GoBTC API is used.",
      externalBlocker: "gobtcpay_http_503",
    };
  }

  async preparePayment({ paymentId, amountSats, recipientAddress }) {
    if (typeof paymentId !== "string" || !paymentId.startsWith("demo_pay_")) {
      throw new AppError("invalid_demo_payment", "Demo wallet accepts only demo payment IDs");
    }
    if (!Number.isSafeInteger(amountSats) || amountSats <= 0) {
      throw new AppError("invalid_demo_payment", "Demo payment amount must be a positive integer");
    }
    if (recipientAddress !== DEMO_RECIPIENT) {
      throw new AppError("invalid_demo_payment", "Demo payment recipient does not match the non-payable demo marker");
    }
    const jobId = identifier("demo_job", paymentId);
    const signedPsbtBase64 = Buffer.from(`DEMO-NOT-A-PSBT:${paymentId}:${amountSats}`, "utf8").toString("base64");
    return {
      paymentId,
      jobId,
      signedPsbtBase64,
      summary: {
        mode: "demo_simulated",
        simulated: true,
        amountSats,
        feeSats: 0,
        disclosure: "No PSBT was created or signed.",
      },
      validation: {
        recipientAddress,
        amountSats,
        feeSats: 0,
        feeRateSatVb: 0,
        changeSats: 0,
        inputCount: 0,
        outputCount: 0,
        simulated: true,
      },
      preparedAt: nowIso(this.clock),
      simulated: true,
    };
  }

  async submitPrepared({ paymentId, jobId }) {
    if (jobId !== identifier("demo_job", paymentId)) {
      throw new AppError("invalid_demo_payment", "Demo payment job does not match its payment intent");
    }
    const receipt = await this.authorizePayment(paymentId);
    if (receipt?.simulated !== true || typeof receipt.instantReceiptId !== "string") {
      throw new AppError("invalid_demo_receipt", "Seller did not return an explicit simulated receipt", 502);
    }
    return receipt;
  }
}
