export const SUPPORTED_ASPECT_RATIOS = Object.freeze(["9:16", "1:1", "16:9"]);
export const MAX_PRODUCTION_VARIANTS = 30;

export const SUPPORTED_PRODUCTION_LANGUAGES = Object.freeze([
  Object.freeze({ code: "en-US", label: "English (United States)", providerLocale: "en-US" }),
  Object.freeze({ code: "en-GB", label: "English (United Kingdom)", providerLocale: "en-GB" }),
  Object.freeze({ code: "es-US", label: "Spanish (United States)", providerLocale: "es-US" }),
  Object.freeze({ code: "zh-CN", label: "Mandarin Chinese (Mainland China)", providerLocale: "cmn-CN" }),
]);

export const PRODUCTION_LANGUAGE_ALIASES = Object.freeze({
  en: "en-US",
  es: "es-US",
  zh: "zh-CN",
  cmn: "zh-CN",
  "cmn-cn": "zh-CN",
});

const CANONICAL_LANGUAGE_BY_LOWERCASE = new Map(SUPPORTED_PRODUCTION_LANGUAGES.map((item) => (
  [item.code.toLowerCase(), item.code]
)));

const ACCENT_LANGUAGE_ALIASES = new Map(Object.entries({
  "us english": "en-US",
  "united states english": "en-US",
  "english (united states)": "en-US",
  "american english": "en-US",
  american: "en-US",
  "uk english": "en-GB",
  "united kingdom english": "en-GB",
  "british english": "en-GB",
  british: "en-GB",
  "us spanish": "es-US",
  mandarin: "zh-CN",
  "mainland mandarin": "zh-CN",
  "mainland chinese": "zh-CN",
  "en-us": "en-US",
  "en-gb": "en-GB",
  "es-us": "es-US",
  "zh-cn": "zh-CN",
  "cmn-cn": "zh-CN",
}));

export function isProductionLanguageTag(value) {
  return typeof value === "string" && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u.test(value);
}

export function normalizeProductionLanguageTag(value) {
  if (!isProductionLanguageTag(value)) return null;
  const lower = value.trim().toLowerCase();
  return CANONICAL_LANGUAGE_BY_LOWERCASE.get(lower) ?? PRODUCTION_LANGUAGE_ALIASES[lower] ?? null;
}

export function isSupportedProductionLanguage(value) {
  return normalizeProductionLanguageTag(value) !== null;
}

export function productionLanguageForAccent(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  return ACCENT_LANGUAGE_ALIASES.get(value.trim().toLowerCase()) ?? null;
}

export function productionVariantCount({ hookVariants, languages, aspectRatios }) {
  return hookVariants * languages.length * aspectRatios.length;
}
