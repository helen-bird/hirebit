import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  DeepSeekProductionCopyProvider,
  GoogleCloudTtsVoiceProvider,
  ProductionInputPreparer,
} from "../src/production-input-preparer.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const voiceFixture = join(rootDir, "productions/ranking-listicle/assets/narration.wav");

function copyValue({ languages, hookCount, productId = "ranking_listicle" }) {
  return {
    variants: languages.flatMap((language) => Array.from({ length: hookCount }, (_, offset) => {
      const hookIndex = offset + 1;
      return {
        hookIndex,
        language,
        headline: `${language} headline ${hookIndex}`,
        items: [`${language} one`, `${language} two`, `${language} three`],
        voiceScript: productId === "two_person_podcast" ? `${language} A ${hookIndex} ${language} B ${hookIndex}` : `${language} narration ${hookIndex}`,
        speakerTurns: productId === "two_person_podcast"
          ? [{ role: "host_a", text: `${language} A ${hookIndex}` }, { role: "host_b", text: `${language} B ${hookIndex}` }]
          : [{ role: "host_a", text: `${language} narration ${hookIndex}` }],
      };
    })),
  };
}

async function commissionFixture() {
  const jobDir = await mkdtemp(join(tmpdir(), "production-inputs-"));
  const order = { id: "ord_inputs", amountSats: 1234, payment: { secret: "never-send" } };
  const quote = {
    product: { id: "ranking_listicle", name: "Ranking", objectives: ["comparison"] },
    brief: {
      productName: "UNO R4 WiFi",
      description: "Compare documented features",
      hooks: ["Hook one", "Hook two", "Hook three"],
      items: ["UNO format", "Wireless", "LED matrix"],
      visualMode: "package_default",
      voiceRequirements: [{ role: "narrator", style: "energetic", pace: "fast", accent: "US English" }],
      referenceUrl: "https://should-not-be-sent.example/private",
    },
    addOns: { hookVariants: 3, languages: ["en-US", "zh-CN"], aspectRatios: ["9:16", "1:1"] },
  };
  const localAssets = {
    referenceUrl: { path: "/private/order/file.jpg", filename: "private.jpg", mediaType: "image/jpeg", bytes: 42, sha256: "a".repeat(64), sourceHost: "private.example" },
  };
  const commissionPath = join(jobDir, "commission.json");
  await writeFile(commissionPath, `${JSON.stringify({ order, quote, localAssets }, null, 2)}\n`, { mode: 0o600 });
  return { jobDir, order, quote, commissionPath };
}

test("production inputs generate once per hook-language and remain stable across retries", async () => {
  const input = await commissionFixture();
  const copyCalls = [];
  const voiceCalls = [];
  const preparer = new ProductionInputPreparer({
    copyProvider: {
      async generate(request) {
        copyCalls.push(request);
        return { provider: "fake-copy", model: "fake-model", value: copyValue(request) };
      },
    },
    voiceProvider: {
      provider: "fake-voice",
      async synthesize(request) {
        voiceCalls.push({ language: request.language, role: request.role, text: request.text, requirements: request.requirements });
        await copyFile(voiceFixture, request.destination);
        return {
          provider: "fake-voice",
          voiceId: `${request.language}-${request.role}`,
          commercialUseApproved: false,
          requirementsApplied: true,
          mediaType: "audio/wav",
        };
      },
    },
  });
  const manifest = await preparer.prepare(input);
  assert.equal(manifest.variants.length, 6);
  assert.equal(copyCalls.length, 1);
  assert.equal(voiceCalls.length, 6);
  assert.equal(manifest.voice.commercialUseApproved, false);
  assert.equal(manifest.voice.requirementsSatisfied, true);
  assert.ok(manifest.voice.billableCharacters > 0);
  assert.deepEqual(voiceCalls[0].requirements, {
    role: "narrator", style: "energetic", pace: "fast", accent: "US English",
  });
  assert.deepEqual(manifest.creativeRequirements, {
    visualMode: "package_default",
    voiceRequirements: [{ role: "narrator", style: "energetic", pace: "fast", accent: "US English" }],
  });
  assert.deepEqual(Object.keys(copyCalls[0]).sort(), ["assetMetadata", "brief", "hookCount", "languages", "objectives", "productId", "productName"]);
  assert.equal(JSON.stringify(copyCalls[0]).includes("never-send"), false);
  assert.equal(JSON.stringify(copyCalls[0]).includes("private.example"), false);
  assert.equal(JSON.stringify(copyCalls[0]).includes("/private/order"), false);
  const again = await preparer.prepare(input);
  assert.equal(again.manifestSha256, manifest.manifestSha256);
  assert.equal(copyCalls.length, 1);
  assert.equal(voiceCalls.length, 6);
  const firstAudio = join(input.jobDir, "production-inputs", manifest.variants[0].audio[0].file);
  await writeFile(firstAudio, "tampered");
  await assert.rejects(preparer.prepare(input), (error) => error.code === "production_input_digest_mismatch");
});

test("DeepSeek production copy request contains only the explicitly sanitized production input", async () => {
  let requestBody;
  const value = copyValue({ languages: ["es-MX"], hookCount: 1 });
  const provider = new DeepSeekProductionCopyProvider({
    baseUrl: "https://api.deepseek.com",
    keyProvider: async () => ({ value: "test-secret", source: "test" }),
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return new Response(JSON.stringify({
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(value) }] }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const result = await provider.generate({
    productId: "ranking_listicle",
    productName: "Ranking",
    objectives: ["comparison"],
    brief: { productName: "UNO R4 WiFi" },
    languages: ["es-MX"],
    hookCount: 1,
    assetMetadata: [{ mediaType: "image/jpeg", bytes: 42, sha256: "a".repeat(64) }],
  });
  assert.equal(result.provider, "deepseek");
  assert.equal(requestBody.model, "deepseek-flash");
  assert.equal(JSON.stringify(requestBody).includes("test-secret"), false);
  assert.equal(requestBody.text.format.type, "json_schema");
});

test("production provider readiness fails closed without DeepSeek credentials and validates Google ADC", async () => {
  const copy = new DeepSeekProductionCopyProvider({
    keyProvider: async () => { throw Object.assign(new Error("missing"), { code: "deepseek_credential_missing" }); },
  });
  const voice = new GoogleCloudTtsVoiceProvider({
    projectId: null,
    commercialUseApproved: true,
    accessTokenProvider: async () => "short-lived-token",
    projectProvider: async () => "test-project",
  });
  const preparer = new ProductionInputPreparer({ copyProvider: copy, voiceProvider: voice });
  const readiness = await preparer.readiness();
  assert.equal(readiness.configured, false);
  assert.equal(readiness.copy.issue, "deepseek_credential_missing");
  assert.equal(readiness.voice.configured, true);
  assert.equal(readiness.voice.projectConfigured, true);
  assert.equal(JSON.stringify(readiness).includes("short-lived-token"), false);
});

test("Google Cloud TTS applies locale and style controls through ADC without exposing its token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "google-tts-provider-"));
  const destination = join(directory, "voice.wav");
  const calls = [];
  let tokenCalls = 0;
  let projectCalls = 0;
  const provider = new GoogleCloudTtsVoiceProvider({
    projectId: null,
    commercialUseApproved: true,
    accessTokenProvider: async () => { tokenCalls += 1; return "short-lived-secret"; },
    projectProvider: async () => { projectCalls += 1; return "test-project"; },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.includes("/v1/voices")) {
        return new Response(JSON.stringify({ voices: [
          { name: "en-GB-Studio-B", languageCodes: ["en-GB"] },
          { name: "en-GB-Neural2-A", languageCodes: ["en-GB"] },
          { name: "en-GB-Neural2-B", languageCodes: ["en-GB"] },
        ] }), { status: 200 });
      }
      return new Response(JSON.stringify({ audioContent: Buffer.alloc(2048, 1).toString("base64") }), { status: 200 });
    },
  });
  const metadata = await provider.synthesize({
    text: "A concise commercial narration.",
    language: "en-US",
    role: "host_b",
    destination,
    requirements: { role: "host_b", style: "energetic", pace: "fast", accent: "British English" },
  });
  assert.equal(metadata.voiceId, "en-GB-Neural2-B");
  assert.equal(metadata.commercialUseApproved, true);
  assert.equal(metadata.requirementsApplied, true);
  assert.deepEqual(metadata.appliedVoice, {
    locale: "en-GB", stylePreset: "energetic", speakingRate: 1.239, pitch: 2, volumeGainDb: 1,
  });
  assert.equal((await readFile(destination)).length, 2048);
  assert.equal(tokenCalls, 1);
  assert.equal(projectCalls, 1);
  assert.equal(calls[0].options.headers.authorization, "Bearer short-lived-secret");
  assert.equal(calls[0].options.headers["x-goog-user-project"], "test-project");
  const synthesis = JSON.parse(calls[1].options.body);
  assert.equal(synthesis.voice.languageCode, "en-GB");
  assert.equal(synthesis.voice.name, "en-GB-Neural2-B");
  assert.equal(synthesis.audioConfig.speakingRate, 1.239);
  assert.equal(JSON.stringify(metadata).includes("short-lived-secret"), false);
});

test("Google Cloud TTS rejects a regional voice fallback that does not satisfy the requested accent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "google-tts-locale-fallback-"));
  const provider = new GoogleCloudTtsVoiceProvider({
    projectId: "test-project",
    commercialUseApproved: true,
    accessTokenProvider: async () => "short-lived-secret",
    fetchImpl: async () => new Response(JSON.stringify({ voices: [
      { name: "es-US-Neural2-A", languageCodes: ["es-US"] },
    ] }), { status: 200 }),
  });
  await assert.rejects(provider.synthesize({
    text: "Prueba breve.",
    language: "es-MX",
    role: "host_a",
    destination: join(directory, "voice.wav"),
    requirements: { role: "narrator", style: "energetic", pace: "fast", accent: "Mexican Spanish" },
  }), (error) => error.code === "voice_language_unsupported");
});

test("production inputs record unmet voice requirements instead of silently claiming success", async () => {
  const input = await commissionFixture();
  const preparer = new ProductionInputPreparer({
    copyProvider: {
      async generate(request) {
        return { provider: "fake-copy", model: "fake-model", value: copyValue(request) };
      },
    },
    voiceProvider: {
      provider: "limited-voice",
      async synthesize(request) {
        await copyFile(voiceFixture, request.destination);
        return {
          provider: "limited-voice",
          voiceId: "neutral-only",
          commercialUseApproved: true,
          requirementsApplied: false,
          mediaType: "audio/wav",
        };
      },
    },
  });
  const manifest = await preparer.prepare(input);
  assert.equal(manifest.voice.commercialUseApproved, true);
  assert.equal(manifest.voice.requirementsSatisfied, false);
  assert.equal(manifest.variants[0].audio[0].requirementsApplied, false);
  const manifestPath = join(input.jobDir, "production-inputs", "manifest.json");
  const tampered = JSON.parse(await readFile(manifestPath, "utf8"));
  tampered.voice.requirementsSatisfied = true;
  await writeFile(manifestPath, `${JSON.stringify(tampered, null, 2)}\n`);
  await assert.rejects(preparer.prepare(input), (error) => error.code === "production_input_manifest_invalid");
});
