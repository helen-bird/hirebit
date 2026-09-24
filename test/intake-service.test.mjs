import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  constructor() { this.created = []; this.executed = 0; this.executionOptions = []; this.resumed = 0; this.cancelled = []; }
  async createCampaign({ input, idempotencyKey, onCreated }) {
    this.created.push({ input, idempotencyKey });
    await onCreated?.({ id: "campaign-1", state: "analyzing", input });
    return {
      id: "campaign-1",
      state: input.autoExecute ? "payment_preparation_failed" : "decision_ready",
      purchaseSelectionDigest: "a".repeat(64),
      input,
    };
  }
  async executeCampaign(id, options) {
    this.executed += 1;
    this.executionOptions.push(options);
    return { id, state: "completed", result: { artifacts: [{ name: "final.mp4" }] } };
  }
  async syncCampaign(id) { return { id, state: "decision_ready" }; }
  async cancelCampaign(id) {
    this.cancelled.push(id);
    return { id, state: "cancelled" };
  }
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
  return { service, extractor, buyer, store };
}

test("public Demo reserves rolling-hour intake slots atomically, even when a task is declined", async () => {
  const { service, extractor, store } = await fixture([extraction(), extraction()]);
  const create = (key) => service.createDelegation({
    input: { request: "Create a launch campaign for Acme under 2500 sats." },
    idempotencyKey: key,
    maxHourlyDelegations: 1,
  });
  const results = await Promise.allSettled([create("quota-concurrent-one"), create("quota-concurrent-two")]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected" && result.reason.code === "public_demo_quota_exhausted").length, 1);
  assert.equal(extractor.calls.length, 1);
  const accepted = results.find((result) => result.status === "fulfilled").value;
  await store.transaction((state) => { state.delegations[accepted.id].state = "declined"; });
  await assert.rejects(create("quota-concurrent-three"), (error) => error.code === "public_demo_quota_exhausted");
  const reused = await service.createDelegation({
    input: { request: "Create a launch campaign for Acme under 2500 sats." },
    idempotencyKey: results[0].status === "fulfilled" ? "quota-concurrent-one" : "quota-concurrent-two",
    maxHourlyDelegations: 1,
  });
  assert.equal(reused.id, accepted.id);
  assert.equal(extractor.calls.length, 1);
});

test("delivered campaign dispute requires evidence and closes after 72 hours", async () => {
  let now = 1_800_000_000_000;
  const { service, store } = await fixture([extraction()], { clock: () => now });
  const delegation = await service.createDelegation({
    input: { request: "Create a launch campaign for Acme under 2500 sats." },
    idempotencyKey: "delegation-delivery-dispute",
  });
  await store.transaction((state) => {
    const current = state.delegations[delegation.id];
    current.state = "completed";
    current.campaign = {
      state: "completed", completedAt: new Date(now).toISOString(),
      sellerOrder: { amountSats: 1661 },
      package: { generatedAt: new Date(now).toISOString(), files: [
        { path: "manifest.json", sha256: "a".repeat(64), bytes: 400 },
        { path: "creatives/final.mp4", sha256: "b".repeat(64), bytes: 2000,
          validation: { durationSeconds: 20 } },
      ] },
    };
  });
  await assert.rejects(service.requestResolution(delegation.id, { reason: "The video is incorrect" }),
    (error) => error.code === "dispute_evidence_required");
  await assert.rejects(service.requestResolution(delegation.id, {
    reason: "The product shown in the video is wrong",
    evidence: {
      artifactPath: "creatives/final.mp4", timecodeSeconds: 21,
      expected: "Our supplied cotton swab product", observed: "A different product appears",
    },
  }), (error) => error.code === "invalid_dispute_timecode");
  await store.transaction((state) => {
    delete state.delegations[delegation.id].campaign.package.files[1].validation;
  });
  await assert.rejects(service.requestResolution(delegation.id, {
    reason: "The product shown in the video is wrong",
    evidence: {
      artifactPath: "creatives/final.mp4", timecodeSeconds: 2,
      expected: "Our supplied cotton swab product", observed: "A different product appears",
    },
  }), (error) => error.code === "invalid_dispute_timecode");
  await store.transaction((state) => {
    state.delegations[delegation.id].campaign.package.files[1].validation = { durationSeconds: 20 };
  });
  const reviewed = await service.requestResolution(delegation.id, {
    reason: "The product shown at 2 seconds is wrong",
    evidence: {
      artifactPath: "creatives/final.mp4", timecodeSeconds: 2,
      expected: "Our supplied cotton swab product", observed: "A different product appears",
    },
  });
  assert.equal(reviewed.resolution.type, "delivery_quality");
  assert.equal(reviewed.resolution.freeReworksAvailable, 0);
  assert.equal(reviewed.resolution.maxQualityRefundSats, 332);
  assert.equal(reviewed.resolution.refund.state, "not_issued");
  assert.equal(reviewed.resolution.refund.amountSats, null);
  assert.equal(reviewed.resolution.evidence.artifactSha256, "b".repeat(64));
  assert.equal(reviewed.resolution.deliverySnapshot.manifestSha256, "a".repeat(64));
  await store.transaction((state) => {
    const files = state.delegations[delegation.id].campaign.package.files;
    files[0].sha256 = "c".repeat(64);
    files[1].sha256 = "d".repeat(64);
  });
  const frozen = service.getDelegation(delegation.id).resolution;
  assert.equal(frozen.evidence.artifactSha256, "b".repeat(64));
  assert.equal(frozen.deliverySnapshot.manifestSha256, "a".repeat(64));
  assert.equal(frozen.deliverySnapshot.files[1].sha256, "b".repeat(64));
  now += 73 * 60 * 60 * 1000;
  const retry = await service.requestResolution(delegation.id, {
    reason: "The product shown at 2 seconds is wrong", evidence: reviewed.resolution.evidence,
  });
  assert.equal(retry.resolution.requestedAt, reviewed.resolution.requestedAt);
  await store.transaction((state) => { state.delegations[delegation.id].resolution = null; });
  await assert.rejects(service.requestResolution(delegation.id, {
    reason: "Another issue", evidence: reviewed.resolution.evidence,
  }), (error) => error.code === "dispute_window_closed");
});

test("a delivery issue binds to the revised creative and revised manifest", async () => {
  const now = 1_800_000_000_000;
  const { service, store } = await fixture([extraction()], { clock: () => now });
  const delegation = await service.createDelegation({
    input: { request: "Create a launch campaign for Acme under 2500 sats." },
    idempotencyKey: "revised-delivery-dispute",
  });
  const generatedAt = new Date(now).toISOString();
  const creative = {
    path: "revisions/r2/creatives/final.mp4", sha256: "b".repeat(64), bytes: 2000,
    mediaType: "video/mp4", validation: { durationSeconds: 12 },
  };
  const manifestData = `${JSON.stringify({
    version: 1, campaignId: "campaign-revised", generatedAt, files: [creative],
  }, null, 2)}\n`;
  const manifest = {
    path: "revisions/r2/manifest.json", sha256: createHash("sha256").update(manifestData).digest("hex"),
    bytes: Buffer.byteLength(manifestData),
  };
  await store.transaction((state) => {
    const current = state.delegations[delegation.id];
    current.state = "completed";
    current.campaignId = "campaign-revised";
    current.campaign = {
      id: "campaign-revised", state: "completed", completedAt: generatedAt,
      sellerOrder: { amountSats: 1160 },
      package: { state: "completed", revision: "r2", generatedAt, files: [manifest, creative] },
    };
  });
  const result = await service.requestResolution(delegation.id, {
    reason: "The delivered revision has a caption issue",
    evidence: {
      artifactPath: creative.path, timecodeSeconds: 2,
      expected: "Product name is readable", observed: "Product name appears blurred",
    },
  });
  assert.equal(result.resolution.deliverySnapshot.manifestMatches, true);
  assert.equal(result.resolution.evidence.artifactSha256, creative.sha256);
  assert.equal(result.resolution.evidence.packageManifestSha256, manifest.sha256);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("cancellation stays pending until an in-flight campaign is linked, then stops it", async () => {
  const automatic = extraction({ authorizationMode: "auto_within_budget", autoAuthorizationExplicit: true });
  const { service, buyer } = await fixture([automatic]);
  const entered = deferred();
  const release = deferred();
  buyer.createCampaign = async ({ input, onCreated }) => {
    entered.resolve();
    await release.promise;
    await onCreated({ id: "campaign-late", state: "analyzing", input });
    return { id: "campaign-late", state: "decision_ready", input };
  };
  const delegation = await service.createDelegation({
    input: { request: "Automatically order the best Acme conversion video under 2500 sats." },
    idempotencyKey: "delegation-cancel-during-create",
  });
  const confirmation = service.confirmMandate(delegation.id, {
    approved: true, mandateVersion: delegation.mandate.version, scopeHash: delegation.mandate.scopeHash,
  });
  await entered.promise;
  const pending = await service.cancelDelegation(delegation.id);
  assert.equal(pending.state, "cancellation_pending");
  assert.equal(pending.campaignId, null);
  release.resolve();
  const cancelled = await confirmation;
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.campaignId, "campaign-late");
  assert.deepEqual(buyer.cancelled, ["campaign-late", "campaign-late"]);
});

test("cancellation after early campaign linkage interrupts pending auto execution", async () => {
  const automatic = extraction({ authorizationMode: "auto_within_budget", autoAuthorizationExplicit: true });
  const { service, buyer } = await fixture([automatic]);
  const linked = deferred();
  const release = deferred();
  buyer.createCampaign = async ({ input, onCreated }) => {
    await onCreated({ id: "campaign-early", state: "analyzing", input });
    linked.resolve();
    await release.promise;
    return { id: "campaign-early", state: "decision_ready", input };
  };
  const delegation = await service.createDelegation({
    input: { request: "Automatically order the best Acme conversion video under 2500 sats." },
    idempotencyKey: "delegation-cancel-after-link",
  });
  const confirmation = service.confirmMandate(delegation.id, {
    approved: true, mandateVersion: delegation.mandate.version, scopeHash: delegation.mandate.scopeHash,
  });
  await linked.promise;
  const cancelled = await service.cancelDelegation(delegation.id);
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.campaignId, "campaign-early");
  release.resolve();
  const after = await confirmation;
  assert.equal(after.state, "cancelled");
  assert.ok(buyer.cancelled.length >= 1);
});

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

test("interpretation calls reserve a durable ten-attempt rolling-hour allowance before provider use", async () => {
  let now = 1_800_000_000_000;
  const failures = Array.from({ length: 10 }, () => new Error("provider failed"));
  const { service, extractor, store } = await fixture([...failures, extraction()], { clock: () => now });
  let delegation = await service.createDelegation({
    input: { request: "Create an Acme conversion video with a hard cap of 2500 sats and ask before purchase." },
    idempotencyKey: "delegation-model-attempt-limit",
  });
  for (let attempt = 1; attempt < 10; attempt += 1) {
    assert.equal(delegation.state, "interpretation_failed");
    delegation = await service.retryInterpretation(delegation.id);
  }
  assert.equal(extractor.calls.length, 10);
  assert.equal(store.snapshot().delegations[delegation.id].interpretationAttempts.length, 10);
  await assert.rejects(service.retryInterpretation(delegation.id), (error) => {
    assert.equal(error.code, "model_attempt_limit");
    assert.equal(error.status, 429);
    assert.equal(error.details.retryAt, new Date(now + 60 * 60 * 1000).toISOString());
    return true;
  });
  assert.equal(extractor.calls.length, 10);
  assert.equal(service.getDelegation(delegation.id).state, "interpretation_failed");
  assert.equal(service.getDelegation(delegation.id).lastError.retryAt, new Date(now + 60 * 60 * 1000).toISOString());
  now += 60 * 60 * 1000 + 1;
  delegation = await service.retryInterpretation(delegation.id);
  assert.equal(delegation.state, "approval_required");
  assert.equal(extractor.calls.length, 11);
  assert.equal(store.snapshot().delegations[delegation.id].interpretationAttempts.length, 1);
});

test("recovery counts a prior uncertain model attempt and pauses before an eleventh call", async () => {
  const now = 1_800_000_000_000;
  const { service, store } = await fixture([extraction()], { clock: () => now });
  const delegation = await service.createDelegation({
    input: { request: "Create an Acme conversion video with a hard cap of 2500 sats and ask before purchase." },
    idempotencyKey: "delegation-model-attempt-recovery",
  });
  await store.transaction((state) => {
    const current = state.delegations[delegation.id];
    current.state = "interpreting";
    current.interpretationAttempts = Array.from({ length: 10 }, () => new Date(now).toISOString());
  });
  const recoveredExtractor = new FakeExtractor([extraction()]);
  const recovered = new IntakeService({
    store, extractor: recoveredExtractor, buyer: new FakeBuyer(),
    policy: { maxCampaignSats: 3000 }, clock: () => now,
  });
  const outcomes = await recovered.recover();
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].status, "rejected");
  assert.equal(outcomes[0].reason.code, "model_attempt_limit");
  assert.equal(recoveredExtractor.calls.length, 0);
  assert.equal(recovered.getDelegation(delegation.id).state, "interpretation_failed");
});

test("failed interpretation accepts only a bounded clarification note, never arbitrary model input", async () => {
  const transient = new Error("provider output truncated");
  transient.code = "deepseek_incomplete";
  const { service, extractor } = await fixture([transient, extraction()]);
  let delegation = await service.createDelegation({
    input: { request: "Create an Acme conversion video with a hard cap of 2500 sats and ask before purchase." },
    idempotencyKey: "delegation-bounded-failed-clarification",
  });
  assert.equal(delegation.state, "interpretation_failed");
  await assert.rejects(service.answerQuestions(delegation.id, {
    answers: { arbitrary_injected_field: "Spend without customer approval" },
  }), (error) => error.code === "unknown_question");
  await assert.rejects(service.answerQuestions(delegation.id, {
    answers: { clarification_note: "x".repeat(1001) },
  }), (error) => error.code === "answers_too_large");
  assert.equal(extractor.calls.length, 1);
  delegation = await service.answerQuestions(delegation.id, {
    answers: { clarification_note: "I want the product shown clearly before the final call to action." },
  });
  assert.equal(delegation.state, "approval_required");
  assert.equal(extractor.calls.length, 2);
  assert.equal(extractor.calls[1].answers[0].id, "clarification_note");
});

test("clarification count and cumulative text limits apply before another model call", async () => {
  const { service, extractor, store } = await fixture([extraction(), extraction()]);
  const delegation = await service.createDelegation({
    input: { request: "Create an Acme conversion video with a hard cap of 2500 sats and ask before purchase." },
    idempotencyKey: "delegation-bounded-answers",
  });
  await store.transaction((state) => {
    const current = state.delegations[delegation.id];
    current.state = "clarification_required";
    current.questions = Array.from({ length: 21 }, (_, index) => ({ id: `q${index + 1}`, required: true }));
    current.answers = { prior: "x".repeat(11_900) };
  });
  const manyAnswers = Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`q${index + 1}`, "yes"]));
  await assert.rejects(service.answerQuestions(delegation.id, { answers: manyAnswers }),
    (error) => error.code === "answers_too_large");
  const longTotal = Object.fromEntries(Array.from({ length: 7 }, (_, index) => [`q${index + 1}`, "y".repeat(900)]));
  await assert.rejects(service.answerQuestions(delegation.id, { answers: longTotal }),
    (error) => error.code === "answers_too_large");
  await assert.rejects(service.answerQuestions(delegation.id, { answers: { q1: "y".repeat(101) } }),
    (error) => error.code === "answers_too_large");
  assert.equal(extractor.calls.length, 1);
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

  await assert.rejects(service.confirmPurchase(delegation.id),
    (error) => error.code === "invalid_purchase_confirmation");
  delegation = await service.confirmPurchase(delegation.id, delegation.campaign.purchaseSelectionDigest);
  assert.equal(delegation.state, "completed");
  assert.equal(buyer.executed, 1);
  assert.deepEqual(buyer.executionOptions[0], {
    purchaseAuthorization: {
      type: "delegation_purchase_confirmation",
      delegationId: delegation.id,
      selectionDigest: "a".repeat(64),
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

test("payment-origin review is shown as a paused delegation state", async () => {
  const automatic = extraction({ authorizationMode: "auto_within_budget", autoAuthorizationExplicit: true });
  const { service, buyer } = await fixture([automatic]);
  buyer.createCampaign = async ({ input, onCreated }) => {
    await onCreated?.({ id: "campaign-origin-review", state: "analyzing", input });
    return { id: "campaign-origin-review", state: "payment_origin_review_required", input };
  };
  let delegation = await service.createDelegation({
    input: { request: "Automatically order an Acme conversion video under 2500 sats." },
    idempotencyKey: "delegation-origin-review",
  });
  delegation = await service.confirmMandate(delegation.id, {
    approved: true, mandateVersion: delegation.mandate.version, scopeHash: delegation.mandate.scopeHash,
  });
  assert.equal(delegation.state, "payment_origin_review_required");
});

test("flexible hook scope preserves launch-testing intent for the purchase decision", async () => {
  const automatic = extraction({
    authorizationMode: "auto_within_budget",
    autoAuthorizationExplicit: true,
    brief: { ...extraction().brief, hookVariants: null },
    assumptions: ["Three opening hook variants are proposed as the default for launch testing."],
  });
  const { service, buyer } = await fixture([automatic]);
  const request = "Choose the right number of opening hooks for launch testing and stay under 2500 sats.";
  let delegation = await service.createDelegation({
    input: { request, context: { purchaseMode: "auto_within_budget" } },
    idempotencyKey: "delegation-flexible-launch-testing",
  });
  assert.equal(delegation.mandate.scopeFlexibility.hookVariants, true);
  assert.equal(delegation.mandate.brief.hookVariants, null);

  delegation = await service.confirmMandate(delegation.id, {
    approved: true,
    mandateVersion: delegation.mandate.version,
    scopeHash: delegation.mandate.scopeHash,
  });
  assert.equal(delegation.state, "execution_paused");
  assert.equal(Object.hasOwn(buyer.created[0].input.addOns, "hookVariants"), false);
  assert.equal(buyer.created[0].input.decisionContext.customerRequest, request);
  assert.deepEqual(buyer.created[0].input.decisionContext.assumptions, automatic.assumptions);
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

test("confirm-purchase intake asks for each missing purchase-critical detail, including delivery timing", () => {
  const cases = [
    { name: "objective", overrides: { objective: null, objectiveConfidence: 0.1 }, expected: ["objective"] },
    {
      name: "product",
      overrides: { subject: null, brief: { ...extraction().brief, productName: null, description: null } },
      expected: ["subject"],
    },
    { name: "budget", overrides: { budgetSats: null, budgetType: null }, expected: ["budget_hard_limit"] },
    { name: "soft budget", overrides: { budgetType: "preferred" }, expected: ["budget_hard_limit"] },
    { name: "deadline", overrides: { deadlineMinutes: null, deadlineType: null }, expected: ["deadline"] },
    { name: "explicit no deadline", overrides: { deadlineMinutes: null, deadlineType: "none" }, expected: [] },
  ];
  for (const { name, overrides, expected } of cases) {
    const value = extraction({ authorizationMode: "confirm_before_purchase", ...overrides });
    assert.deepEqual(questionsFor(value, {
      request: `Create a product campaign (${name}); ask me before purchase.`,
      maxCampaignSats: 3000,
    }).map((item) => item.id), expected, name);
  }
});

test("an omitted deadline blocks approval until the customer explicitly declines a time requirement", async () => {
  const missing = extraction({ deadlineMinutes: null, deadlineType: null });
  const answered = extraction({ deadlineMinutes: null, deadlineType: "none" });
  const { service, buyer, extractor } = await fixture([missing, answered]);
  let delegation = await service.createDelegation({
    input: {
      request: "Create a conversion video for Acme within a hard cap of 2500 sats.",
      context: { purchaseMode: "confirm_before_purchase" },
    },
    idempotencyKey: "deadline-explicit-none",
  });
  assert.equal(delegation.state, "clarification_required");
  assert.deepEqual(delegation.questions.map((item) => item.id), ["deadline"]);
  await assert.rejects(service.confirmMandate(delegation.id, {
    approved: true, mandateVersion: delegation.mandate.version, scopeHash: delegation.mandate.scopeHash,
  }), (error) => error.code === "approval_not_expected");
  delegation = await service.answerQuestions(delegation.id, { answers: { deadline: "I have no delivery-time requirement." } });
  assert.equal(extractor.calls[1].answers[0].answer, "I have no delivery-time requirement.");
  assert.equal(delegation.state, "approval_required");
  assert.equal(delegation.mandate.deadlineType, "none");
  delegation = await service.confirmMandate(delegation.id, {
    approved: true, mandateVersion: delegation.mandate.version, scopeHash: delegation.mandate.scopeHash,
  });
  assert.equal(delegation.state, "awaiting_purchase_confirmation");
  assert.equal(buyer.created.length, 1);
  assert.equal(buyer.created[0].input.deadlineType, undefined);
  assert.equal(buyer.created[0].input.deadlineMinutes, undefined);
});

test("purchase paths resolve varied incomplete briefs before creating a campaign", async () => {
  const gaps = [
    { name: "objective", override: { objective: null, objectiveConfidence: 0.1 }, question: "objective" },
    { name: "product", override: { subject: null, brief: { ...extraction().brief, productName: null, description: null } }, question: "subject" },
    { name: "budget", override: { budgetSats: null, budgetType: null }, question: "budget_hard_limit" },
    { name: "deadline", override: { deadlineMinutes: null, deadlineType: null }, question: "deadline" },
  ];
  for (const mode of ["confirm_before_purchase", "auto_within_budget"]) {
    for (const gap of gaps) {
      const initial = extraction({ ...gap.override, authorizationMode: mode });
      const resolved = extraction({ authorizationMode: mode });
      const { service, buyer } = await fixture([initial, resolved]);
      let delegation = await service.createDelegation({
        input: {
          request: `Create a conversion product video with a hard cap of 2500 sats and delivery within two hours (${gap.name}).`,
          context: { purchaseMode: mode },
        },
        idempotencyKey: `gap-${mode}-${gap.name}`,
      });
      assert.equal(delegation.state, "clarification_required", `${mode}/${gap.name}`);
      assert.deepEqual(delegation.questions.map((item) => item.id), [gap.question], `${mode}/${gap.name}`);
      assert.equal(buyer.created.length, 0, `${mode}/${gap.name}`);
      delegation = await service.answerQuestions(delegation.id, { answers: { [gap.question]: "The missing detail is confirmed." } });
      assert.equal(delegation.state, "approval_required", `${mode}/${gap.name}`);
      delegation = await service.confirmMandate(delegation.id, {
        approved: true, mandateVersion: delegation.mandate.version, scopeHash: delegation.mandate.scopeHash,
      });
      assert.equal(buyer.created.length, 1, `${mode}/${gap.name}`);
      assert.equal(buyer.created[0].input.autoExecute, mode === "auto_within_budget", `${mode}/${gap.name}`);
      assert.equal(delegation.state, mode === "auto_within_budget" ? "execution_paused" : "awaiting_purchase_confirmation", `${mode}/${gap.name}`);
    }
  }
});

test("simultaneously missing product, budget and deadline remain blocking in autonomous mode", async () => {
  const initial = extraction({
    subject: null,
    brief: { ...extraction().brief, productName: null, description: null },
    budgetSats: null,
    budgetType: null,
    deadlineMinutes: null,
    deadlineType: null,
    authorizationMode: "auto_within_budget",
  });
  const { service, buyer } = await fixture([initial, extraction({ authorizationMode: "auto_within_budget" })]);
  let delegation = await service.createDelegation({
    input: {
      request: "Make a launch video. I want the Buyer to choose a plan.",
      context: { purchaseMode: "auto_within_budget" },
    },
    idempotencyKey: "combined-missing-constraints",
  });
  assert.deepEqual(delegation.questions.map((item) => item.id), ["subject", "budget_hard_limit", "deadline"]);
  assert.equal(buyer.created.length, 0);
  delegation = await service.answerQuestions(delegation.id, {
    answers: {
      subject: "Precision Beauty Swabs",
      budget_hard_limit: "Maximum 2500 sats",
      deadline: "Within two hours",
    },
  });
  assert.equal(delegation.state, "approval_required");
  assert.equal(buyer.created.length, 0);
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
  const automatic = extraction({
    authorizationMode: "auto_within_budget",
    autoAuthorizationExplicit: true,
    // A model can mistake a social-video URL for an image reference. The
    // customer's explicit image upload must still win at purchase time.
    brief: { ...extraction().brief, referenceUrl: "https://www.tiktok.com/@creator/video/7461234567890123456" },
  });
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

test("campaign preflight failure is recoverable after the missing image service is configured", async () => {
  const referenceUploadId = `${"f".repeat(48)}.jpg`;
  const automatic = extraction({ authorizationMode: "auto_within_budget", autoAuthorizationExplicit: true });
  const { service, buyer } = await fixture([automatic]);
  let delegation = await service.createDelegation({
    input: {
      request: "Create an Acme conversion video with a hard cap of 2500 sats.",
      context: { purchaseMode: "auto_within_budget", referenceUploadId },
    },
    idempotencyKey: "campaign-preflight-image-service",
  });
  delegation = await service.confirmMandate(delegation.id, {
    approved: true, mandateVersion: delegation.mandate.version, scopeHash: delegation.mandate.scopeHash,
  });
  assert.equal(delegation.state, "campaign_creation_failed");
  assert.equal(delegation.lastError.code, "reference_upload_unavailable");
  assert.equal(buyer.created.length, 0);

  service.referenceUploadBaseUrl = "https://buyer.example";
  delegation = await service.confirmMandate(delegation.id, { approved: true });
  assert.equal(delegation.state, "execution_paused");
  assert.equal(buyer.created.length, 1);
  assert.equal(buyer.created[0].input.brief.referenceUrl,
    `https://buyer.example/v1/uploads/${referenceUploadId}`);
});

test("expired preflight deadline gives an actionable campaign failure without creating an order", async () => {
  let now = 1_800_000_000_000;
  const automatic = extraction({
    authorizationMode: "auto_within_budget", autoAuthorizationExplicit: true,
    deadlineMinutes: 1, deadlineType: "hard",
  });
  const { service, buyer } = await fixture([automatic], { clock: () => now });
  let delegation = await service.createDelegation({
    input: { request: "Create an Acme video within one minute and under 2500 sats." },
    idempotencyKey: "campaign-preflight-deadline",
  });
  now += 61_000;
  delegation = await service.confirmMandate(delegation.id, {
    approved: true, mandateVersion: delegation.mandate.version, scopeHash: delegation.mandate.scopeHash,
  });
  assert.equal(delegation.state, "campaign_creation_failed");
  assert.equal(delegation.lastError.code, "delegation_deadline_expired");
  assert.equal(buyer.created.length, 0);
});

test("TikTok reference video URL is normalized, scope-bound, and supplied as production evidence", async () => {
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
        platform: "TikTok",
        purchaseMode: "auto_within_budget",
        referenceVideoUrl: "https://www.tiktok.com/@creator/video/7461234567890123456#preview",
      },
    },
    idempotencyKey: "delegation-reference-video",
  });
  assert.equal(delegation.mandate.referenceVideoUrl, "https://www.tiktok.com/@creator/video/7461234567890123456");
  assert.equal(delegation.mandate.brief.referenceUrl, null);
  assert.equal(delegation.mandate.brief.evidenceUrl, "https://www.tiktok.com/@creator/video/7461234567890123456");
  delegation = await service.confirmMandate(delegation.id, {
    approved: true,
    mandateVersion: delegation.mandate.version,
    scopeHash: delegation.mandate.scopeHash,
  });
  assert.equal(buyer.created[0].input.brief.evidenceUrl, "https://www.tiktok.com/@creator/video/7461234567890123456");
});

test("TikTok reference reaches the approved campaign while other platforms fail before interpretation", async () => {
  const referenceVideoUrl = "https://www.tiktok.com/@creator/video/7461234567890123456";
  const { service, buyer } = await fixture([extraction({
    authorizationMode: "confirm_before_purchase",
    brief: { ...extraction().brief, evidenceUrl: null },
  })], { allowExternalUrls: false });
  let delegation = await service.createDelegation({
    input: {
      request: "Create an Acme TikTok launch video under a hard cap of 2500 sats.",
      context: { platform: "TikTok", purchaseMode: "confirm_before_purchase", referenceVideoUrl },
    },
    idempotencyKey: "delegation-channel-tiktok",
  });
  assert.equal(delegation.mandate.brief.evidenceUrl, referenceVideoUrl);
  delegation = await service.confirmMandate(delegation.id, {
    approved: true, mandateVersion: delegation.mandate.version, scopeHash: delegation.mandate.scopeHash,
  });
  assert.equal(delegation.state, "awaiting_purchase_confirmation");
  assert.equal(buyer.created[0].input.brief.evidenceUrl, referenceVideoUrl);
  assert.equal(buyer.created[0].input.autoExecute, false);

  for (const [platform, url] of [
    ["Instagram Reels", "https://www.instagram.com/reel/DFa1b2C3d4E/"],
    ["YouTube Shorts", "https://www.youtube.com/shorts/dQw4w9WgXcQ"],
  ]) {
    await assert.rejects(service.createDelegation({
      input: {
        request: `Create an Acme video for ${platform} under a hard cap of 2500 sats.`,
        context: { platform, purchaseMode: "confirm_before_purchase", referenceVideoUrl: url },
      },
      idempotencyKey: `delegation-reject-${platform}`,
    }), (error) => error.code === "unsupported_reference_video_channel");
  }
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
