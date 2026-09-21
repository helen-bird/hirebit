import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { INTAKE_INITIAL_STATE, IntakeService, questionsFor } from "../src/buyer/intake-service.mjs";
import { JsonStore } from "../src/json-store.mjs";

function extraction(overrides = {}) {
  return {
    objective: "conversion",
    objectiveFamily: "conversion",
    objectiveConfidence: 0.95,
    budgetSats: 2500,
    budgetType: "hard_limit",
    deadlineMinutes: 120,
    deadlineType: "preferred",
    decisionPriorities: { objective: 0.5, quality: 0.2, cost: 0.1, speed: 0.2 },
    authorizationMode: "confirm_before_purchase",
    autoAuthorizationExplicit: false,
    subject: "Acme launch",
    brief: {
      productName: "Acme",
      description: "Launch video",
      referenceUrl: null,
      evidenceUrl: "https://example.com/proof",
      items: [],
      languages: ["en"],
      aspectRatios: ["9:16"],
      hookVariants: 1,
      visualMode: "product_only",
      voiceRequirements: [{ role: "narrator", style: "warm", pace: "fast", accent: null }],
    },
    assumptions: [],
    ambiguities: [],
    clarificationQuestions: [],
    evidence: [],
    ...overrides,
  };
}

class FakeExtractor {
  constructor(values) { this.values = [...values]; this.calls = []; }
  async readiness() { return { configured: true, provider: "fake" }; }
  async extract(input) {
    this.calls.push(input);
    if (this.values.length === 0) throw new Error("No extraction queued");
    const value = this.values.shift();
    if (value instanceof Error) throw value;
    return structuredClone(value);
  }
}

class FakeBuyer {
  constructor() { this.created = []; this.executed = 0; this.executionOptions = []; this.resumed = 0; }
  async createCampaign({ input, idempotencyKey }) {
    this.created.push({ input, idempotencyKey });
    return {
      id: "campaign-1",
      state: input.autoExecute ? "payment_preparation_failed" : "decision_ready",
      input,
    };
  }
  async executeCampaign(id, options) {
    this.executed += 1;
    this.executionOptions.push(options);
    return { id, state: "completed", result: { artifacts: [{ name: "final.mp4" }] } };
  }
  async syncCampaign(id) { return { id, state: "decision_ready" }; }
  async resumeCampaign(id) {
    this.resumed += 1;
    return { id, state: "completed", result: { artifacts: [{ name: "final.mp4" }] } };
  }
}

async function fixture(values, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "intake-service-test-"));
  const store = new JsonStore(join(directory, "state.json"), { initialState: INTAKE_INITIAL_STATE });
  await store.initialize();
  const extractor = new FakeExtractor(values);
  const buyer = new FakeBuyer();
  const service = new IntakeService({
    store,
    extractor,
    buyer,
    policy: { maxCampaignSats: 3000 },
    clock: () => 1_800_000_000_000,
    ...options,
  });
  return { service, extractor, buyer };
}

test("natural-language delegation asks only for missing hard constraints", async () => {
  const missing = extraction({
    objective: null,
    objectiveConfidence: 0.2,
    budgetSats: null,
    budgetType: null,
    authorizationMode: "unspecified",
    subject: null,
    brief: { ...extraction().brief, productName: null, description: null },
  });
  const { service } = await fixture([missing]);
  const delegation = await service.createDelegation({
    input: { request: "帮我做一个宣传视频，但其他信息我还没有确定。" },
    idempotencyKey: "delegation-intake-001",
  });
  assert.equal(delegation.state, "clarification_required");
  assert.deepEqual(delegation.questions.map((item) => item.id), [
    "objective", "subject", "budget_hard_limit", "authorization",
  ]);
  assert.match(delegation.questions[0].question, /业务目标/u);
});

test("failed mandate interpretation can retry the same durable delegation", async () => {
  const transient = new Error("provider output truncated");
  transient.code = "deepseek_incomplete";
  const { service, extractor } = await fixture([transient, extraction()]);
  let delegation = await service.createDelegation({
    input: { request: "Create an Acme conversion video with a hard cap of 2500 sats and ask before purchase." },
    idempotencyKey: "delegation-interpretation-retry",
  });
  assert.equal(delegation.state, "interpretation_failed");
  delegation = await service.retryInterpretation(delegation.id);
  assert.equal(delegation.state, "approval_required");
  assert.equal(delegation.lastError, null);
  assert.equal(extractor.calls.length, 2);
  await assert.rejects(
    service.retryInterpretation(delegation.id),
    (error) => error.code === "interpretation_retry_not_expected",
  );
});

test("clarification, mandate confirmation, and purchase confirmation are separate gates", async () => {
  const first = extraction({ authorizationMode: "unspecified" });
  const second = extraction({ authorizationMode: "confirm_before_purchase" });
  const { service, buyer, extractor } = await fixture([first, second]);
  let delegation = await service.createDelegation({
    input: { request: "Create a conversion video for Acme with a hard cap of 2500 sats." },
    idempotencyKey: "delegation-intake-002",
  });
  assert.equal(delegation.state, "clarification_required");
  assert.deepEqual(delegation.questions.map((item) => item.id), ["authorization"]);

  delegation = await service.answerQuestions(delegation.id, {
    answers: { authorization: "Ask me before purchasing" },
  });
  assert.equal(extractor.calls[1].answers[0].answer, "Ask me before purchasing");
  assert.match(extractor.calls[1].answers[0].question, /Should the Buyer/u);
  assert.equal(delegation.state, "approval_required");
  assert.equal(delegation.mandate.version, 2);

  await assert.rejects(
    service.confirmMandate(delegation.id, {
      approved: true,
      mandateVersion: 1,
      scopeHash: delegation.mandate.scopeHash,
    }),
    (error) => error.code === "stale_mandate",
  );
  delegation = await service.confirmMandate(delegation.id, {
    approved: true,
    mandateVersion: delegation.mandate.version,
    scopeHash: delegation.mandate.scopeHash,
  });
  assert.equal(delegation.state, "awaiting_purchase_confirmation");
  assert.equal(buyer.created[0].input.autoExecute, false);
  assert.equal(buyer.created[0].input.authorizationMode, "confirm_before_purchase");
  assert.equal(buyer.created[0].input.brief.visualMode, "product_only");
  assert.deepEqual(buyer.created[0].input.brief.voiceRequirements, [
    { role: "narrator", style: "warm", pace: "fast", accent: null },
  ]);
  assert.equal(buyer.executed, 0);

  delegation = await service.confirmPurchase(delegation.id);
  assert.equal(delegation.state, "completed");
  assert.equal(buyer.executed, 1);
  assert.deepEqual(buyer.executionOptions[0], {
    purchaseAuthorization: {
      type: "delegation_purchase_confirmation",
      delegationId: delegation.id,
    },
  });
});

test("explicit automatic authorization becomes one upfront mandate approval", async () => {
  const automatic = extraction({
    authorizationMode: "auto_within_budget",
    autoAuthorizationExplicit: true,
  });
  const { service, buyer } = await fixture([automatic]);
  let delegation = await service.createDelegation({
    input: { request: "Automatically order the best Acme conversion video, never exceed 2500 sats." },
    idempotencyKey: "delegation-intake-003",
  });
  assert.equal(delegation.state, "approval_required");
  delegation = await service.confirmMandate(delegation.id, {
    approved: true,
    mandateVersion: delegation.mandate.version,
    scopeHash: delegation.mandate.scopeHash,
  });
  assert.equal(delegation.state, "execution_paused");
  assert.equal(buyer.created[0].input.autoExecute, true);
  assert.equal(buyer.created[0].input.budgetSats, 2500);
});

test("paused autonomous execution can resume without another purchase confirmation", async () => {
  const automatic = extraction({
    authorizationMode: "auto_within_budget",
    autoAuthorizationExplicit: true,
  });
  const { service, buyer } = await fixture([automatic]);
  let delegation = await service.createDelegation({
    input: { request: "Automatically order the best Acme conversion video, never exceed 2500 sats." },
    idempotencyKey: "delegation-autonomous-resume",
  });
  delegation = await service.confirmMandate(delegation.id, {
    approved: true,
    mandateVersion: delegation.mandate.version,
    scopeHash: delegation.mandate.scopeHash,
  });
  assert.equal(delegation.state, "execution_paused");
  delegation = await service.resumeDelegation(delegation.id);
  assert.equal(delegation.state, "completed");
  assert.equal(buyer.resumed, 1);
  assert.equal(buyer.executed, 0);
});

test("chosen purchase authority suppresses duplicate model authorization questions", () => {
  const value = extraction({
    authorizationMode: "auto_within_budget",
    autoAuthorizationExplicit: true,
    clarificationQuestions: [{
      field: "autoAuthorizationExplicit",
      question: "May the Buyer order automatically?",
      reason: "Authorization is required.",
      importance: "optional",
      impact: 0.9,
    }],
  });
  assert.deepEqual(questionsFor(value, {
    request: "Automatically create the video within a hard cap of 2500 sats.",
    maxCampaignSats: 3000,
  }), []);
});

test("chosen autonomous path never asks for a second automatic-payment confirmation", () => {
  const value = extraction({
    authorizationMode: "auto_within_budget",
    autoAuthorizationExplicit: false,
  });
  assert.deepEqual(questionsFor(value, {
    request: "Create an Acme video within a hard cap of 2500 sats.",
    maxCampaignSats: 3000,
  }), []);
});

test("explicit UI purchase mode is authoritative and separate from brief clarification", async () => {
  const { service } = await fixture([extraction({
    authorizationMode: "unspecified",
    autoAuthorizationExplicit: false,
    budgetSats: null,
    budgetType: null,
  })]);
  const delegation = await service.createDelegation({
    input: {
      request: "Create a launch video for our new product.",
      context: { purchaseMode: "auto_within_budget" },
    },
    idempotencyKey: "delegation-ui-purchase-mode",
  });
  assert.equal(delegation.mandate.authorizationMode, "auto_within_budget");
  assert.equal(delegation.extraction.autoAuthorizationExplicit, true);
  assert.equal(delegation.state, "clarification_required");
  assert.deepEqual(delegation.questions.map((item) => item.id), ["budget_hard_limit"]);
});

test("uploaded image capability is scope-bound and materialized only for production", async () => {
  const referenceUploadId = `${"a".repeat(48)}.png`;
  const automatic = extraction({ authorizationMode: "auto_within_budget", autoAuthorizationExplicit: true });
  const { service, buyer, extractor } = await fixture([automatic], {
    referenceUploadBaseUrl: "https://buyer.example",
  });
  let delegation = await service.createDelegation({
    input: {
      request: "Create an Acme conversion video with a hard cap of 2500 sats.",
      context: { purchaseMode: "auto_within_budget", referenceUploadId },
    },
    idempotencyKey: "delegation-uploaded-reference",
  });
  assert.equal(extractor.calls[0].context.referenceUploadId, undefined);
  assert.equal(extractor.calls[0].context.hasProductImage, true);
  assert.equal(delegation.mandate.referenceUploadId, referenceUploadId);
  delegation = await service.confirmMandate(delegation.id, {
    approved: true,
    mandateVersion: delegation.mandate.version,
    scopeHash: delegation.mandate.scopeHash,
  });
  assert.equal(buyer.created[0].input.brief.referenceUrl, `https://buyer.example/v1/uploads/${referenceUploadId}`);
});

test("reference video URL is normalized, scope-bound, and supplied as production evidence", async () => {
  const automatic = extraction({
    authorizationMode: "auto_within_budget",
    autoAuthorizationExplicit: true,
    brief: {
      ...extraction().brief,
      referenceUrl: "https://www.instagram.com/reel/DFa1b2C3d4E/",
      evidenceUrl: "https://model-invented.example/evidence",
    },
  });
  const { service, buyer } = await fixture([automatic], { allowExternalUrls: false });
  let delegation = await service.createDelegation({
    input: {
      request: "Create an Acme conversion video with a hard cap of 2500 sats.",
      context: {
        platform: "Instagram Reels",
        purchaseMode: "auto_within_budget",
        referenceVideoUrl: "https://www.instagram.com/reel/DFa1b2C3d4E/#preview",
      },
    },
    idempotencyKey: "delegation-reference-video",
  });
  assert.equal(delegation.mandate.referenceVideoUrl, "https://www.instagram.com/reel/DFa1b2C3d4E/");
  assert.equal(delegation.mandate.brief.referenceUrl, null);
  assert.equal(delegation.mandate.brief.evidenceUrl, "https://www.instagram.com/reel/DFa1b2C3d4E/");
  delegation = await service.confirmMandate(delegation.id, {
    approved: true,
    mandateVersion: delegation.mandate.version,
    scopeHash: delegation.mandate.scopeHash,
  });
  assert.equal(buyer.created[0].input.brief.evidenceUrl, "https://www.instagram.com/reel/DFa1b2C3d4E/");
});

test("budget above Buyer policy requires explicit reduction before approval", async () => {
  const { service } = await fixture([extraction({ budgetSats: 5000 })]);
  const delegation = await service.createDelegation({
    input: { request: "Make an Acme conversion video, hard limit 5000 sats, ask before purchase." },
    idempotencyKey: "delegation-intake-004",
  });
  assert.equal(delegation.state, "clarification_required");
  assert.deepEqual(delegation.questions.map((item) => item.id), ["policy_budget"]);
});

test("model may ask a bounded context question that materially changes package choice", async () => {
  const { service } = await fixture([extraction({
    clarificationQuestions: [{
      field: "audience",
      question: "Who is the primary audience for this video?",
      reason: "Audience changes whether proof, ranking, or creator delivery is strongest.",
      importance: "required",
      impact: 0.9,
    }],
  })]);
  const delegation = await service.createDelegation({
    input: { request: "Create an Acme conversion video, hard cap 2500 sats, ask before purchase." },
    idempotencyKey: "delegation-intake-context-question",
  });
  assert.equal(delegation.state, "clarification_required");
  assert.equal(delegation.questions[0].id, "context_audience");
  assert.match(delegation.questions[0].reason, /model_material_choice/u);
});

test("clarification policy allows five ranked model questions per round", () => {
  const value = extraction({
    clarificationQuestions: Array.from({ length: 8 }, (_, index) => ({
      field: `field_${index + 1}`,
      question: `Question ${index + 1}?`,
      reason: `Reason ${index + 1}`,
      importance: index < 3 ? "required" : "optional",
      impact: 1 - (index * 0.1),
    })),
  });
  const questions = questionsFor(value, {
    request: "Create an Acme conversion video, hard cap 2500 sats, ask before purchase.",
    maxCampaignSats: 3000,
  });
  assert.equal(questions.length, 5);
  assert.deepEqual(questions.slice(0, 3).map((item) => item.required), [true, true, true]);
  const afterOptionalLimit = questionsFor(value, {
    request: "Create an Acme conversion video, hard cap 2500 sats, ask before purchase.",
    maxCampaignSats: 3000,
    clarificationRounds: 3,
  });
  assert.equal(afterOptionalLimit.length, 3);
  assert.ok(afterOptionalLimit.every((item) => item.required));
});

test("optional model questions do not block exact mandate approval", async () => {
  const optional = {
    field: "tone",
    question: "Do you prefer authoritative or playful delivery?",
    reason: "Tone can improve creative fit but has a safe default.",
    importance: "optional",
    impact: 0.6,
  };
  const { service } = await fixture([extraction({
    clarificationQuestions: [optional],
    assumptions: ["Use an authoritative tone unless the customer specifies otherwise."],
  })]);
  let delegation = await service.createDelegation({
    input: { request: "Create an Acme conversion video, hard cap 2500 sats, ask before purchase." },
    idempotencyKey: "delegation-intake-optional-question",
  });
  assert.equal(delegation.state, "approval_required");
  assert.equal(delegation.questions[0].required, false);
  delegation = await service.confirmMandate(delegation.id, {
    approved: true,
    mandateVersion: delegation.mandate.version,
    scopeHash: delegation.mandate.scopeHash,
  });
  assert.equal(delegation.state, "awaiting_purchase_confirmation");
});
