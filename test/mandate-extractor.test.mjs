import assert from "node:assert/strict";
import test from "node:test";

import { DeepSeekMandateExtractor, validateExtractedMandate } from "../src/buyer/mandate-extractor.mjs";

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
      voiceRequirements: [{ role: "narrator", style: "warm", pace: "normal", accent: null }],
    },
    assumptions: [],
    ambiguities: [],
    clarificationQuestions: [],
    evidence: [{ field: "budgetSats", excerpt: "up to 2500 sats" }],
    ...overrides,
  };
}

function responseFor(value, { split = false, fenced = false } = {}) {
  const serialized = JSON.stringify(value);
  const text = fenced ? `\`\`\`json\n${serialized}\n\`\`\`` : serialized;
  const content = split
    ? [
        { type: "output_text", text: text.slice(0, Math.floor(text.length / 2)) },
        { type: "output_text", text: text.slice(Math.floor(text.length / 2)) },
      ]
    : [{ type: "output_text", text }];
  return new Response(JSON.stringify({
    status: "completed",
    error: null,
    output: [{
      type: "message",
      content,
    }],
    usage: { input_tokens: 100, output_tokens: 80, total_tokens: 180 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

test("DeepSeek extractor uses Responses structured output without exposing the key", async () => {
  const calls = [];
  const extractor = new DeepSeekMandateExtractor({
    schemaFile: new URL("../config/delegation-extraction.schema.json", import.meta.url),
    keyProvider: async () => ({ value: "secret-key", source: "test" }),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return responseFor(extraction());
    },
  });
  const result = await extractor.extract({ request: "Create a conversion video up to 2500 sats", context: {} });
  assert.equal(result.objective, "conversion");
  assert.equal(result.brief.evidenceUrl, "https://example.com/proof");
  assert.equal(result.brief.visualMode, "product_only");
  assert.equal(result.brief.voiceRequirements[0].style, "warm");
  assert.equal(calls[0].url, "https://api.deepseek.com/responses");
  assert.equal(calls[0].options.headers.authorization, "Bearer secret-key");
  const payload = JSON.parse(calls[0].options.body);
  assert.equal(payload.model, "deepseek-flash");
  assert.equal(payload.max_output_tokens, 12_288);
  assert.equal(payload.text.format.type, "json_schema");
  assert.equal(payload.tools, undefined);
  assert.ok(!JSON.stringify(result).includes("secret-key"));
});

test("DeepSeek extractor joins split output text and accepts a JSON fence before schema validation", async () => {
  const extractor = new DeepSeekMandateExtractor({
    schemaFile: new URL("../config/delegation-extraction.schema.json", import.meta.url),
    keyProvider: async () => ({ value: "secret-key", source: "test" }),
    fetchImpl: async () => responseFor(extraction(), { split: true, fenced: true }),
  });
  const result = await extractor.extract({ request: "Create an Acme launch video", context: {} });
  assert.equal(result.subject, "Acme launch");
});

test("clarification retries omit verbose prior questions and evidence", async () => {
  let payload;
  const extractor = new DeepSeekMandateExtractor({
    schemaFile: new URL("../config/delegation-extraction.schema.json", import.meta.url),
    keyProvider: async () => ({ value: "secret-key", source: "test" }),
    fetchImpl: async (_url, options) => {
      payload = JSON.parse(options.body);
      return responseFor(extraction());
    },
  });
  await extractor.extract({
    request: "Create a launch video",
    context: { purchaseMode: "auto_within_budget" },
    answers: [{ id: "budget", answer: "2000" }],
    prior: extraction({
      assumptions: Array.from({ length: 8 }, (_, index) => `assumption ${index}`),
      clarificationQuestions: [{ field: "budget", question: "Budget?", reason: "Missing", importance: "required", impact: 1 }],
      evidence: [{ field: "budget", excerpt: "none" }],
    }),
  });
  assert.match(payload.instructions, /at most five context-specific questions/u);
  assert.match(payload.input, /"clarificationQuestions":\[\]/u);
  const priorText = payload.input.match(/<prior_extraction>(.*)<\/prior_extraction>/u)?.[1];
  const prior = JSON.parse(priorText);
  assert.equal(prior.assumptions.length, 6);
  assert.deepEqual(prior.clarificationQuestions, []);
  assert.deepEqual(prior.evidence, []);
});

test("post-model validation rejects unsafe URLs", () => {
  assert.throws(
    () => validateExtractedMandate(extraction({
      brief: { ...extraction().brief, referenceUrl: "file:///etc/passwd" },
    })),
    (error) => error.code === "invalid_mandate_extraction",
  );
  assert.throws(
    () => validateExtractedMandate(extraction({
      brief: { ...extraction().brief, evidenceUrl: "https://127.0.0.1/admin" },
    })),
    (error) => error.code === "invalid_mandate_extraction",
  );
});
