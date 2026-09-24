import assert from "node:assert/strict";
import test from "node:test";

import { calculateQuote, publicCatalog } from "../src/catalog.mjs";

test("catalog exposes four purchasable production formats", () => {
  const catalog = publicCatalog();
  const available = catalog.products.filter((item) => item.availability === "available");
  assert.deepEqual(available.map((item) => item.id), [
    "creator_pitch",
    "proof_demo",
    "ranking_listicle",
    "two_person_podcast",
  ]);
  assert.deepEqual(catalog.languagePolicy.supported.map((item) => item.code), ["en-US", "en-GB", "es-US", "zh-CN"]);
  assert.ok(available.every((item) => item.production.languages.join(",") === "en-US,en-GB,es-US,zh-CN"));
});

test("quote composes the original format and reuse-friendly add-ons", () => {
  const quote = calculateQuote({
    productId: "ranking_listicle",
    productionMode: "original",
    budgetSats: 3000,
    brief: { referenceUrl: "https://example.com/product.jpg" },
    addOns: { hookVariants: 3, languages: ["en", "es"], aspectRatios: ["9:16", "1:1"] },
  });
  assert.equal(quote.amountSats, 2360);
  assert.equal(quote.decisionFactors.remainingBudgetSats, 640);
  assert.deepEqual(quote.addOns.languages, ["en-US", "es-US"]);
  assert.throws(() => calculateQuote({
    productId: "ranking_listicle",
    productionMode: "reference_remix",
  }), (error) => error.code === "invalid_production_mode");
});

test("quote rejects an option above the agent budget", () => {
  assert.throws(() => calculateQuote({
    productId: "two_person_podcast",
    budgetSats: 1000,
  }), (error) => error.code === "budget_exceeded");
});

test("quote accepts only creative requirements the selected package can deliver", () => {
  const proof = calculateQuote({
    productId: "proof_demo",
    brief: {
      visualMode: "product_only",
      voiceRequirements: [{ role: "narrator", style: "calm", pace: "slow", accent: "US English" }],
    },
  });
  assert.equal(proof.brief.visualMode, "product_only");
  assert.equal(proof.brief.voiceRequirements[0].pace, "slow");
  const usVoice = calculateQuote({
    productId: "proof_demo",
    brief: { voiceRequirements: [{ role: "narrator", style: "energetic", pace: "normal", accent: "United States English" }] },
    addOns: { hookVariants: 1, languages: ["en-US"], aspectRatios: ["9:16"] },
  });
  assert.equal(usVoice.brief.voiceRequirements[0].accent, "United States English");
  assert.throws(() => calculateQuote({
    productId: "creator_pitch",
    brief: { visualMode: "product_only", voiceRequirements: [] },
  }), (error) => error.code === "visual_mode_unsupported");
  assert.throws(() => calculateQuote({
    productId: "two_person_podcast",
    brief: { voiceRequirements: [{ role: "narrator", style: "neutral", pace: "normal", accent: null }] },
  }), (error) => error.code === "voice_requirements_unsupported");
});

test("reference-video orders require a product image and the Product Showcase package", () => {
  const referenceBrief = {
    referenceUrl: "https://example.com/product.jpeg",
    evidenceUrl: "https://www.tiktok.com/@example/video/1234567890123456789",
  };
  const proof = calculateQuote({ productId: "proof_demo", brief: referenceBrief });
  assert.equal(proof.product.production.referenceAdaptation, true);
  assert.throws(() => calculateQuote({
    productId: "creator_pitch",
    brief: referenceBrief,
  }), (error) => error.code === "reference_adaptation_unsupported");
  assert.throws(() => calculateQuote({
    productId: "proof_demo",
    brief: { evidenceUrl: referenceBrief.evidenceUrl },
  }), (error) => error.code === "reference_product_image_required");
  for (const evidenceUrl of [
    "https://www.instagram.com/reel/DFa1b2C3d4E/",
    "https://www.youtube.com/shorts/dQw4w9WgXcQ",
  ]) {
    assert.throws(() => calculateQuote({
      productId: "proof_demo",
      brief: { ...referenceBrief, evidenceUrl },
    }), (error) => error.code === "reference_video_channel_mismatch");
  }
});

test("quote rejects output matrices the production compiler cannot fulfill", () => {
  assert.throws(() => calculateQuote({
    productId: "creator_pitch",
    addOns: { hookVariants: 1, languages: ["en"], aspectRatios: ["4:5"] },
  }), (error) => error.code === "unsupported_aspect_ratio");
  assert.throws(() => calculateQuote({
    productId: "creator_pitch",
    addOns: {
      hookVariants: 5,
      languages: ["en-US", "en-GB", "es-US", "zh-CN"],
      aspectRatios: ["9:16", "1:1"],
    },
  }), (error) => error.code === "production_variant_limit");
  assert.throws(() => calculateQuote({
    productId: "creator_pitch",
    addOns: { hookVariants: 1, languages: ["en-US", "en-us"], aspectRatios: ["9:16"] },
  }), (error) => error.code === "invalid_language_tag");
  assert.throws(() => calculateQuote({
    productId: "creator_pitch",
    addOns: { hookVariants: 1, languages: ["fr-FR"], aspectRatios: ["9:16"] },
  }), (error) => error.code === "unsupported_production_language"
    && error.details.supported.join(",") === "en-US,en-GB,es-US,zh-CN");
  assert.throws(() => calculateQuote({
    productId: "ranking_listicle",
    brief: { voiceRequirements: [{ role: "narrator", style: "energetic", pace: "fast", accent: "Mexican Spanish" }] },
    addOns: { languages: ["es-US"] },
  }), (error) => error.code === "voice_accent_unsupported");
});
