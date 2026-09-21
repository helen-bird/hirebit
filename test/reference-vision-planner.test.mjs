import assert from "node:assert/strict";
import test from "node:test";

import {
  DeepSeekReferenceVisionProvider,
  selectReferenceSampleTimes,
  validateReferenceVisionPlan,
} from "../src/reference-vision-planner.mjs";

function validPlan() {
  return {
    product: {
      category: "double-ended cotton swabs",
      observedFeatures: ["clear round container", "white double-ended tips"],
      visibleUses: ["small-area makeup detailing"],
      uncertainty: "Packaging text and material specifications are not visible.",
    },
    reference: {
      visualGrammar: "Close detail opening, steady process phase, then a faster reveal and clean close.",
      subjectFraming: "Vertical macro framing on a newly generated adult creator's eye and hand.",
      actionSequence: [
        "A hand brings one cotton swab into frame beside the eye.",
        "The creator makes one precise makeup touch-up and moves the swab away.",
        "The hand rotates the swab to reveal both cotton tips before the product close.",
      ],
      pacing: "moderate",
      transitionMoment: 0.58,
      typography: "Short centered statements with a high-contrast color card.",
    },
    adaptation: {
      strategy: "Use macro crops of the supplied product photo and mirror the reference's process-to-reveal rhythm.",
      palette: ["#f1e7df", "#9d2878", "#fff4cb"],
      narration: "Reach for a clean detail tool to blend, refine, and tidy small areas with control.",
      shots: Array.from({ length: 6 }, (_, index) => ({
        durationWeight: index === 0 ? 0.7 : 1,
        focusX: 0.5,
        focusY: 0.45 + (index * 0.03),
        cropScale: index % 2 === 0 ? 1.4 : 1.1,
        motion: ["punch", "drift_left", "drift_right", "slow_zoom", "reveal", "reveal"][index],
        copy: ["DETAIL STARTS HERE", "DOUBLE-ENDED CONTROL", "BLEND SMALL AREAS", "REFINE THE EDGES", "TIDY THE FINISH", "READY FOR THE DETAILS?"][index],
        copyPlacement: ["top", "bottom", "center", "bottom", "top", "center"][index],
        emphasis: ["hook", "feature", "action", "action", "proof", "cta"][index],
      })),
    },
  };
}

test("DeepSeek vision request sends only bounded inline images and schema-constrained instructions", async () => {
  let request;
  const provider = new DeepSeekReferenceVisionProvider({
    keyProvider: async () => ({ value: "test-secret", source: "test" }),
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return new Response(JSON.stringify({
        status: "completed",
        usage: { input_tokens: 123, output_tokens: 45, total_tokens: 168 },
        output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(validPlan()) }] }],
      }), { status: 200 });
    },
  });
  const result = await provider.generate({
    durationSeconds: 12.6,
    boundaryTimes: [6.4, 7.25],
    productImage: { bytes: Buffer.from("product-jpeg") },
    referenceFrames: Array.from({ length: 4 }, (_, index) => ({ at: index + 0.5, bytes: Buffer.from(`frame-${index}`) })),
  });
  assert.equal(result.plan.product.category, "double-ended cotton swabs");
  assert.equal(result.plan.reference.actionSequence.length, 3);
  assert.equal(result.usage.totalTokens, 168);
  assert.equal(request.model, "deepseek-flash");
  assert.equal(request.text.format.type, "json_schema");
  assert.equal(request.input[0].content.filter((part) => part.type === "input_image").length, 5);
  assert.match(request.input[0].content[0].text, /generic action choreography/u);
  assert.equal(JSON.stringify(request).includes("test-secret"), false);
  assert.equal(JSON.stringify(request).includes("/Users/"), false);
});

test("vision plan rejects unverified claims before authoring", () => {
  const plan = validPlan();
  plan.adaptation.shots[2].copy = "CLINICALLY PROVEN PRECISION";
  assert.throws(() => validateReferenceVisionPlan(plan), (error) => error.code === "reference_vision_unsupported_claim");
});

test("vision plan supplies a safe strategy when the model omits a non-critical summary", () => {
  const plan = validPlan();
  delete plan.adaptation.strategy;
  const normalized = validateReferenceVisionPlan(plan);
  assert.match(normalized.adaptation.strategy, /product-led sequence/u);
});

test("vision plan supplies safe presentation summaries when the model leaves them blank", () => {
  const plan = validPlan();
  plan.product.category = "";
  plan.product.uncertainty = "";
  plan.reference.visualGrammar = "";
  plan.reference.subjectFraming = "";
  plan.reference.typography = "";
  const normalized = validateReferenceVisionPlan(plan);
  assert.match(normalized.product.category, /consumer product/u);
  assert.match(normalized.product.uncertainty, /visible product details/u);
  assert.match(normalized.reference.visualGrammar, /Product-led vertical sequence/u);
  assert.match(normalized.reference.subjectFraming, /Vertical close-up framing/u);
  assert.match(normalized.reference.typography, /high-contrast captions/u);
});

test("vision plan safely clips an overlong non-critical presentation summary", () => {
  const plan = validPlan();
  plan.reference.visualGrammar = `${"action rhythm ".repeat(60)}final reveal`;
  const normalized = validateReferenceVisionPlan(plan);
  assert.ok(normalized.reference.visualGrammar.length <= 500);
  assert.ok(normalized.reference.visualGrammar.length > 220);
  assert.match(normalized.reference.visualGrammar, /action rhythm/u);
});

test("reference frame selection is ordered, bounded, and includes strong boundaries", () => {
  const times = selectReferenceSampleTimes(12.6, [{ at: 7.25, score: 0.9 }, { at: 10.667, score: 0.8 }], 8);
  assert.equal(times.length, 8);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  assert.ok(times.includes(7.25));
  assert.ok(times.includes(10.667));
  assert.ok(times.every((time) => time > 0 && time < 12.6));
});
