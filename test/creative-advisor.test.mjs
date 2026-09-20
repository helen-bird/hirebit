import assert from "node:assert/strict";
import test from "node:test";

import { DeepSeekCreativeAdvisor } from "../src/buyer/creative-advisor.mjs";

function responseFor(value) {
  return new Response(JSON.stringify({
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(value) }] }],
  }), { status: 200, headers: { "content-type": "application/json" } });
}

test("DeepSeek creative advisor uses structured ranking and never receives payment data", async () => {
  const calls = [];
  const advisor = new DeepSeekCreativeAdvisor({
    keyProvider: async () => ({ value: "secret-key", source: "test" }),
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return responseFor({
        selectedProductId: "proof_demo",
        decisionRationale: "Evidence-backed demonstration is the strongest conversion format.",
        rankings: [{
          productId: "proof_demo",
          objectiveFit: 1,
          creativeFit: 0.9,
          evidenceFit: 1,
          overallScore: 0.96,
          rationale: "The brief includes product evidence.",
          risks: [],
        }],
      });
    },
  });
  const result = await advisor.rank({
    request: { objective: "conversion", budgetSats: 2500 },
    candidates: [{ productId: "proof_demo", amountSats: 1300 }],
  });
  assert.equal(result.selectedProductId, "proof_demo");
  assert.equal(calls[0].text.format.type, "json_schema");
  assert.ok(!calls[0].input.includes("secret-key"));
  assert.ok(!calls[0].input.includes("paymentId"));
});

test("DeepSeek testing plan must map every delivered file exactly once", async () => {
  const advisor = new DeepSeekCreativeAdvisor({
    keyProvider: async () => ({ value: "secret-key", source: "test" }),
    fetchImpl: async () => responseFor({
      recommendation: "Hold audience constant and compare the two opening claims.",
      variants: [
        { file: "a.mp4", strategy: "Proof first", hypothesis: "Proof increases trust", primaryMetric: "conversion rate" },
        { file: "b.mp4", strategy: "Outcome first", hypothesis: "Outcome increases attention", primaryMetric: "hook retention" },
      ],
    }),
  });
  const plan = await advisor.createTestingPlan({
    campaign: { input: { objective: "conversion", brief: {} }, decision: { rationale: "Proof fit" } },
    creativeFiles: [{ name: "a.mp4" }, { name: "b.mp4" }],
  });
  assert.equal(plan.method, "deepseek_semantic");
  assert.deepEqual(plan.variants.map((item) => item.priority), [1, 2]);
});
