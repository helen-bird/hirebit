import { AppError } from "./errors.mjs";
import {
  MAX_PRODUCTION_VARIANTS,
  PRODUCTION_LANGUAGE_ALIASES,
  SUPPORTED_ASPECT_RATIOS,
  SUPPORTED_PRODUCTION_LANGUAGES,
  isProductionLanguageTag,
  normalizeProductionLanguageTag,
  productionLanguageForAccent,
  productionVariantCount,
} from "./production-contract.mjs";
import { safeExternalUrl } from "./security.mjs";

const SUPPORTED_LANGUAGE_CODES = Object.freeze(SUPPORTED_PRODUCTION_LANGUAGES.map((item) => item.code));
const PRODUCT_LANGUAGE_LIMITATIONS = Object.freeze([
  "Narration locales: en-US, en-GB, es-US, zh-CN only.",
  "No voice cloning, named performers, custom voice likenesses, or unlisted regional accents.",
]);

const VEO_IMAGE_LIMITATION = "With a supplied product image and no reference video, this package may generate one 8-second product-motion shot; it does not perform literal motion transfer.";
const REFERENCE_ADAPTATION_LIMITATION = "With both a product image and a supported social-video link, the service analyzes reusable action choreography, pacing, framing, transitions, and reveal structure, then uses two consecutive 8-second generations for Hypit assembly. Reference-guided delivery follows the source duration within an 8-16 second production window. It does not reproduce the source person's identity, audio, captions, claims, or likeness, and is not frame-for-frame replacement.";

export const CATALOG_VERSION = "2026-09-21.4";

export const PRODUCTS = Object.freeze([
  {
    id: "creator_pitch",
    name: "Creator Pitch",
    availability: "available",
    basePriceSats: 900,
    durationSeconds: [15, 30],
    turnaroundMinutes: 25,
    objectives: ["direct_response", "product_launch", "creator_style_pitch"],
    production: {
      format: "talking-head",
      characters: 1,
      voices: 1,
      visualModes: ["package_default"],
      voiceRoles: ["narrator"],
      languages: SUPPORTED_LANGUAGE_CODES,
      hypitPlaybook: "talking-head.md",
    },
    limitations: [...PRODUCT_LANGUAGE_LIMITATIONS, VEO_IMAGE_LIMITATION],
    included: ["1 MP4", "product-aware creator motion when an image is supplied", "narration audio", "headline and supporting text", "9:16 output"],
  },
  {
    id: "proof_demo",
    name: "Proof Demo",
    availability: "available",
    basePriceSats: 1300,
    durationSeconds: [8, 45],
    turnaroundMinutes: 40,
    objectives: ["product_education", "feature_proof", "conversion"],
    production: {
      format: "narration-led-demo",
      characters: 0,
      voices: 1,
      visualModes: ["package_default", "product_only"],
      voiceRoles: ["narrator"],
      languages: SUPPORTED_LANGUAGE_CODES,
      hypitPlaybook: "narration-led-demo.md",
      referenceAdaptation: true,
    },
    limitations: [...PRODUCT_LANGUAGE_LIMITATIONS, VEO_IMAGE_LIMITATION, REFERENCE_ADAPTATION_LIMITATION],
    included: ["1 MP4", "two-part reference-guided product action when an image and link are supplied", "Hypit narration, captions, and source-length assembly", "9:16 output"],
  },
  {
    id: "ranking_listicle",
    name: "Ranking / Listicle",
    availability: "available",
    basePriceSats: 1600,
    durationSeconds: [20, 35],
    turnaroundMinutes: 50,
    objectives: ["comparison", "engagement", "consideration"],
    production: {
      format: "ranking-listicle",
      characters: 1,
      voices: 1,
      visualModes: ["package_default"],
      voiceRoles: ["narrator"],
      languages: SUPPORTED_LANGUAGE_CODES,
      hypitPlaybook: "ranking-listicle.md",
    },
    limitations: PRODUCT_LANGUAGE_LIMITATIONS,
    included: ["1 MP4", "fixed presenter layout", "three list points", "narration audio", "9:16 output"],
  },
  {
    id: "two_person_podcast",
    name: "Two-person Podcast",
    availability: "available",
    basePriceSats: 2100,
    durationSeconds: [18, 35],
    turnaroundMinutes: 65,
    objectives: ["social_proof", "objection_handling", "thought_leadership"],
    production: {
      format: "two-person-podcast",
      characters: 2,
      voices: 2,
      visualModes: ["package_default"],
      voiceRoles: ["host_a", "host_b"],
      languages: SUPPORTED_LANGUAGE_CODES,
      hypitPlaybook: "two-person-podcast.md",
    },
    limitations: PRODUCT_LANGUAGE_LIMITATIONS,
    included: ["1 MP4", "fixed two-host visual", "two-speaker dialogue audio", "headline and supporting text", "9:16 output"],
  },
]);

const PRODUCTION_MODES = Object.freeze({
  original: { label: "Original Production", priceSats: 0 },
});

function stringArray(value, field, fallback) {
  const result = value === undefined ? fallback : value;
  if (!Array.isArray(result) || result.length === 0 || result.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new AppError("invalid_quote_request", `${field} must be a non-empty string array`);
  }
  return [...new Set(result.map((item) => item.trim()))];
}

function creativeRequirements(brief, product) {
  if (typeof brief?.evidenceUrl === "string") {
    if (product.production.referenceAdaptation !== true) {
      throw new AppError("reference_adaptation_unsupported", `${product.name} does not support reference-video adaptation`, 409);
    }
    if (typeof brief?.referenceUrl !== "string") {
      throw new AppError("reference_product_image_required", "Reference-video adaptation requires a product image", 409);
    }
  }
  const visualMode = brief?.visualMode ?? "package_default";
  if (!product.production.visualModes.includes(visualMode)) {
    throw new AppError("visual_mode_unsupported", `${product.name} does not support visual mode: ${visualMode}`, 409, {
      supported: product.production.visualModes,
    });
  }
  const requestedVoices = brief?.voiceRequirements ?? [];
  if (!Array.isArray(requestedVoices) || requestedVoices.length > product.production.voices) {
    throw new AppError("voice_requirements_unsupported", `${product.name} supports at most ${product.production.voices} voice requirement(s)`, 409);
  }
  const seen = new Set();
  const voiceRequirements = requestedVoices.map((item, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)
      || !product.production.voiceRoles.includes(item.role)
      || !["neutral", "warm", "energetic", "calm"].includes(item.style)
      || !["slow", "normal", "fast"].includes(item.pace)
      || (item.accent !== null && item.accent !== undefined && typeof item.accent !== "string")) {
      throw new AppError("voice_requirements_unsupported", `${product.name} cannot satisfy voice requirement ${index + 1}`, 409, {
        supportedRoles: product.production.voiceRoles,
      });
    }
    if (seen.has(item.role)) throw new AppError("voice_requirements_unsupported", "Voice requirement roles must be unique", 409);
    seen.add(item.role);
    const accent = typeof item.accent === "string" ? item.accent.trim() : null;
    if (accent !== null && (accent.length === 0 || accent.length > 80)) {
      throw new AppError("voice_requirements_unsupported", "Voice accent must contain 1-80 characters", 409);
    }
    return { role: item.role, style: item.style, pace: item.pace, accent };
  });
  return { visualMode, voiceRequirements };
}

export function publicCatalog() {
  return {
    version: CATALOG_VERSION,
    currency: "BTC",
    pricingUnit: "sats",
    products: PRODUCTS,
    productionModes: PRODUCTION_MODES,
    addOns: {
      hookVariants: { allowed: [1, 3, 5], additionalVariantPriceSats: 180 },
      extraLanguage: { priceSats: 250 },
      extraAspectRatio: { priceSats: 150, allowed: SUPPORTED_ASPECT_RATIOS },
      inputSourceManifest: {
        label: "Input Source Manifest",
        description: "JSON list of supplied claims and localized input file metadata; it does not independently verify claims.",
        priceSats: 300,
      },
      maxTotalVideos: MAX_PRODUCTION_VARIANTS,
    },
    languagePolicy: {
      provider: "Google Cloud Text-to-Speech",
      supported: SUPPORTED_PRODUCTION_LANGUAGES,
      aliases: PRODUCTION_LANGUAGE_ALIASES,
      limitations: [
        "Only the listed locale codes are sellable; other languages and regional accents are rejected before payment.",
        "Generic en, es, zh and cmn inputs are normalized to en-US, es-US and zh-CN.",
        "An explicit accent is supported only for a single-language order and must match that locale.",
        "Voice gender, named performers, cloning and custom voice likenesses are not offered.",
      ],
    },
    paymentPolicy: {
      rail: "GoBTC Pay instant mainnet",
      fulfillmentUnlockStatus: "paid",
      settlementEvidence: "paidAt plus transactions",
    },
  };
}

export function calculateQuote(input) {
  if (input === null || typeof input !== "object") {
    throw new AppError("invalid_quote_request", "Quote request must be a JSON object");
  }
  const product = PRODUCTS.find((item) => item.id === input.productId);
  if (product === undefined) throw new AppError("unknown_product", `Unknown product: ${input.productId}`);
  if (input.brief !== undefined
    && (input.brief === null || typeof input.brief !== "object" || Array.isArray(input.brief))) {
    throw new AppError("invalid_quote_request", "brief must be a JSON object");
  }
  const productionMode = input.productionMode ?? "original";
  const mode = PRODUCTION_MODES[productionMode];
  if (mode === undefined) throw new AppError("invalid_production_mode", `Unknown production mode: ${productionMode}`);
  if (input.brief?.referenceUrl !== undefined) safeExternalUrl(input.brief.referenceUrl, "brief.referenceUrl");
  if (input.brief?.evidenceUrl !== undefined) safeExternalUrl(input.brief.evidenceUrl, "brief.evidenceUrl");
  const requirements = creativeRequirements(input.brief, product);

  const hookVariants = input.addOns?.hookVariants ?? 1;
  if (![1, 3, 5].includes(hookVariants)) {
    throw new AppError("invalid_hook_variants", "addOns.hookVariants must be 1, 3, or 5");
  }
  const requestedLanguages = stringArray(input.addOns?.languages, "addOns.languages", ["en-US"]);
  const invalidLanguage = requestedLanguages.find((item) => !isProductionLanguageTag(item));
  if (invalidLanguage !== undefined) {
    throw new AppError("invalid_language_tag", `Invalid production language tag: ${invalidLanguage}`);
  }
  const unsupportedLanguage = requestedLanguages.find((item) => normalizeProductionLanguageTag(item) === null);
  if (unsupportedLanguage !== undefined) {
    throw new AppError("unsupported_production_language", `Production language is not supported: ${unsupportedLanguage}`, 409, {
      supported: SUPPORTED_LANGUAGE_CODES,
    });
  }
  const languages = requestedLanguages.map((item) => normalizeProductionLanguageTag(item));
  if (new Set(languages).size !== languages.length) {
    throw new AppError("invalid_language_tag", "Production languages must be unique regardless of case");
  }
  const explicitAccents = requirements.voiceRequirements.filter((item) => item.accent !== null);
  if (languages.length > 1 && explicitAccents.length > 0) {
    throw new AppError("voice_accent_unsupported", "Explicit accents are available only for single-language orders", 409, {
      supportedLanguages: SUPPORTED_LANGUAGE_CODES,
    });
  }
  if (languages.length === 1) {
    const mismatched = explicitAccents.find((item) => productionLanguageForAccent(item.accent) !== languages[0]);
    if (mismatched !== undefined) {
      throw new AppError("voice_accent_unsupported", `Voice accent is unavailable for ${languages[0]}: ${mismatched.accent}`, 409, {
        language: languages[0],
      });
    }
  }
  const aspectRatios = stringArray(input.addOns?.aspectRatios, "addOns.aspectRatios", ["9:16"]);
  const unsupportedAspectRatio = aspectRatios.find((item) => !SUPPORTED_ASPECT_RATIOS.includes(item));
  if (unsupportedAspectRatio !== undefined) {
    throw new AppError("unsupported_aspect_ratio", `Unsupported aspect ratio: ${unsupportedAspectRatio}`, 400, {
      supported: SUPPORTED_ASPECT_RATIOS,
    });
  }
  const totalVideos = productionVariantCount({ hookVariants, languages, aspectRatios });
  if (totalVideos > MAX_PRODUCTION_VARIANTS) {
    throw new AppError("production_variant_limit", `The requested matrix contains ${totalVideos} videos; maximum is ${MAX_PRODUCTION_VARIANTS}`, 400);
  }
  const inputSourceManifest = input.addOns?.inputSourceManifest === true;

  const lineItems = [
    { code: "base_production", label: product.name, amountSats: product.basePriceSats },
    { code: `mode_${productionMode}`, label: mode.label, amountSats: mode.priceSats },
    { code: "hook_variants", label: `${hookVariants} hook variant(s)`, amountSats: (hookVariants - 1) * 180 },
    { code: "languages", label: `${languages.length} language(s)`, amountSats: (languages.length - 1) * 250 },
    { code: "aspect_ratios", label: `${aspectRatios.length} aspect ratio(s)`, amountSats: (aspectRatios.length - 1) * 150 },
    ...(inputSourceManifest ? [{ code: "input_source_manifest", label: "Input Source Manifest", amountSats: 300 }] : []),
  ];
  const amountSats = lineItems.reduce((sum, item) => sum + item.amountSats, 0);
  const budgetSats = input.budgetSats;
  if (budgetSats !== undefined && (!Number.isSafeInteger(budgetSats) || budgetSats < 0)) {
    throw new AppError("invalid_budget", "budgetSats must be a non-negative integer");
  }
  if (budgetSats !== undefined && amountSats > budgetSats) {
    throw new AppError("budget_exceeded", `Quote is ${amountSats} sats, above the ${budgetSats}-sat budget`, 409, {
      amountSats,
      budgetSats,
    });
  }

  return {
    catalogVersion: CATALOG_VERSION,
    product,
    productionMode,
    addOns: { hookVariants, languages, aspectRatios, inputSourceManifest },
    brief: { ...(input.brief ?? {}), ...requirements },
    lineItems,
    amountSats,
    currency: "BTC",
    estimatedTurnaroundMinutes: product.turnaroundMinutes + ((hookVariants - 1) * 5) + ((languages.length - 1) * 10),
    decisionFactors: {
      objectives: product.objectives,
      format: product.production.format,
      withinBudget: budgetSats === undefined ? null : true,
      remainingBudgetSats: budgetSats === undefined ? null : budgetSats - amountSats,
    },
  };
}
