import assert from "node:assert/strict";
import test from "node:test";

import { calculateQuote, publicCatalog } from "../src/catalog.mjs";
import { DecisionEngine } from "../src/buyer/decision-engine.mjs";

class CatalogSeller {
  constructor() { this.sequence = 0; }
  async catalog() { return publicCatalog(); }
  async createQuote(input) {
    this.sequence += 1;
    return { id: `quote-${this.sequence}`, ...calculateQuote(input) };
  }
}

const policy = {
  allowedProducts: ["creator_pitch", "proof_demo", "ranking_listicle", "two_person_podcast"],
  maxPerOrderSats: 3000,
  maxCampaignSats: 3000,
  decisionWeights: { objective: 0.55, quality: 0.15, cost: 0.15, speed: 0.15 },
};

test("Buyer chooses product fit rather than simply the cheapest quote", async () => {
  const engine = new DecisionEngine({ seller: new CatalogSeller(), policy });
  const conversion = await engine.evaluate({ objective: "conversion", budgetSats: 3000 });
  const comparison = await engine.evaluate({ objective: "comparison", budgetSats: 3000 });
  const social = await engine.evaluate({ objective: "social_proof", budgetSats: 3000 });
  assert.equal(conversion.selected.productId, "proof_demo");
  assert.equal(comparison.selected.productId, "ranking_listicle");
  assert.equal(social.selected.productId, "two_person_podcast");
  assert.ok(social.selected.quote.amountSats > conversion.selected.quote.amountSats);
  assert.deepEqual(conversion.economicAlternatives.map((item) => item.hookVariants), [1, 3, 5]);
  assert.equal(conversion.economicAlternatives.find((item) => item.hookVariants === 3).selectedScope, true);
  assert.equal(conversion.plans.length, 12);
});

test("Buyer optimizes output scope against the hard budget instead of fixing it before comparison", async () => {
  const engine = new DecisionEngine({ seller: new CatalogSeller(), policy });
  const decision = await engine.evaluate({
    objective: "conversion",
    budgetSats: 2000,
    scopeFlexibility: { hookVariants: true },
  });
  assert.equal(decision.selected.productId, "proof_demo");
  assert.equal(decision.selected.quote.addOns.hookVariants, 3);
  assert.equal(decision.selected.quote.amountSats, 1660);
  assert.equal(decision.tradeoffs.broader.amountSats, 2020);
  assert.equal(decision.tradeoffs.broader.withinBudget, false);
  assert.equal(decision.tradeoffs.cheaper.amountSats, 1300);
});

test("Buyer can omit the payment-fee reserve for a simulated purchase plan", async () => {
  const engine = new DecisionEngine({
    seller: new CatalogSeller(),
    policy: { ...policy, maxPaymentFeeSats: 500 },
    paymentFeeReserveSats: 0,
  });
  const decision = await engine.evaluate({
    objective: "conversion",
    budgetSats: 2000,
    scopeFlexibility: { hookVariants: true },
  });
  assert.equal(decision.feeReserveSats, 0);
  assert.equal(decision.selected.quote.addOns.hookVariants, 3);
  assert.equal(decision.selected.quote.amountSats, 1660);
  assert.equal(decision.selected.totalAuthorizedSats, 1660);
  const threeHookPlan = decision.plans.find((item) => (
    item.productId === "proof_demo" && item.scope.hookVariants === 3
  ));
  assert.equal(threeHookPlan.totalAuthorizedSats, 1660);
  assert.deepEqual(threeHookPlan.rejections, []);
});

test("Buyer refuses a Seller that still adds network fees above its advertised quote", async () => {
  const engine = new DecisionEngine({
    seller: new CatalogSeller(),
    policy: { ...policy, maxPaymentFeeSats: 500 },
    paymentFeeReserveSats: 500,
  });
  await assert.rejects(engine.evaluate({ objective: "conversion", budgetSats: 2000 }),
    (error) => error.code === "no_eligible_quote"
      && error.details?.plans?.every((plan) => plan.rejections.includes("fee_inclusive_quote_required")));
});

test("deadline makes late formats ineligible and leaves an auditable reason", async () => {
  const engine = new DecisionEngine({ seller: new CatalogSeller(), policy });
  const decision = await engine.evaluate({ objective: "comparison", budgetSats: 3000, deadlineMinutes: 45 });
  assert.equal(decision.selected.productId, "proof_demo");
  const ranking = decision.candidates.find((candidate) => candidate.productId === "ranking_listicle");
  assert.equal(ranking.eligible, false);
  assert.deepEqual(ranking.rejections, ["deadline"]);
});

test("Buyer rejects a campaign budget above its autonomous spend ceiling", async () => {
  const engine = new DecisionEngine({ seller: new CatalogSeller(), policy });
  await assert.rejects(
    engine.evaluate({ objective: "conversion", budgetSats: 3001 }),
    (error) => error.code === "campaign_budget_exceeds_policy" && error.status === 403,
  );
});

test("Buyer can evaluate an order above 3000 sats when no separate per-order ceiling is configured", async () => {
  class HighValueSeller extends CatalogSeller {
    async createQuote(input) {
      const quote = await super.createQuote(input);
      return { ...quote, amountSats: 12000 };
    }
  }
  const engine = new DecisionEngine({
    seller: new HighValueSeller(),
    policy: { ...policy, maxPerOrderSats: undefined, maxCampaignSats: 60000 },
  });
  const decision = await engine.evaluate({
    objective: "conversion",
    budgetSats: 15000,
    scopeFlexibility: { hookVariants: false },
  });
  assert.equal(decision.selected.quote.amountSats, 12000);
  assert.equal(decision.selected.eligible, true);
  assert.equal(decision.selected.rejections.includes("per_order_policy_ceiling"), false);
});

test("Buyer filters packages by deliverable visual requirements before ranking", async () => {
  const engine = new DecisionEngine({ seller: new CatalogSeller(), policy });
  const decision = await engine.evaluate({
    objective: "comparison",
    budgetSats: 3000,
    brief: { visualMode: "product_only", voiceRequirements: [] },
  });
  assert.equal(decision.selected.productId, "proof_demo");
  assert.deepEqual(
    decision.candidates.filter((item) => item.productId !== "proof_demo").map((item) => item.rejections[0]),
    ["visual_mode_unsupported", "visual_mode_unsupported", "visual_mode_unsupported"],
  );
});

test("Buyer routes distinct two-speaker requirements only to the podcast package", async () => {
  const engine = new DecisionEngine({ seller: new CatalogSeller(), policy });
  const decision = await engine.evaluate({
    objective: "social_proof",
    budgetSats: 3000,
    addOns: { languages: ["en-GB"] },
    brief: {
      voiceRequirements: [
        { role: "host_a", style: "energetic", pace: "fast", accent: null },
        { role: "host_b", style: "calm", pace: "normal", accent: "en-GB" },
      ],
    },
  });
  assert.equal(decision.selected.productId, "two_person_podcast");
  assert.ok(decision.candidates
    .filter((item) => item.productId !== "two_person_podcast")
    .every((item) => item.rejections[0] === "voice_requirements_unsupported"));
});

test("preferred deadlines influence ranking without making a product ineligible", async () => {
  const engine = new DecisionEngine({ seller: new CatalogSeller(), policy });
  const decision = await engine.evaluate({
    objective: "comparison",
    objectiveFamily: "comparison",
    budgetSats: 3000,
    deadlineMinutes: 45,
    deadlineType: "preferred",
  });
  const ranking = decision.candidates.find((candidate) => candidate.productId === "ranking_listicle");
  assert.equal(ranking.eligible, true);
  assert.equal(decision.selected.productId, "ranking_listicle");
});

test("semantic advisor ranks only policy-eligible products", async () => {
  const advisor = {
    async rank({ candidates }) {
      assert.ok(candidates.every((candidate) => candidate.estimatedTurnaroundMinutes <= 50));
      const selected = candidates.find((candidate) => candidate.productId === "ranking_listicle");
      return {
        selectedPlanId: selected.planId,
        decisionRationale: "The listicle best expresses the requested category comparison.",
        rankings: candidates.map((candidate) => ({
          planId: candidate.planId,
          productId: candidate.productId,
          objectiveFit: candidate.planId === selected.planId ? 1 : 0.4,
          creativeFit: 0.8,
          evidenceFit: 0.7,
          overallScore: candidate.planId === selected.planId ? 0.94 : 0.55,
          rationale: "Grounded candidate assessment",
          risks: [],
        })),
      };
    },
  };
  const engine = new DecisionEngine({ seller: new CatalogSeller(), policy, advisor });
  const decision = await engine.evaluate({
    objective: "category authority",
    objectiveFamily: "brand_awareness",
    budgetSats: 3000,
    deadlineMinutes: 50,
    deadlineType: "hard",
  });
  assert.equal(decision.method, "deepseek_semantic");
  assert.equal(decision.selected.productId, "ranking_listicle");
  assert.equal(decision.candidates.find((item) => item.productId === "two_person_podcast").eligible, false);
});

test("advisor failure falls back to auditable deterministic scoring", async () => {
  const advisor = { async rank() { throw Object.assign(new Error("model offline"), { code: "deepseek_unavailable" }); } };
  const engine = new DecisionEngine({ seller: new CatalogSeller(), policy, advisor });
  const decision = await engine.evaluate({ objective: "conversion", budgetSats: 3000 });
  assert.equal(decision.method, "deterministic_fallback");
  assert.equal(decision.selected.productId, "proof_demo");
  assert.equal(decision.advisorError.code, "deepseek_unavailable");
});
