import { createHash, randomUUID } from "node:crypto";

import { AppError } from "../errors.mjs";
import { normalizeProductionLanguageTag } from "../production-contract.mjs";
import { safeSocialVideoUrl } from "../security.mjs";

export const INTAKE_INITIAL_STATE = Object.freeze({
  version: 1,
  delegations: {},
  idempotency: {},
  audit: [],
});

const PUBLIC_DEMO_QUOTA_WINDOW_MS = 60 * 60 * 1000;

export function publicDemoQuotaStatus(delegations, {
  maxDelegations,
  now = Date.now(),
  windowMs = PUBLIC_DEMO_QUOTA_WINDOW_MS,
} = {}) {
  const cutoff = now - windowMs;
  const counted = delegations
    .map((item) => Date.parse(item?.createdAt))
    .filter((createdAt) => Number.isFinite(createdAt) && createdAt >= cutoff)
    .sort((left, right) => left - right);
  const used = counted.length;
  return {
    used,
    limit: maxDelegations,
    available: Math.max(0, maxDelegations - used),
    exhausted: used >= maxDelegations,
    retryAt: used >= maxDelegations ? new Date(counted[0] + windowMs).toISOString() : null,
  };
}

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

function audit(state, clock, type, delegationId, data = {}) {
  state.audit.push({ id: `evt_${randomUUID()}`, at: nowIso(clock), type, delegationId, data });
}

function errorView(error, clock) {
  return { code: error.code ?? "internal_error", message: error.message, at: nowIso(clock) };
}

function chinese(text) {
  return /[\u3400-\u9fff]/u.test(text);
}

function question(id, field, zh, en, useChinese, reason) {
  return { id, field, question: useChinese ? zh : en, reason, required: true, source: "policy", impact: 1 };
}

function positiveLimit(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function questionsFor(extraction, {
  request,
  maxCampaignSats,
  clarificationRounds = 0,
  dynamicQuestionsAsked = 0,
  clarificationPolicy = {},
}) {
  const maxQuestionsPerRound = positiveLimit(clarificationPolicy.maxQuestionsPerRound, 5);
  const maxDynamicRounds = positiveLimit(clarificationPolicy.maxDynamicRounds, 3);
  const maxDynamicQuestions = positiveLimit(clarificationPolicy.maxDynamicQuestions, 15);
  const zh = chinese(request);
  const questions = [];
  if (extraction.objective === null || extraction.objectiveConfidence < 0.65) {
    questions.push(question(
      "objective", "objective",
      "这条视频最重要的业务目标是什么：转化、产品教育、对比、社会证明，还是其他目标？",
      "What is the primary business objective: conversion, product education, comparison, social proof, or something else?",
      zh, "objective_missing_or_uncertain",
    ));
  }
  if (extraction.subject === null && extraction.brief.productName === null && extraction.brief.description === null) {
    questions.push(question(
      "subject", "subject",
      "视频具体要推广或解释什么产品、服务或主题？",
      "What product, service, or subject should the video promote or explain?",
      zh, "subject_missing",
    ));
  }
  if (extraction.budgetSats === null) {
    questions.push(question(
      "budget_hard_limit", "budgetSats",
      "这次委托不可超过的最高预算是多少 sats？",
      "What is the maximum hard budget for this delegation in sats?",
      zh, "budget_missing",
    ));
  } else if (extraction.budgetType !== "hard_limit") {
    questions.push(question(
      "budget_hard_limit", "budgetSats",
      `你提到的 ${extraction.budgetSats} sats 是参考预算。请确认不可超过的最高预算。`,
      `You mentioned ${extraction.budgetSats} sats as a target. What is the maximum amount that must not be exceeded?`,
      zh, "hard_limit_not_explicit",
    ));
  } else if (extraction.budgetSats > maxCampaignSats) {
    questions.push(question(
      "policy_budget", "budgetSats",
      `Buyer 当前单次自动委托上限是 ${maxCampaignSats} sats。是否接受以 ${maxCampaignSats} sats 作为本次硬上限？`,
      `This Buyer is limited to ${maxCampaignSats} sats per delegation. Do you accept ${maxCampaignSats} sats as the hard cap?`,
      zh, "buyer_policy_limit",
    ));
  }
  if (extraction.authorizationMode === "unspecified") {
    questions.push(question(
      "authorization", "authorizationMode",
      "你希望 Buyer：只提供建议、选好后再向你确认购买，还是在预算内全自动下单？",
      "Should the Buyer only advise, ask before purchase, or order automatically within budget?",
      zh, "authorization_unspecified",
    ));
  }
  const existingFields = new Set(questions.map((item) => item.field));
  const existingIds = new Set(questions.map((item) => item.id));
  const dynamic = [...(extraction.clarificationQuestions ?? [])]
    .sort((left, right) => (
      Number(right.importance === "required") - Number(left.importance === "required")
      || (right.impact ?? 0) - (left.impact ?? 0)
    ));
  const requiredDynamicCount = new Set(dynamic
    .filter((item) => item.importance === "required" && !existingFields.has(item.field))
    .map((item) => item.field)).size;
  const optionalDynamicCapacity = clarificationRounds >= maxDynamicRounds
    ? 0
    : Math.max(0, Math.min(
      maxQuestionsPerRound - questions.length - requiredDynamicCount,
      maxDynamicQuestions - dynamicQuestionsAsked,
    ));
  let added = 0;
  for (const [index, item] of dynamic.entries()) {
    const required = item.importance === "required";
    const normalizedField = item.field.toLowerCase().replace(/[^a-z]/gu, "");
    const authorityAlreadyChosen = extraction.authorizationMode !== "unspecified"
      && ["authorization", "authorizationmode", "autoauthorizationexplicit"].includes(normalizedField);
    if (authorityAlreadyChosen) continue;
    if ((!required && added >= optionalDynamicCapacity) || existingFields.has(item.field)) continue;
    const slug = item.field.toLowerCase().replace(/[^a-z0-9_-]/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 48);
    const baseId = `context_${slug || index + 1}`;
    let id = baseId;
    let suffix = 2;
    while (existingIds.has(id)) {
      id = `${baseId}_${suffix}`;
      suffix += 1;
    }
    questions.push({
      id,
      field: item.field,
      question: item.question,
      reason: `model_material_choice: ${item.reason}`,
      required,
      source: "model",
      impact: item.impact ?? 0.5,
    });
    existingFields.add(item.field);
    existingIds.add(id);
    if (!required) added += 1;
  }
  return questions;
}

function makeMandate(extraction, version, context = {}) {
  const scope = {
    version,
    objective: extraction.objective,
    objectiveFamily: extraction.objectiveFamily ?? null,
    budgetSats: extraction.budgetSats,
    budgetType: extraction.budgetType,
    deadlineMinutes: extraction.deadlineMinutes,
    deadlineType: extraction.deadlineType ?? (extraction.deadlineMinutes === null ? null : "hard"),
    decisionPriorities: extraction.decisionPriorities ?? {
      objective: 0.55, quality: 0.15, cost: 0.15, speed: 0.15,
    },
    authorizationMode: extraction.authorizationMode,
    subject: extraction.subject,
    referenceUploadId: context.referenceUploadId ?? null,
    referenceVideoUrl: context.referenceVideoUrl ?? null,
    scopeFlexibility: {
      hookVariants: extraction.brief.hookVariants === null,
    },
    brief: {
      ...extraction.brief,
      languages: extraction.brief.languages.length > 0
        ? extraction.brief.languages.map((item) => normalizeProductionLanguageTag(item) ?? item)
        : ["en-US"],
      aspectRatios: extraction.brief.aspectRatios.length > 0 ? extraction.brief.aspectRatios : ["9:16"],
      hookVariants: extraction.brief.hookVariants,
      visualMode: extraction.brief.visualMode ?? "package_default",
      voiceRequirements: extraction.brief.voiceRequirements ?? [],
    },
    assumptions: extraction.assumptions,
  };
  return { ...scope, scopeHash: digest(scope) };
}

function validateCreate(input) {
  if (input === null || typeof input !== "object") throw new AppError("invalid_delegation", "Delegation must be a JSON object");
  if (typeof input.request !== "string" || input.request.trim().length < 10) {
    throw new AppError("invalid_delegation", "request must contain at least 10 characters");
  }
  if (input.request.length > 12_000) throw new AppError("delegation_too_large", "request exceeds 12,000 characters", 413);
  const context = input.context ?? {};
  if (context === null || typeof context !== "object" || Array.isArray(context)) {
    throw new AppError("invalid_delegation", "context must be a JSON object");
  }
  if (Buffer.byteLength(JSON.stringify(context)) > 20_000) {
    throw new AppError("delegation_too_large", "context exceeds 20 KB", 413);
  }
  if (context.purchaseMode !== undefined
    && !["auto_within_budget", "confirm_before_purchase"].includes(context.purchaseMode)) {
    throw new AppError("invalid_delegation", "context.purchaseMode is invalid");
  }
  if (context.referenceUploadId !== undefined
    && !/^[a-f0-9]{48}\.(?:jpg|png)$/u.test(context.referenceUploadId)) {
    throw new AppError("invalid_delegation", "context.referenceUploadId is invalid");
  }
  const normalizedContext = structuredClone(context);
  if (context.referenceVideoUrl !== undefined) {
    normalizedContext.referenceVideoUrl = safeSocialVideoUrl(
      context.referenceVideoUrl,
      context.platform,
      "context.referenceVideoUrl",
    );
  }
  return { request: input.request.trim(), context: normalizedContext };
}

function delegationState(campaign, authorizationMode) {
  if (campaign.state === "completed") return "completed";
  if (campaign.state === "cancelled") return "cancelled";
  if (["cancellation_pending", "refund_review_required", "cost_review_required"].includes(campaign.state)) {
    return campaign.state;
  }
  if (campaign.state === "decision_failed") return "campaign_failed";
  if (campaign.state === "payment_origin_review_required") return "payment_origin_review_required";
  if (["spend_blocked", "order_failed", "payment_preparation_failed"].includes(campaign.state)) {
    return "execution_paused";
  }
  if (campaign.state === "decision_ready" && authorizationMode === "advisory_only") return "advisory_ready";
  if (campaign.state === "decision_ready" && authorizationMode === "confirm_before_purchase") {
    return "awaiting_purchase_confirmation";
  }
  return "campaign_active";
}

const CANCELLATION_STATES = new Set(["cancelled", "cancellation_pending", "refund_review_required", "cost_review_required"]);

export class IntakeService {
  constructor({
    store,
    extractor,
    buyer,
    policy,
    clock = Date.now,
    allowExternalUrls = true,
    referenceUploadBaseUrl = null,
  }) {
    this.store = store;
    this.extractor = extractor;
    this.buyer = buyer;
    this.policy = policy;
    this.clock = clock;
    this.allowExternalUrls = allowExternalUrls;
    this.referenceUploadBaseUrl = referenceUploadBaseUrl;
    this.tasks = new Map();
  }

  async readiness() {
    const model = await this.extractor.readiness();
    return { ready: model.configured === true, model };
  }

  async createDelegation({ input: rawInput, idempotencyKey, maxHourlyDelegations = null }) {
    if (typeof idempotencyKey !== "string" || idempotencyKey.trim().length < 8 || idempotencyKey.length > 200) {
      throw new AppError("invalid_idempotency_key", "Idempotency-Key must contain 8-200 characters");
    }
    const input = validateCreate(rawInput);
    const inputHash = digest(input);
    const key = idempotencyKey.trim();
    const created = await this.store.transaction((state) => {
      const existingId = state.idempotency[key];
      if (existingId !== undefined) {
        const existing = state.delegations[existingId];
        if (existing.inputHash !== inputHash) {
          throw new AppError("idempotency_conflict", "Idempotency-Key is already bound to another delegation", 409);
        }
        return { delegation: existing, isNew: false };
      }
      if (maxHourlyDelegations !== null) {
        const quota = publicDemoQuotaStatus(Object.values(state.delegations), {
          maxDelegations: maxHourlyDelegations,
          now: this.clock(),
        });
        if (quota.exhausted) {
          throw new AppError(
            "public_demo_quota_exhausted",
            `The hourly Demo limit has been reached. A slot reopens after ${quota.retryAt}`,
            429,
            quota,
          );
        }
      }
      const id = `dlg_${randomUUID()}`;
      const delegation = {
        id,
        state: "interpreting",
        createdAt: nowIso(this.clock),
        updatedAt: nowIso(this.clock),
        input,
        inputHash,
        revision: 0,
        clarification: { rounds: 0, dynamicQuestionsAsked: 0 },
        answers: {},
        extraction: null,
        mandate: null,
        questions: [],
        approval: null,
        interpretationAttempts: [],
        campaignId: null,
        campaign: null,
        lastError: null,
      };
      state.delegations[id] = delegation;
      state.idempotency[key] = id;
      audit(state, this.clock, "delegation.created", id);
      return { delegation, isNew: true };
    });
    if (!created.isNew) return structuredClone(created.delegation);
    return await this.#interpret(created.delegation.id);
  }

  getDelegation(delegationId) {
    const delegation = this.store.snapshot().delegations[delegationId];
    if (delegation === undefined) throw new AppError("delegation_not_found", "Delegation not found", 404);
    return structuredClone(delegation);
  }

  listDelegations(limit = 20) {
    const bounded = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 20;
    return Object.values(this.store.snapshot().delegations)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, bounded)
      .map((item) => structuredClone(item));
  }

  audit(delegationId) {
    const state = this.store.snapshot();
    if (state.delegations[delegationId] === undefined) throw new AppError("delegation_not_found", "Delegation not found", 404);
    return state.audit.filter((event) => event.delegationId === delegationId);
  }

  async answerQuestions(delegationId, input) {
    const delegation = this.getDelegation(delegationId);
    const optionalRefinement = delegation.state === "approval_required"
      && delegation.questions.length > 0
      && delegation.questions.every((item) => item.required === false);
    if (!new Set(["clarification_required", "interpretation_failed"]).has(delegation.state) && !optionalRefinement) {
      throw new AppError("clarification_not_expected", `Cannot answer questions from state: ${delegation.state}`, 409);
    }
    if (input === null || typeof input !== "object" || input.answers === null
      || typeof input.answers !== "object" || Array.isArray(input.answers)) {
      throw new AppError("invalid_answers", "answers must be a JSON object keyed by question ID");
    }
    const allowed = new Set(delegation.questions.map((item) => item.id));
    if (delegation.state === "interpretation_failed") allowed.add("clarification_note");
    const entries = Object.entries(input.answers);
    if (entries.length === 0) throw new AppError("invalid_answers", "At least one answer is required");
    if (entries.length > 20) {
      throw new AppError("answers_too_large", "Answer no more than 20 questions at a time", 413);
    }
    if (entries.some(([id]) => !allowed.has(id))) {
      throw new AppError("unknown_question", "answers contains an unknown question ID");
    }
    if (entries.some(([, value]) => !["string", "number", "boolean"].includes(typeof value))) {
      throw new AppError("invalid_answers", "Answer values must be strings, numbers, or booleans");
    }
    if (entries.some(([, value]) => String(value).length > 1000)
      || entries.reduce((sum, [, value]) => sum + String(value).length, 0) > 6000) {
      throw new AppError("answers_too_large", "Each answer may contain up to 1,000 characters, with 6,000 total per submission", 413);
    }
    await this.store.transaction((state) => {
      const current = state.delegations[delegationId];
      const stillOptionalRefinement = current.state === "approval_required"
        && current.questions.length > 0
        && current.questions.every((item) => item.required === false);
      if (!new Set(["clarification_required", "interpretation_failed"]).has(current.state) && !stillOptionalRefinement) {
        throw new AppError("clarification_not_expected", `Cannot answer questions from state: ${current.state}`, 409);
      }
      const currentAllowed = new Set(current.questions.map((item) => item.id));
      if (current.state === "interpretation_failed") currentAllowed.add("clarification_note");
      if (entries.some(([id]) => !currentAllowed.has(id))) {
        throw new AppError("unknown_question", "answers contains an unknown or stale question ID");
      }
      const updatedAnswers = { ...current.answers, ...structuredClone(input.answers) };
      if (Object.keys(updatedAnswers).length > 30
        || Object.values(updatedAnswers).reduce((sum, value) => sum + String(value).length, 0) > 12_000) {
        throw new AppError("answers_too_large", "This brief has reached its clarification text limit", 413);
      }
      current.answers = updatedAnswers;
      current.clarification ??= { rounds: 0, dynamicQuestionsAsked: 0 };
      current.clarification.rounds += 1;
      current.state = "interpreting";
      current.updatedAt = nowIso(this.clock);
      audit(state, this.clock, "clarification.answered", delegationId, { questionIds: entries.map(([id]) => id) });
    });
    return await this.#interpret(delegationId);
  }

  async retryInterpretation(delegationId) {
    const delegation = this.getDelegation(delegationId);
    if (delegation.state !== "interpretation_failed") {
      throw new AppError("interpretation_retry_not_expected", `Cannot retry interpretation from state: ${delegation.state}`, 409);
    }
    await this.store.transaction((state) => {
      const current = state.delegations[delegationId];
      if (current.state !== "interpretation_failed") {
        throw new AppError("interpretation_retry_not_expected", `Cannot retry interpretation from state: ${current.state}`, 409);
      }
      current.state = "interpreting";
      current.updatedAt = nowIso(this.clock);
      audit(state, this.clock, "mandate.interpretation_retry_requested", delegationId, {
        previousErrorCode: current.lastError?.code ?? null,
      });
    });
    return await this.#interpret(delegationId);
  }

  async confirmMandate(delegationId, input) {
    let delegation = this.getDelegation(delegationId);
    if (["creating_campaign", "campaign_creation_failed"].includes(delegation.state)
      && delegation.approval?.approved === true) {
      return await this.#ensureCampaign(delegationId);
    }
    if (delegation.state !== "approval_required") {
      throw new AppError("approval_not_expected", `Cannot confirm mandate from state: ${delegation.state}`, 409);
    }
    if (typeof input?.approved !== "boolean") {
      throw new AppError("invalid_approval", "approved must be boolean");
    }
    if (input.approved === false) {
      return await this.store.transaction((state) => {
        const current = state.delegations[delegationId];
        if (current.state !== "approval_required") {
          throw new AppError("approval_not_expected", `Cannot decline mandate from state: ${current.state}`, 409);
        }
        current.state = "declined";
        current.approval = { approved: false, at: nowIso(this.clock) };
        current.updatedAt = nowIso(this.clock);
        audit(state, this.clock, "mandate.declined", delegationId);
        return current;
      });
    }
    delegation = await this.store.transaction((state) => {
      const current = state.delegations[delegationId];
      if (current.state !== "approval_required") {
        throw new AppError("approval_not_expected", `Cannot confirm mandate from state: ${current.state}`, 409);
      }
      if (input.mandateVersion !== current.mandate.version || input.scopeHash !== current.mandate.scopeHash) {
        throw new AppError("stale_mandate", "Mandate version or scope hash does not match the current proposal", 409);
      }
      current.state = "creating_campaign";
      current.approval = {
        approved: true,
        mandateVersion: current.mandate.version,
        scopeHash: current.mandate.scopeHash,
        at: nowIso(this.clock),
      };
      current.updatedAt = nowIso(this.clock);
      audit(state, this.clock, "mandate.approved", delegationId, {
        mandateVersion: current.mandate.version,
        authorizationMode: current.mandate.authorizationMode,
        budgetSats: current.mandate.budgetSats,
      });
      return current;
    });
    return await this.#ensureCampaign(delegation.id);
  }

  async confirmPurchase(delegationId, selectionDigest) {
    const delegation = this.getDelegation(delegationId);
    if (delegation.state !== "awaiting_purchase_confirmation") {
      throw new AppError("purchase_confirmation_not_expected", `Cannot confirm purchase from state: ${delegation.state}`, 409);
    }
    if (typeof selectionDigest !== "string" || !/^[a-f0-9]{64}$/u.test(selectionDigest)) {
      throw new AppError("invalid_purchase_confirmation", "A valid displayed purchase selection is required", 400);
    }
    const campaign = await this.buyer.executeCampaign(delegation.campaignId, {
      purchaseAuthorization: {
        type: "delegation_purchase_confirmation",
        delegationId,
        selectionDigest,
      },
    });
    return await this.#recordCampaign(delegationId, campaign, "purchase.confirmed");
  }

  async syncDelegation(delegationId) {
    const delegation = this.getDelegation(delegationId);
    if (delegation.campaignId === null) {
      if (delegation.state === "cancellation_pending" && delegation.approval?.approved === true
        && !this.tasks.has(`campaign:${delegationId}`)) return await this.#ensureCampaign(delegationId);
      return delegation;
    }
    const campaign = delegation.cancellationRequestedAt
      ? await this.buyer.cancelCampaign(delegation.campaignId)
      : await this.buyer.syncCampaign(delegation.campaignId);
    return await this.#recordCampaign(delegationId, campaign, "campaign.synced");
  }

  async resumeDelegation(delegationId) {
    const delegation = this.getDelegation(delegationId);
    if (delegation.campaignId === null || delegation.campaign === null) {
      throw new AppError("campaign_resume_not_expected", "This delegation has no campaign to resume", 409);
    }
    const resumable = new Set(["spend_blocked", "order_failed", "payment_preparation_failed"]);
    if (!resumable.has(delegation.campaign.state)) {
      throw new AppError(
        "campaign_resume_not_expected",
        `Cannot resume campaign from state: ${delegation.campaign.state}`,
        409,
      );
    }
    const campaign = await this.buyer.resumeCampaign(delegation.campaignId);
    return await this.#recordCampaign(delegationId, campaign, "campaign.resume_requested");
  }

  async cancelDelegation(delegationId) {
    const pending = await this.store.transaction((state) => {
      const current = state.delegations[delegationId];
      if (current === undefined) throw new AppError("delegation_not_found", "Delegation not found", 404);
      if (["completed", "cancelled", "declined"].includes(current.state)) return current;
      const firstRequest = current.cancellationRequestedAt == null;
      current.cancellationRequestedAt ??= nowIso(this.clock);
      const creationMayBeInFlight = ["creating_campaign", "campaign_creation_failed", "cancellation_pending"].includes(current.state);
      current.state = current.campaignId !== null || creationMayBeInFlight ? "cancellation_pending" : "cancelled";
      if (current.state === "cancelled") current.cancelledAt = nowIso(this.clock);
      current.updatedAt = nowIso(this.clock);
      if (firstRequest) audit(state, this.clock, current.state === "cancelled" ? "delegation.cancelled" : "delegation.cancellation_requested", delegationId);
      return current;
    });
    if (pending.campaignId === null || pending.state === "cancelled") return pending;
    try {
      const campaign = await this.buyer.cancelCampaign(pending.campaignId);
      return await this.#recordCampaign(delegationId, campaign, "delegation.cancellation_reconciled");
    } catch (error) {
      return await this.store.transaction((state) => {
        const current = state.delegations[delegationId];
        current.state = "cancellation_pending";
        current.lastError = errorView(error, this.clock);
        current.updatedAt = nowIso(this.clock);
        audit(state, this.clock, "delegation.cancellation_reconcile_failed", delegationId, { code: current.lastError.code });
        return current;
      });
    }
  }

  async retryFulfillment(delegationId) {
    const delegation = this.getDelegation(delegationId);
    if (delegation.campaignId === null) throw new AppError("campaign_not_created", "Delegation has no campaign", 409);
    const campaign = await this.buyer.retryFulfillment(delegation.campaignId);
    return await this.#recordCampaign(delegationId, campaign, "fulfillment.retry_requested");
  }

  async requestResolution(delegationId, input) {
    const reason = typeof input?.reason === "string" ? input.reason.trim() : "";
    if (reason.length < 5 || reason.length > 1000) {
      throw new AppError("invalid_resolution_request", "reason must contain 5-1000 characters");
    }
    return await this.store.transaction((state) => {
      const current = state.delegations[delegationId];
      if (current === undefined) throw new AppError("delegation_not_found", "Delegation not found", 404);
      if (current.resolution?.state === "human_review_required") return current;
      const completedAt = current.campaign?.completedAt;
      const isDeliveryDispute = current.campaign?.state === "completed";
      if (!isDeliveryDispute && !["fulfillment_failed", "refund_review_required", "cost_review_required", "payment_uncertain"].includes(current.campaign?.state)) {
        throw new AppError("resolution_not_expected", "This order has no paid fulfillment or delivery issue to review", 409);
      }
      const deadlineAt = completedAt ? new Date(Date.parse(completedAt) + 72 * 60 * 60 * 1000).toISOString() : null;
      if (isDeliveryDispute && (!completedAt || this.clock() > Date.parse(deadlineAt))) {
        throw new AppError("dispute_window_closed", "The 72-hour delivery review window has ended", 409);
      }
      const files = current.campaign.package?.files ?? [];
      const evidence = input?.evidence;
      const expected = typeof evidence?.expected === "string" ? evidence.expected.trim() : "";
      const observed = typeof evidence?.observed === "string" ? evidence.observed.trim() : "";
      const artifactPath = typeof evidence?.artifactPath === "string" ? evidence.artifactPath : "";
      const artifact = files.find((file) => file.path === artifactPath && artifactPath.startsWith("creatives/"));
      if (isDeliveryDispute && (expected.length < 5 || expected.length > 500
        || observed.length < 5 || observed.length > 500 || artifact === undefined)) {
        throw new AppError("dispute_evidence_required", "Describe expected and observed results and select a delivered creative", 400);
      }
      const timecodeSeconds = evidence?.timecodeSeconds;
      if (isDeliveryDispute && timecodeSeconds !== undefined) {
        const durationSeconds = artifact?.validation?.durationSeconds;
        if (!Number.isFinite(timecodeSeconds) || timecodeSeconds < 0
          || !Number.isFinite(durationSeconds) || durationSeconds <= 0
          || timecodeSeconds > Math.min(durationSeconds + 0.25, 3600)) {
          throw new AppError("invalid_dispute_timecode", "timecodeSeconds must be within the verified delivered video duration", 400);
        }
      }
      const manifestSha256 = files.find((file) => file.path === "manifest.json")?.sha256
        ?? current.campaign.package?.manifestSha256 ?? null;
      const deliveryManifest = current.campaign.package == null ? null : {
        version: 1,
        campaignId: current.campaign.id ?? current.campaignId,
        generatedAt: current.campaign.package.generatedAt ?? null,
        ...(current.campaign.package.settlementUpdatedAt
          ? { settlementUpdatedAt: current.campaign.package.settlementUpdatedAt } : {}),
        files: structuredClone(files.filter((file) => file.path !== "manifest.json")),
      };
      const reconstructedManifestSha256 = deliveryManifest === null ? null
        : createHash("sha256").update(`${JSON.stringify(deliveryManifest, null, 2)}\n`).digest("hex");
      const servicePriceSats = current.campaign?.sellerOrder?.amountSats;
      const maxQualityRefundSats = isDeliveryDispute && Number.isSafeInteger(servicePriceSats) && servicePriceSats > 0
        ? Math.floor(servicePriceSats / 5) : null;
      const claim = {
        type: isDeliveryDispute ? "delivery_quality" : "fulfillment_or_payment",
        reason,
        evidence: isDeliveryDispute ? {
          expected, observed, artifactPath,
          timecodeSeconds: timecodeSeconds ?? null,
          artifactSha256: artifact.sha256 ?? null,
          packageManifestSha256: manifestSha256,
        } : null,
        deliverySnapshot: current.campaign.package == null ? null : {
          generatedAt: current.campaign.package.generatedAt ?? null,
          manifestSha256,
          reconstructedManifestSha256,
          manifestMatches: reconstructedManifestSha256 === manifestSha256,
          manifest: deliveryManifest,
          files: files.map((file) => ({
            path: file.path, sha256: file.sha256 ?? null,
            bytes: file.bytes ?? null, mediaType: file.mediaType ?? null,
          })),
        },
        requestedAt: nowIso(this.clock),
        deadlineAt,
        state: "human_review_required",
        freeReworksAvailable: 0,
        maxQualityRefundSats,
        refund: { state: "not_issued", amountSats: null },
      };
      current.resolution = claim;
      current.updatedAt = nowIso(this.clock);
      audit(state, this.clock, "resolution.requested", delegationId, { type: claim.type, artifactPath: claim.evidence?.artifactPath ?? null });
      return current;
    });
  }

  async recover() {
    const recoverable = Object.values(this.store.snapshot().delegations)
      .filter((item) => ["interpreting", "creating_campaign"].includes(item.state)
        || (item.state === "cancellation_pending" && item.campaignId === null && item.approval?.approved === true));
    return await Promise.allSettled(recoverable.map((item) => (
      item.state === "interpreting" ? this.#interpret(item.id) : this.#ensureCampaign(item.id)
    )));
  }

  async #interpret(delegationId) {
    const taskKey = `interpret:${delegationId}`;
    if (this.tasks.has(taskKey)) return await this.tasks.get(taskKey);
    const task = (async () => {
      // Reserve the attempt durably before contacting the paid provider. A crash
      // between reservation and response still consumes a slot rather than
      // permitting an unbounded replay of an uncertain call.
      const reservation = await this.store.transaction((state) => {
        const current = state.delegations[delegationId];
        if (current === undefined) throw new AppError("delegation_not_found", "Delegation not found", 404);
        if (current.cancellationRequestedAt || current.state !== "interpreting") {
          return { skip: true, delegation: current };
        }
        const now = this.clock();
        const recent = (Array.isArray(current.interpretationAttempts) ? current.interpretationAttempts : [])
          .filter((at) => Number.isFinite(Date.parse(at)) && Date.parse(at) > now - 60 * 60 * 1000)
          .sort((left, right) => Date.parse(left) - Date.parse(right));
        current.interpretationAttempts = recent;
        if (recent.length >= 10) {
          const retryAt = new Date(Date.parse(recent[0]) + 60 * 60 * 1000).toISOString();
          current.state = "interpretation_failed";
          current.lastError = {
            code: "model_attempt_limit",
            message: "This brief has reached its hourly interpretation limit; retry after the displayed time",
            at: nowIso(this.clock), retryAt,
          };
          current.updatedAt = nowIso(this.clock);
          audit(state, this.clock, "mandate.interpretation_limited", delegationId, { retryAt });
          return { limited: true, retryAt };
        }
        current.interpretationAttempts.push(new Date(now).toISOString());
        audit(state, this.clock, "mandate.interpretation_attempt_reserved", delegationId, {
          attemptsInHour: current.interpretationAttempts.length,
        });
        return { delegation: current };
      });
      if (reservation.limited) {
        throw new AppError("model_attempt_limit", "This brief has reached its hourly interpretation limit", 429, {
          retryAt: reservation.retryAt,
        });
      }
      if (reservation.skip) return reservation.delegation;
      const delegation = reservation.delegation;
      try {
        const modelContext = { ...delegation.input.context };
        if (modelContext.referenceUploadId !== undefined) {
          delete modelContext.referenceUploadId;
          modelContext.hasProductImage = true;
        }
        const extracted = await this.extractor.extract({
          request: delegation.input.request,
          context: modelContext,
          answers: Object.entries(delegation.answers).map(([id, answer]) => ({
            id,
            answer,
            question: delegation.questions.find((item) => item.id === id)?.question ?? null,
          })),
          prior: delegation.extraction,
        });
        const selectedPurchaseMode = delegation.input.context.purchaseMode;
        const purchaseScopedExtraction = selectedPurchaseMode === undefined
          ? extracted
          : {
              ...extracted,
              authorizationMode: selectedPurchaseMode,
              autoAuthorizationExplicit: selectedPurchaseMode === "auto_within_budget",
            };
        const referenceVideoUrl = delegation.input.context.referenceVideoUrl ?? null;
        const extraction = this.allowExternalUrls === true
          ? (referenceVideoUrl === null
              ? purchaseScopedExtraction
              : {
                  ...purchaseScopedExtraction,
                  brief: { ...purchaseScopedExtraction.brief, evidenceUrl: referenceVideoUrl },
                })
          : {
              ...purchaseScopedExtraction,
              // Public mode never accepts a model-authored URL. Only the customer's
              // separately validated social-video field may enter production evidence.
              brief: {
                ...purchaseScopedExtraction.brief,
                referenceUrl: null,
                evidenceUrl: referenceVideoUrl,
              },
            };
        const version = delegation.revision + 1;
        const questions = questionsFor(extraction, {
          request: delegation.input.request,
          maxCampaignSats: this.policy.maxCampaignSats,
          clarificationRounds: delegation.clarification?.rounds ?? 0,
          dynamicQuestionsAsked: delegation.clarification?.dynamicQuestionsAsked ?? 0,
          clarificationPolicy: this.policy.clarification,
        });
        const mandate = makeMandate(extraction, version, delegation.input.context);
        return await this.store.transaction((state) => {
          const current = state.delegations[delegationId];
          if (current.cancellationRequestedAt) return current;
          current.revision = version;
          current.extraction = extraction;
          current.mandate = mandate;
          current.questions = questions;
          current.clarification ??= { rounds: 0, dynamicQuestionsAsked: 0 };
          current.clarification.dynamicQuestionsAsked += questions
            .filter((item) => item.source === "model" && item.required === false).length;
          current.state = questions.some((item) => item.required !== false)
            ? "clarification_required"
            : "approval_required";
          current.lastError = null;
          current.updatedAt = nowIso(this.clock);
          audit(state, this.clock, "mandate.interpreted", delegationId, {
            mandateVersion: version,
            state: current.state,
            questionIds: questions.map((item) => item.id),
          });
          return current;
        });
      } catch (error) {
        return await this.store.transaction((state) => {
          const current = state.delegations[delegationId];
          if (current.cancellationRequestedAt) return current;
          current.state = "interpretation_failed";
          current.lastError = errorView(error, this.clock);
          current.updatedAt = nowIso(this.clock);
          audit(state, this.clock, "mandate.interpretation_failed", delegationId, { code: current.lastError.code });
          return current;
        });
      }
    })().finally(() => this.tasks.delete(taskKey));
    this.tasks.set(taskKey, task);
    return await task;
  }

  async #ensureCampaign(delegationId) {
    const taskKey = `campaign:${delegationId}`;
    if (this.tasks.has(taskKey)) return await this.tasks.get(taskKey);
    const task = (async () => {
      const delegation = this.getDelegation(delegationId);
      if (delegation.state === "cancelled") return delegation;
      if (delegation.campaignId !== null) {
        const campaign = delegation.cancellationRequestedAt
          ? await this.buyer.cancelCampaign(delegation.campaignId)
          : await this.buyer.resumeCampaign(delegation.campaignId);
        return await this.#recordCampaign(delegationId, campaign, "campaign.recovered");
      }
      const mandate = delegation.mandate;
      if (mandate.referenceUploadId !== null && this.referenceUploadBaseUrl === null) {
        throw new AppError("reference_upload_unavailable", "Uploaded product images are not configured for this Buyer", 503);
      }
      const uploadedReferenceUrl = mandate.referenceUploadId === null
        ? null
        : `${this.referenceUploadBaseUrl}/v1/uploads/${encodeURIComponent(mandate.referenceUploadId)}`;
      const autoExecute = mandate.authorizationMode === "auto_within_budget";
      const deadlineAt = mandate.deadlineMinutes === null
        ? null
        : new Date(Date.parse(delegation.createdAt) + (mandate.deadlineMinutes * 60_000)).toISOString();
      if (deadlineAt !== null && Date.parse(deadlineAt) <= this.clock()) {
        throw new AppError("delegation_deadline_expired", "The delegation deadline expired before campaign creation", 409);
      }
      const campaignInput = {
        objective: mandate.objective,
        objectiveFamily: mandate.objectiveFamily,
        budgetSats: mandate.budgetSats,
        ...(mandate.deadlineMinutes === null ? {} : { deadlineMinutes: mandate.deadlineMinutes }),
        ...(deadlineAt === null ? {} : { deadlineAt }),
        ...(mandate.deadlineType === null ? {} : { deadlineType: mandate.deadlineType }),
        preferences: { weights: mandate.decisionPriorities },
        scopeFlexibility: mandate.scopeFlexibility,
        autoExecute,
        authorizationMode: mandate.authorizationMode,
        delegationId,
        decisionContext: {
          customerRequest: delegation.input.request,
          assumptions: mandate.assumptions,
        },
        brief: {
          productName: mandate.brief.productName ?? mandate.subject,
          description: mandate.brief.description ?? mandate.subject,
          ...(mandate.brief.referenceUrl
            ? { referenceUrl: mandate.brief.referenceUrl }
            : (uploadedReferenceUrl ? { referenceUrl: uploadedReferenceUrl } : {})),
          ...(mandate.brief.evidenceUrl ? { evidenceUrl: mandate.brief.evidenceUrl } : {}),
          ...(mandate.brief.items.length > 0 ? { items: mandate.brief.items } : {}),
          visualMode: mandate.brief.visualMode,
          voiceRequirements: mandate.brief.voiceRequirements,
        },
        addOns: {
          ...(mandate.scopeFlexibility.hookVariants
            ? {}
            : { hookVariants: mandate.brief.hookVariants }),
          languages: mandate.brief.languages,
          aspectRatios: mandate.brief.aspectRatios,
        },
      };
      try {
        const campaign = await this.buyer.createCampaign({
          input: campaignInput,
          idempotencyKey: `delegation-${delegationId}-v${mandate.version}`,
          onCreated: async (createdCampaign) => {
            const linked = await this.store.transaction((state) => {
              const current = state.delegations[delegationId];
              if (current.campaignId !== null && current.campaignId !== createdCampaign.id) {
                throw new AppError("campaign_link_conflict", "Delegation is already linked to another campaign", 409);
              }
              current.campaignId = createdCampaign.id;
              current.campaign = createdCampaign;
              if (current.cancellationRequestedAt) current.state = "cancellation_pending";
              current.updatedAt = nowIso(this.clock);
              return current;
            });
            if (linked.cancellationRequestedAt) await this.buyer.cancelCampaign(createdCampaign.id);
          },
        });
        const current = this.getDelegation(delegationId);
        const reconciled = current.cancellationRequestedAt
          ? await this.buyer.cancelCampaign(campaign.id)
          : campaign;
        return await this.#recordCampaign(delegationId, reconciled, "campaign.created");
      } catch (error) {
        return await this.store.transaction((state) => {
          const current = state.delegations[delegationId];
          current.state = current.cancellationRequestedAt ? "cancellation_pending" : "campaign_creation_failed";
          current.lastError = errorView(error, this.clock);
          current.updatedAt = nowIso(this.clock);
          audit(state, this.clock, "campaign.creation_failed", delegationId, { code: current.lastError.code });
          return current;
        });
      }
    })().finally(() => this.tasks.delete(taskKey));
    this.tasks.set(taskKey, task);
    return await task;
  }

  async #recordCampaign(delegationId, campaign, eventType) {
    return await this.store.transaction((state) => {
      const current = state.delegations[delegationId];
      if (current.campaignId !== null && current.campaignId !== campaign.id) {
        throw new AppError("campaign_link_conflict", "Delegation is linked to another campaign", 409);
      }
      current.campaignId ??= campaign.id;
      current.campaign = campaign;
      current.state = current.cancellationRequestedAt && !CANCELLATION_STATES.has(campaign.state)
        ? "cancellation_pending"
        : delegationState(campaign, current.mandate.authorizationMode);
      if (current.state === "cancelled") current.cancelledAt ??= nowIso(this.clock);
      current.lastError = null;
      current.updatedAt = nowIso(this.clock);
      audit(state, this.clock, eventType, delegationId, {
        campaignId: campaign.id,
        campaignState: campaign.state,
      });
      return current;
    });
  }
}
