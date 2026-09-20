import assert from "node:assert/strict";
import test from "node:test";

import { GoBtcPayClient } from "../src/gobtcpay.mjs";

function response(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("GoBTC create uses exact BTC amount and merchant bearer key", async () => {
  let request;
  const client = new GoBtcPayClient({
    baseUrl: "https://api.example/v1.2",
    merchantApiKey: "sk_live_test",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response({
        id: "envelope",
        result: {
          $case: "success",
          success: { paymentId: "pay-1", status: "initiated", amountSats: "2210" },
        },
      });
    },
  });
  const payment = await client.createPayment({
    amountSats: 2210,
    description: "Ranking order",
    externalId: "stable-order-id",
  });
  assert.equal(payment.paymentId, "pay-1");
  assert.equal(request.url, "https://api.example/v1.2/merchant/payment/create");
  assert.equal(request.options.headers.authorization, "Bearer sk_live_test");
  assert.deepEqual(JSON.parse(request.options.body), {
    amount: 0.0000221,
    currency: "BTC",
    description: "Ranking order",
    externalId: "stable-order-id",
  });
});

test("GoBTC failure envelope is authoritative even on HTTP 200", async () => {
  const client = new GoBtcPayClient({
    baseUrl: "https://api.example/v1.2",
    merchantApiKey: "sk_live_test",
    fetchImpl: async () => response({
      meta: { traceId: "trace-1" },
      result: {
        $case: "failure",
        failure: {
          code: "external_id_conflict",
          message: "amount changed",
          data: { type: "payment" },
        },
      },
    }),
  });
  await assert.rejects(
    client.createPayment({ amountSats: 900, description: "x", externalId: "same" }),
    (error) => error.code === "gobtcpay_failure"
      && error.details.code === "external_id_conflict"
      && error.details.traceId === "trace-1",
  );
});
