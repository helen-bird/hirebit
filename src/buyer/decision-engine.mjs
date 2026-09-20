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
  return {
    ...structuredClone(input),
    objective: input.objective.trim(),
  };
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

function qualityScore(product, request) {
  let score = 0.55;
  if (product.production?.voices >= 2 && ["social_proof", "objection_handling"].includes(request.objective)) score += 0.25;
  if (product.id === "proof_demo" && request.brief?.evidenceUrl) score += 0.25;
  if (product.id === "ranking_listicle" && request.brief?.items?.length >= 3) score += 0.2;
  if (request.brief?.referenceUrl && product.production?.format !== "talking-head") score += 0.1;
  return Math.min(score, 1);
}

function quoteRequest(request, productId) {
  return {
    productId,
    productionMode: request.productionMode ?? "original",
    budgetSats: request.budgetSats,
    brief: {
      ...(request.brief ?? {}),
      objective: request.objective,
    },
    addOns: {
      hookVariants: request.addOns?.hookVariants ?? 1,
      languages: request.addOns?.languages ?? ["en-US"],
      aspectRatios: request.addOns?.aspectRatios ?? ["9:16"],
      inputSourceManifest: request.addOns?.inputSourceManifest ?? false,
    },
  };
}

export class DecisionEngine {
  constructor({ seller, policy, advisor = null, clock = Date.now }) {
    this.seller = seller;
    this.policy = policy;
    this.advisor = advisor;
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

    const candidates = await Promise.all(available.map(async (product) => {
      try {
        const quote = await this.seller.createQuote(quoteRequest(request, product.id));
        const rejections = [];
        if (quote.amountSats > this.policy.maxPerOrderSats) rejections.push("per_order_policy_ceiling");
        if (quote.amountSats > request.budgetSats) rejections.push("campaign_budget");
        if (remainingDeadlineMinutes !== undefined
          && request.deadlineType !== "preferred"
          && quote.estimatedTurnaroundMinutes > remainingDeadlineMinutes) {
          rejections.push("deadline");
        }
        const normalizedObjective = request.objectiveFamily ?? request.objective;
        const factors = {
          objective: objectiveScore(normalizedObjective, product.objectives),
          quality: qualityScore(product, request),
          cost: Math.max(0, 1 - (quote.amountSats / request.budgetSats)),
          speed: remainingDeadlineMinutes === undefined
            ? Math.max(0, 1 - (quote.estimatedTurnaroundMinutes / 180))
            : Math.max(0, 1 - (quote.estimatedTurnaroundMinutes / Math.max(remainingDeadlineMinutes, 1))),
        };
        const deterministicScore = Object.entries(weights)
          .reduce((sum, [factor, weight]) => sum + (factors[factor] * weight), 0);
        return {
          productId: product.id,
          productName: product.name,
          eligible: rejections.length === 0,
          rejections,
          quote,
          factors,
          score: Number(deterministicScore.toFixed(6)),
          deterministicScore: Number(deterministicScore.toFixed(6)),
          semanticAssessment: null,
        };
      } catch (error) {
        return {
          productId: product.id,
          productName: product.name,
          eligible: false,
          rejections: [error.code ?? "quote_failed"],
          quote: null,
          error: { code: error.code ?? "quote_failed", message: error.message },
          factors: null,
          score: null,
        };
      }
    }));

    const ranked = candidates
      .filter((candidate) => candidate.eligible)
      .sort((left, right) => right.score - left.score || left.quote.amountSats - right.quote.amountSats);
    if (ranked.length === 0) {
      throw new AppError("no_eligible_quote", "No quote satisfies the campaign budget and deadline", 409, {
        candidates: candidates.map(({ productId, rejections, error }) => ({ productId, rejections, error })),
      });
    }

    let selected = ranked[0];
    let rationale = `${selected.productName} best satisfies objective, quality, cost and speed within the authorized constraints.`;
    let method = "deterministic_fallback";
    let advisorError = null;
    if (this.advisor !== null && ranked.length > 0) {
      try {
        const advice = await this.advisor.rank({
          request,
          candidates: ranked.map((candidate) => ({
            productId: candidate.productId,
            productName: candidate.productName,
            product: candidate.quote.product,
            amountSats: candidate.quote.amountSats,
            estimatedTurnaroundMinutes: candidate.quote.estimatedTurnaroundMinutes,
            productionMode: candidate.quote.productionMode,
            included: candidate.quote.product.included,
            deterministicFactors: candidate.factors,
          })),
        });
        const assessments = new Map(advice.rankings.map((item) => [item.productId, item]));
        for (const candidate of candidates) {
          const assessment = assessments.get(candidate.productId);
          if (assessment === undefined) continue;
          candidate.semanticAssessment = assessment;
          candidate.score = assessment.overallScore;
        }
        selected = candidates.find((candidate) => candidate.productId === advice.selectedProductId && candidate.eligible);
        if (selected === undefined) throw new AppError("invalid_creative_advice", "Advisor selected an ineligible product", 502);
        rationale = advice.decisionRationale;
        method = "deepseek_semantic";
      } catch (error) {
        advisorError = { code: error.code ?? "creative_advisor_failed", message: error.message };
      }
    }

    if (selected.score < (this.policy.minimumDecisionScore ?? 0.35)) {
      throw new AppError("no_purchase_recommended", "Available options do not provide enough value for the authorized spend", 409, {
        bestScore: selected.score,
        minimumDecisionScore: this.policy.minimumDecisionScore ?? 0.35,
      });
    }

    const economicAlternatives = [];
    for (const hookVariants of [1, 3, 5]) {
      try {
        const quote = await this.seller.createQuote({
          ...quoteRequest(request, selected.productId),
          addOns: {
            ...(quoteRequest(request, selected.productId).addOns),
            hookVariants,
          },
        });
        economicAlternatives.push({
          hookVariants,
          amountSats: quote.amountSats,
          estimatedTurnaroundMinutes: quote.estimatedTurnaroundMinutes,
          withinBudget: quote.amountSats <= request.budgetSats,
          selectedScope: hookVariants === selected.quote.addOns.hookVariants,
          quoteId: quote.id,
        });
      } catch (error) {
        economicAlternatives.push({
          hookVariants,
          withinBudget: false,
          selectedScope: false,
          rejection: error.code ?? "quote_failed",
        });
      }
    }

    return {
      evaluatedAt: new Date().toISOString(),
      catalogVersion: catalog.version,
      objective: request.objective,
      objectiveFamily: request.objectiveFamily ?? null,
      weights,
      method,
      selected,
      candidates: candidates.sort((left, right) => (right.score ?? -1) - (left.score ?? -1)),
      rationale,
      advisorError,
      economicAlternatives,
      referenceAssessment: request.brief?.referenceUrl
        ? { status: "input_only", note: "The URL is treated only as an optional localized visual input; no reference-style analysis or replication is promised." }
        : { status: "not_supplied" },
    };
  }
}

export { validateRequest };
