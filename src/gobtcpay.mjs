import { AppError } from "./errors.mjs";
import { safeServiceBaseUrl } from "./security.mjs";

function unwrap(payload) {
  const result = payload?.result;
  if (result?.$case === "failure") {
    const failure = result.failure ?? {};
    throw new AppError(
      "gobtcpay_failure",
      failure.message ?? "GoBTC Pay rejected the request",
      502,
      { code: failure.code, type: failure.data?.type, traceId: payload?.meta?.traceId },
    );
  }
  if (result?.$case === "success") return result.success;
  return payload;
}

export class GoBtcPayClient {
  constructor({ baseUrl, merchantApiKey, fetchImpl = fetch, timeoutMs = 15_000 }) {
    this.baseUrl = safeServiceBaseUrl(baseUrl, "GoBTC Pay base URL");
    this.merchantApiKey = merchantApiKey;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  readiness() {
    return {
      configured: typeof this.merchantApiKey === "string"
        && this.merchantApiKey.startsWith("sk_live_")
        && this.merchantApiKey !== "sk_live_replace_me",
      baseUrl: this.baseUrl,
      mode: "gobtcpay_mainnet",
      simulated: false,
      mainnet: true,
    };
  }

  async createPayment({ amountSats, description, externalId }) {
    if (!Number.isSafeInteger(amountSats) || amountSats <= 0) {
      throw new AppError("invalid_payment_amount", "Payment amount must be a positive integer number of satoshis", 400);
    }
    if (!this.merchantApiKey) {
      throw new AppError("merchant_not_configured", "GOBTCPAY_MERCHANT_API_KEY is not configured", 503);
    }
    return await this.#post("/merchant/payment/create", {
      amount: Number((amountSats / 100_000_000).toFixed(8)),
      currency: "BTC",
      description,
      externalId,
    }, this.merchantApiKey);
  }

  async getPayment(paymentId) {
    return await this.#post("/merchant/payment/get", { paymentId });
  }

  async #post(path, body, bearer = undefined) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new AppError("gobtcpay_invalid_response", "GoBTC Pay returned non-JSON data", 502, {
          httpStatus: response.status,
          body: text.slice(0, 300),
        });
      }
      const value = unwrap(payload);
      if (!response.ok) {
        throw new AppError("gobtcpay_http_error", "GoBTC Pay request failed", 502, {
          httpStatus: response.status,
          payload: value,
        });
      }
      return value;
    } catch (error) {
      if (error instanceof AppError) throw error;
      const message = error?.name === "AbortError" ? "GoBTC Pay request timed out" : "GoBTC Pay is unavailable";
      throw new AppError("gobtcpay_unavailable", message, 502, { cause: String(error?.message ?? error) });
    } finally {
      clearTimeout(timeout);
    }
  }
}
