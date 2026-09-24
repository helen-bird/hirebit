import { AppError } from "../errors.mjs";

const RELATED_OBJECTIVES = Object.freeze({
  conversion: ["direct_response", "feature_proof", "product_education", "objection_handling"],
  direct_response: ["conversion", "product_launch", "creator_style_pitch"],
  comparison: ["consideration", "engagement", "feature_proof"],
  social_proof: ["testimonial", "creator_style_pitch", "objection_handling"],
  product_education: ["feature_proof", "complex_education", "tutorial"],
  objection_handling: ["social_proof", "thought_leadership", "conversion"],
});
const OBJECTIVE_FAMILIES = new Set([
  "conversion", "direct_response", "comparison", "social_proof", "product_education",
  "objection_handling", "brand_awareness", "engagement", "other",
]);
const HOOK_OPTIONS = Object.freeze([1, 3, 5]);
const HOOK_SCOPE_VALUE = Object.freeze({ 1: 0.45, 3: 0.8, 5: 1 });

function validateRequest(input) {
  if (input === null || typeof input !== "object") {
    throw new AppError("invalid_campaign", "Campaign request must be a JSON object");
  }
  if (typeof input.objective !== "string" || input.objective.trim() === "") {
    throw new AppError("invalid_objective", "objective is required");
  }
  if (!Number.isSafeInteger(input.budgetSats) || input.budgetSats <= 0) {
    throw new AppError("invalid_budget", "budgetSats must be a positive integer");
  }
  if (input.deadlineMinutes !== undefined
    && (!Number.isSafeInteger(input.deadlineMinutes) || input.deadlineMinutes <= 0)) {
    throw new AppError("invalid_deadline", "deadlineMinutes must be a positive integer");
  }
  if (input.deadlineAt !== undefined && !Number.isFinite(Date.parse(input.deadlineAt))) {
    throw new AppError("invalid_deadline", "deadlineAt must be an ISO timestamp");
  }
  if (input.deadlineType !== undefined && !["hard", "preferred"].includes(input.deadlineType)) {
    throw new AppError("invalid_deadline_type", "deadlineType must be hard or preferred");
  }
  if (input.objectiveFamily !== undefined && !OBJECTIVE_FAMILIES.has(input.objectiveFamily)) {
    throw new AppError("invalid_objective_family", "objectiveFamily is invalid");
  }
  if (input.autoExecute !== undefined && typeof input.autoExecute !== "boolean") {
    throw new AppError("invalid_auto_execute", "autoExecute must be boolean");
  }
  if (input.scopeFlexibility?.hookVariants !== undefined
    && typeof input.scopeFlexibility.hookVariants !== "boolean") {
    throw new AppError("invalid_scope_flexibility", "scopeFlexibility.hookVariants must be boolean");
  }
  return { ...structuredClone(input), objective: input.objective.trim() };
}

function normalizedWeights(configured, override = {}) {
  const merged = { ...configured, ...override };
  const keys = ["objective", "quality", "cost", "speed"];
  if (keys.some((key) => typeof merged[key] !== "number" || merged[key] < 0)) {
    throw new AppError("invalid_preferences", "Decision weights must be non-negative numbers");
  }
  const total = keys.reduce((sum, key) => sum + merged[key], 0);
  if (total <= 0) throw new AppError("invalid_preferences", "At least one decision weight must be positive");
  return Object.fromEntries(keys.map((key) => [key, merged[key] / total]));
}

function objectiveScore(objective, productObjectives) {
  if (productObjectives.includes(objective)) return 1;
  const related = RELATED_OBJECTIVES[objective] ?? [];
  if (productObjectives.some((item) => related.includes(item))) return 0.7;
  return 0.15;
}

function qualityScore(product, request, hookVariants) {
  let score = 0.55;
  if (product.production?.voices >= 2 && ["social_proof", "objection_handling"].includes(request.objective)) score += 0.25;
  if (product.id === "proof_demo" && request.brief?.evidenceUrl) score += 0.25;
  if (product.id === "ranking_listicle" && request.brief?.items?.length >= 3) score += 0.2;
  if (request.brief?.referenceUrl && product.production?.format !== "talking-head") score += 0.1;
  if (request.scopeFlexibility?.hookVariants === true) score += 0.55 * HOOK_SCOPE_VALUE[hookVariants];
  return Math.min(score, 1);
}

function quoteRequest(request, productId, hookVariants, sellerFeeAllowanceSats = 0) {
  return {
    productId,
    sellerFeeAllowanceSats,
    productionMode: request.productionMode ?? "original",
    brief: { ...(request.brief ?? {}), objective: request.objective },
    addOns: {
      hookVariants,
      languages: request.addOns?.languages ?? ["en-US"],
      aspectRatios: request.addOns?.aspectRatios ?? ["9:16"],
      inputSourceManifest: request.addOns?.inputSourceManifest ?? false,
    },
  };
}

function planId(productId, addOns) {
  return [productId, `h${addOns.hookVariants}`, `l${addOns.languages.join("+")}`, `r${addOns.aspectRatios.join("+")}`].join(":");
}

function scopeSummary(quote) {
  const hooks = quote.addOns.hookVariants;
  const languages = quote.addOns.languages.length;
  const ratios = quote.addOns.aspectRatios.length;
  return `${hooks} hook${hooks === 1 ? "" : "s"} · ${languages} language${languages === 1 ? "" : "s"} · ${ratios} format${ratios === 1 ? "" : "s"}`;
}

function summarizeProducts(plans) {
  const grouped = new Map();
  for (const plan of plans) grouped.set(plan.productId, [...(grouped.get(plan.productId) ?? []), plan]);
  return [...grouped.values()].map((items) => {
    const sorted = [...items].sort((left, right) => (
      Number(right.eligible) - Number(left.eligible)
      || (right.score ?? -1) - (left.score ?? -1)
      || (left.quote?.amountSats ?? Number.MAX_SAFE_INTEGER) - (right.quote?.amountSats ?? Number.MAX_SAFE_INTEGER)
    ));
    return { ...sorted[0], plansEvaluated: items.length };
  }).sort((left, right) => (right.score ?? -1) - (left.score ?? -1));
}

function tradeoffSummary(plans, selected, request) {
  const eligible = plans.filter((plan) => plan.eligible);
  const sameProduct = plans.filter((plan) => plan.productId === selected.productId && plan.quote !== null);
  const cheaper = eligible
    .filter((plan) => plan.quote.amountSats < selected.quote.amountSats)
    .sort((left, right) => right.score - left.score || right.quote.amountSats - left.quote.amountSats)[0] ?? null;
  const broader = sameProduct
    .filter((plan) => plan.quote.addOns.hookVariants > selected.quote.addOns.hookVariants)
    .sort((left, right) => left.quote.addOns.hookVariants - right.quote.addOns.hookVariants)[0] ?? null;
  const total = (plan) => plan.totalAuthorizedSats;
  return {
    selected: {
      planId: selected.planId,
      label: scopeSummary(selected.quote),
      amountSats: selected.quote.amountSats,
      totalAuthorizedSats: total(selected),
      reason: "Best balance of campaign value and authorized spend.",
    },
    cheaper: cheaper === null ? null : {
      planId: cheaper.planId,
      label: scopeSummary(cheaper.quote),
      amountSats: cheaper.quote.amountSats,
      totalAuthorizedSats: total(cheaper),
      reason: "Costs less, but provides less testing scope or a weaker format fit.",
    },
    broader: broader === null ? null : {
      planId: broader.planId,
      label: scopeSummary(broader.quote),
      amountSats: broader.quote.amountSats,
      totalAuthorizedSats: total(broader),
      withinBudget: total(broader) <= request.budgetSats,
      reason: total(broader) <= request.budgetSats
        ? "More output is available, but the added spend does not improve the objective enough."
        : "Adds more output, but exceeds the approved budget.",
    },
  };
}

export class DecisionEngine {
  constructor({ seller, policy, advisor = null, paymentFeeReserveSats = null, clock = Date.now }) {
    this.seller = seller;
    this.policy = policy;
    this.advisor = advisor;
    this.paymentFeeReserveSats = Number.isSafeInteger(paymentFeeReserveSats)
      ? paymentFeeReserveSats
      : Number(policy.maxPaymentFeeSats ?? 0);
    this.clock = clock;
  }

  async evaluate(rawInput) {
    const request = validateRequest(rawInput);
    if (request.budgetSats > this.policy.maxCampaignSats) {
      throw new AppError(
        "campaign_budget_exceeds_policy",
        `Campaign budget exceeds the ${this.policy.maxCampaignSats}-sat policy ceiling`,
        403,
      );
    }
    if (request.productId && !this.policy.allowedProducts.includes(request.productId)) {
      throw new AppError("product_not_allowed", `Product is not allowed by Buyer policy: ${request.productId}`, 403);
    }

    const weights = normalizedWeights(this.policy.decisionWeights, request.preferences?.weights);
    const remainingDeadlineMinutes = request.deadlineAt === undefined
      ? request.deadlineMinutes
      : Math.max(0, Math.floor((Date.parse(request.deadlineAt) - this.clock()) / 60_000));
    const catalog = await this.seller.catalog();
    const available = catalog.products.filter((product) => (
      product.availability === "available"
      && this.policy.allowedProducts.includes(product.id)
      && (request.productId === undefined || product.id === request.productId)
    ));
    if (available.length === 0) throw new AppError("no_allowed_products", "No allowed Seller products match the request", 409);

    const requestedHooks = request.addOns?.hookVariants ?? 1;
    const flexibleHooks = request.scopeFlexibility?.hookVariants === true
      || (request.scopeFlexibility === undefined && request.addOns?.hookVariants === undefined);
    request.scopeFlexibility = { ...(request.scopeFlexibility ?? {}), hookVariants: flexibleHooks };
    const hookOptions = flexibleHooks ? HOOK_OPTIONS : [requestedHooks];
    const feeReserveSats = this.paymentFeeReserveSats;
    const planInputs = available.flatMap((product) => hookOptions.map((hookVariants) => ({ product, hookVariants })));

    const plans = await Promise.all(planInputs.map(async ({ product, hookVariants }) => {
      const requested = quoteRequest(request, product.id, hookVariants, feeReserveSats);
      const candidatePlanId = planId(product.id, requested.addOns);
      try {
        const quote = await this.seller.createQuote(requested);
        if (feeReserveSats > 0 && !Number.isSafeInteger(quote.sellerFeeAllowanceSats)) {
          throw new AppError("fee_inclusive_quote_required", "Seller did not provide a fee-inclusive quote", 502);
        }
        const sponsoredFeeSats = quote.sellerFeeAllowanceSats ?? feeReserveSats;
        if (!Number.isSafeInteger(quote.amountSats) || quote.amountSats <= 0
          || !Number.isSafeInteger(sponsoredFeeSats) || sponsoredFeeSats < 0
          || sponsoredFeeSats > feeReserveSats
          || (quote.customerPriceSats !== undefined
            && quote.customerPriceSats !== quote.amountSats + sponsoredFeeSats)) {
          throw new AppError("invalid_seller_quote", "Seller quote does not bind its invoice to the all-in customer price", 502);
        }
        const totalAuthorizedSats = quote.amountSats + sponsoredFeeSats;
        const rejections = [];
        if (Number.isSafeInteger(this.policy.maxPerOrderSats)
          && this.policy.maxPerOrderSats > 0
          && quote.amountSats > this.policy.maxPerOrderSats) {
          rejections.push("per_order_policy_ceiling");
        }
        if (totalAuthorizedSats > request.budgetSats) rejections.push("campaign_budget");
        if (remainingDeadlineMinutes !== undefined
          && request.deadlineType !== "preferred"
          && quote.estimatedTurnaroundMinutes > remainingDeadlineMinutes) rejections.push("deadline");
        const normalizedObjective = request.objectiveFamily ?? request.objective;
        const factors = {
          objective: objectiveScore(normalizedObjective, product.objectives),
          quality: qualityScore(product, request, hookVariants),
          cost: Math.max(0, 1 - (totalAuthorizedSats / request.budgetSats)),
          speed: remainingDeadlineMinutes === undefined
            ? Math.max(0, 1 - (quote.estimatedTurnaroundMinutes / 180))
            : Math.max(0, 1 - (quote.estimatedTurnaroundMinutes / Math.max(remainingDeadlineMinutes, 1))),
          scopeValue: flexibleHooks ? HOOK_SCOPE_VALUE[hookVariants] : 0,
        };
        const weightedScore = Object.entries(weights)
          .reduce((sum, [factor, weight]) => sum + (factors[factor] * weight), 0);
        const deterministicScore = Math.min(1, weightedScore + (0.08 * factors.scopeValue));
        return {
          planId: candidatePlanId,
          productId: product.id,
          productName: product.name,
          scope: {
            hookVariants,
            languages: quote.addOns.languages,
            aspectRatios: quote.addOns.aspectRatios,
            summary: scopeSummary(quote),
          },
          eligible: rejections.length === 0,
          rejections,
          quote,
          totalAuthorizedSats,
          remainingBudgetSats: request.budgetSats - totalAuthorizedSats,
          factors,
          score: Number(deterministicScore.toFixed(6)),
          deterministicScore: Number(deterministicScore.toFixed(6)),
          semanticAssessment: null,
        };
      } catch (error) {
        return {
          planId: candidatePlanId,
          productId: product.id,
          productName: product.name,
          scope: { ...requested.addOns, summary: `${hookVariants} hook${hookVariants === 1 ? "" : "s"}` },
          eligible: false,
          rejections: [error.code ?? "quote_failed"],
          quote: null,
          error: { code: error.code ?? "quote_failed", message: error.message },
          factors: null,
          score: null,
        };
      }
    }));

    const ranked = plans
      .filter((candidate) => candidate.eligible)
      .sort((left, right) => right.score - left.score || left.quote.amountSats - right.quote.amountSats);
    if (ranked.length === 0) {
      throw new AppError("no_eligible_quote", "No purchase plan satisfies the campaign budget and deadline", 409, {
        recommendation: "Increase the budget, relax the deadline, or reduce the requested output scope.",
        plans: plans.map(({ planId: id, productId, scope, rejections, error }) => ({ planId: id, productId, scope, rejections, error })),
      });
    }

    let selected = ranked[0];
    let rationale = `${selected.productName} with ${selected.scope.summary} best balances the campaign objective and authorized spend.`;
    let method = "deterministic_fallback";
    let advisorError = null;
    if (this.advisor !== null) {
      try {
        const advice = await this.advisor.rank({
          request,
          candidates: ranked.map((candidate) => ({
            planId: candidate.planId,
            productId: candidate.productId,
            productName: candidate.productName,
            product: candidate.quote.product,
            scope: candidate.scope,
            amountSats: candidate.quote.amountSats,
            feeReserveSats: candidate.quote.sellerFeeAllowanceSats ?? feeReserveSats,
            totalAuthorizedSats: candidate.totalAuthorizedSats,
            remainingBudgetSats: candidate.remainingBudgetSats,
            estimatedTurnaroundMinutes: candidate.quote.estimatedTurnaroundMinutes,
            productionMode: candidate.quote.productionMode,
            included: candidate.quote.product.included,
            deterministicFactors: candidate.factors,
          })),
        });
        const assessments = new Map(advice.rankings.map((item) => [item.planId, item]));
        for (const candidate of plans) {
          const assessment = assessments.get(candidate.planId);
          if (assessment === undefined) continue;
          candidate.semanticAssessment = assessment;
          candidate.score = assessment.overallScore;
        }
        selected = plans.find((candidate) => candidate.planId === advice.selectedPlanId && candidate.eligible);
        if (selected === undefined) throw new AppError("invalid_creative_advice", "Advisor selected an ineligible purchase plan", 502);
        rationale = advice.decisionRationale;
        method = "deepseek_semantic";
      } catch (error) {
        advisorError = { code: error.code ?? "creative_advisor_failed", message: error.message };
      }
    }

    if (selected.score < (this.policy.minimumDecisionScore ?? 0.35)) {
      throw new AppError("no_purchase_recommended", "Available plans do not provide enough value for the authorized spend", 409, {
        bestScore: selected.score,
        minimumDecisionScore: this.policy.minimumDecisionScore ?? 0.35,
        recommendation: "Revise the objective, budget, deadline, or requested scope before purchasing.",
      });
    }

    const economicAlternatives = plans
      .filter((plan) => plan.productId === selected.productId && plan.quote !== null)
      .sort((left, right) => left.quote.addOns.hookVariants - right.quote.addOns.hookVariants)
      .map((plan) => ({
        planId: plan.planId,
        hookVariants: plan.quote.addOns.hookVariants,
        amountSats: plan.quote.amountSats,
        feeReserveSats: plan.quote.sellerFeeAllowanceSats ?? feeReserveSats,
        totalAuthorizedSats: plan.totalAuthorizedSats,
        estimatedTurnaroundMinutes: plan.quote.estimatedTurnaroundMinutes,
        withinBudget: plan.totalAuthorizedSats <= request.budgetSats,
        selectedScope: plan.planId === selected.planId,
        quoteId: plan.quote.id,
      }));

    return {
      evaluatedAt: new Date().toISOString(),
      catalogVersion: catalog.version,
      objective: request.objective,
      objectiveFamily: request.objectiveFamily ?? null,
      budgetSats: request.budgetSats,
      feeReserveSats: selected.quote.sellerFeeAllowanceSats ?? feeReserveSats,
      weights,
      method,
      selected,
      candidates: summarizeProducts(plans),
      plans: [...plans].sort((left, right) => (right.score ?? -1) - (left.score ?? -1)),
      rationale,
      advisorError,
      economicAlternatives,
      tradeoffs: tradeoffSummary(plans, selected, request),
      referenceAssessment: request.brief?.referenceUrl
        ? { status: "input_only", note: "The URL is treated only as an optional localized visual input; no reference-style analysis or replication is promised." }
        : { status: "not_supplied" },
    };
  }
}

export { validateRequest };
