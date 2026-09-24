import { AppError } from "../errors.mjs";
import { safeServiceBaseUrl } from "../security.mjs";

function cleanOrigin(value) {
  try {
    return new URL(safeServiceBaseUrl(value, "Seller URL")).origin;
  } catch {
    throw new AppError("invalid_seller_url", "Seller URL must be an absolute HTTP(S) URL");
  }
}

export class SellerClient {
  constructor({ baseUrl, allowedOrigins, apiToken, fetchImpl = fetch, timeoutMs = 15_000 }) {
    this.baseUrl = safeServiceBaseUrl(baseUrl, "Seller URL");
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.apiToken = apiToken;
    const origin = cleanOrigin(this.baseUrl);
    const allowlist = new Set(allowedOrigins.map(cleanOrigin));
    if (!allowlist.has(origin)) {
      throw new AppError("seller_not_allowed", `Seller origin is not allowlisted: ${origin}`, 403);
    }
    this.origin = origin;
  }

  catalog() { return this.#request("GET", "/v1/catalog"); }

  createQuote(input) { return this.#request("POST", "/v1/quotes", input); }

  createOrder(quoteId, idempotencyKey) {
    return this.#request("POST", "/v1/orders", { quoteId }, { "idempotency-key": idempotencyKey });
  }

  getOrder(orderId) { return this.#request("GET", `/v1/orders/${encodeURIComponent(orderId)}`); }

  syncOrder(orderId) { return this.#request("POST", `/v1/orders/${encodeURIComponent(orderId)}/sync`, {}); }

  requestCancellation(orderId) {
    return this.#request("POST", `/v1/orders/${encodeURIComponent(orderId)}/request-cancellation`, {});
  }

  authorizeDemoPayment(paymentId) {
    return this.#request("POST", `/v1/demo/payments/${encodeURIComponent(paymentId)}/authorize`, {});
  }

  retryProduction(orderId) {
    return this.#request("POST", `/v1/orders/${encodeURIComponent(orderId)}/retry-production`, {});
  }

  async downloadArtifact(orderId, filename, { maxBytes = 250 * 1024 * 1024, timeoutMs = 300_000 } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(
        `${this.baseUrl}/v1/orders/${encodeURIComponent(orderId)}/artifacts/${encodeURIComponent(filename)}`,
        { method: "GET", headers: { authorization: `Bearer ${this.apiToken}` }, redirect: "error", signal: controller.signal },
      );
      if (!response.ok) {
        throw new AppError("seller_artifact_failed", "Seller artifact download failed", 502, {
          httpStatus: response.status,
        });
      }
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw new AppError("seller_artifact_too_large", "Seller artifact exceeds Buyer size policy", 413);
      }
      if (response.body === null) throw new AppError("seller_artifact_failed", "Seller artifact response has no body", 502);
      const reader = response.body.getReader();
      const chunks = [];
      let received = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > maxBytes) {
          await reader.cancel();
          throw new AppError("seller_artifact_too_large", "Seller artifact exceeds Buyer size policy", 413);
        }
        chunks.push(Buffer.from(value));
      }
      const data = Buffer.concat(chunks, received);
      return {
        data,
        mediaType: response.headers.get("content-type")?.split(";", 1)[0] ?? "application/octet-stream",
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      const message = error?.name === "AbortError" ? "Seller artifact download timed out" : "Seller artifact is unavailable";
      throw new AppError("seller_artifact_unavailable", message, 502);
    } finally {
      clearTimeout(timeout);
    }
  }

  async health() {
    try {
      await this.#request("GET", "/health");
      return { reachable: true, origin: this.origin };
    } catch (error) {
      return { reachable: false, origin: this.origin, error: error.code ?? "seller_unavailable" };
    }
  }

  async #request(method, path, body = undefined, extraHeaders = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        redirect: "error",
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(path === "/health" || path === "/v1/catalog" ? {} : { authorization: `Bearer ${this.apiToken}` }),
          ...extraHeaders,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload;
      try {
        payload = text === "" ? {} : JSON.parse(text);
      } catch {
        throw new AppError("seller_invalid_response", "Seller returned non-JSON data", 502, {
          httpStatus: response.status,
        });
      }
      if (!response.ok) {
        const remote = payload?.error ?? {};
        throw new AppError(
          remote.code ?? "seller_http_error",
          remote.message ?? "Seller request failed",
          response.status >= 500 ? 502 : response.status,
          { ...(remote.details ?? {}), sellerHttpStatus: response.status },
        );
      }
      return payload;
    } catch (error) {
      if (error instanceof AppError) throw error;
      const message = error?.name === "AbortError" ? "Seller request timed out" : "Seller is unavailable";
      throw new AppError("seller_unavailable", message, 502, { cause: String(error?.message ?? error) });
    } finally {
      clearTimeout(timeout);
    }
  }
}
