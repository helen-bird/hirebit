import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import ffmpegStatic from "ffmpeg-static";

import { inspectProductImage } from "../src/buyer/server.mjs";
import { validateCampaignDeliverables } from "../src/media-validator.mjs";
import { GoogleCloudTtsVoiceProvider } from "../src/production-input-preparer.mjs";
import {
  DeepSeekReferenceVisionProvider,
  extractReferenceVisionInputs,
  REFERENCE_VISION_PLAN_FORMAT,
  validateReferenceVisionPlan,
} from "../src/reference-vision-planner.mjs";

const execFileAsync = promisify(execFile);
const rootDir = resolve(import.meta.dirname, "..");
const hypitBin = join(rootDir, "vendor/hypit/hypit");
const runtimeFile = join(rootDir, "productions/hypit.runtime.json");
const inputRoot = join(rootDir, ".validation/reference-clone/input");
const evidenceRoot = join(rootDir, ".validation/reference-clone/evidence");
const outputRoot = join(rootDir, ".validation/reference-clone/output");
const projectRoot = join(rootDir, ".validation/reference-clone/hypit-project");
const productImage = resolve(process.argv[2] ?? join(inputRoot, "product.jpeg"));
const referenceVideo = resolve(process.argv[3] ?? join(inputRoot, "reference.mp4"));
const finalVideo = join(outputRoot, "cotton-swabs-vision-adapted.mp4");
const planRecordPath = join(evidenceRoot, "vision-plan.json");
const toolEnvironment = {
  ...process.env,
  PATH: [
    join(rootDir, ".tools/media-bin"),
    join(rootDir, ".tools/uv"),
    dirname(process.execPath),
    process.env.PATH,
  ].filter(Boolean).join(":"),
};

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseJson(stdout, subject) {
  try { return JSON.parse(stdout); } catch {
    throw new Error(`${subject} returned invalid JSON: ${stdout.slice(-1200)}`);
  }
}

async function command(program, args, { cwd = rootDir, timeout = 630_000, env = toolEnvironment } = {}) {
  const result = await execFileAsync(program, args, { cwd, timeout, env, maxBuffer: 8 * 1024 * 1024 });
  return result;
}

async function hypit(args, options = {}) {
  const { stdout } = await command(hypitBin, args, options);
  return parseJson(stdout, `hypit ${args[0]}`);
}

function even(value) {
  return Math.max(2, Math.floor(value / 2) * 2);
}

function appliedShot(shot) {
  return {
    ...shot,
    focusX: Math.max(0.36, Math.min(0.64, shot.focusX)),
    focusY: Math.max(0.42, Math.min(0.68, shot.focusY)),
    cropScale: Math.min(1.38, shot.cropScale),
  };
}

function cropPlan(width, height, shots) {
  const fullWidth = even(Math.min(width, height * (9 / 16)));
  const fullHeight = even(fullWidth * (16 / 9));
  const clamp = (value, maximum) => Math.max(0, Math.min(maximum, even(value)));
  return shots.map((requestedShot, index) => {
    const shot = appliedShot(requestedShot);
    const cropWidth = even(fullWidth / shot.cropScale);
    const cropHeight = even(cropWidth * (16 / 9));
    const centerX = shot.focusX * width;
    const centerY = shot.focusY * height;
    return {
      name: `shot-${index + 1}`,
      width: cropWidth,
      height: cropHeight,
      x: clamp(centerX - (cropWidth / 2), width - cropWidth),
      y: clamp(centerY - (cropHeight / 2), height - cropHeight),
    };
  });
}

async function prepareImages(image, plan) {
  const assetRoot = join(projectRoot, "assets");
  await mkdir(assetRoot, { recursive: true, mode: 0o700 });
  for (const crop of cropPlan(image.width, image.height, plan.adaptation.shots)) {
    await command(ffmpegStatic, [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", productImage,
      "-vf", `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},scale=720:1280:flags=lanczos`,
      "-frames:v", "1", join(assetRoot, `${crop.name}.jpg`),
    ], { timeout: 120_000 });
  }
}

async function prepareNarration(durationSeconds, script) {
  const scriptDigest = sha256(Buffer.from(script)).slice(0, 16);
  const raw = join(projectRoot, `assets/narration-${scriptDigest}-raw.wav`);
  const padded = join(projectRoot, `assets/narration-${scriptDigest}.wav`);
  try {
    await access(raw);
    await command(ffmpegStatic, [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", raw,
      "-af", "adelay=350|350,apad", "-t", String(durationSeconds),
      "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", padded,
    ], { timeout: 120_000 });
    return {
      script,
      metadata: {
        provider: "google-cloud-tts",
        voiceId: "reused-script-bound-audio",
        billableCharacters: [...script].length,
      },
      path: padded,
      filename: basename(padded),
    };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const voice = new GoogleCloudTtsVoiceProvider({
    projectId: process.env.GOOGLE_CLOUD_PROJECT,
    commercialUseApproved: process.env.GOOGLE_TTS_COMMERCIAL_USE_APPROVED === "1",
    maxCharactersPerOrder: 120,
  });
  const metadata = await voice.synthesize({
    text: script,
    language: "en-US",
    role: "host_a",
    destination: raw,
    requirements: { role: "narrator", style: "warm", pace: "fast", accent: "US English" },
  });
  await command(ffmpegStatic, [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", raw,
    "-af", "adelay=350|350,apad", "-t", String(durationSeconds),
    "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", padded,
  ], { timeout: 120_000 });
  return { script, metadata, path: padded, filename: basename(padded) };
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function shotTimeline(plan, durationSeconds) {
  const totalWeight = plan.adaptation.shots.reduce((sum, shot) => sum + shot.durationWeight, 0);
  let cursor = 0;
  return plan.adaptation.shots.map((shot, index) => {
    const start = cursor;
    const end = index === plan.adaptation.shots.length - 1
      ? durationSeconds
      : Number((cursor + ((durationSeconds * shot.durationWeight) / totalWeight)).toFixed(3));
    cursor = end;
    return { ...appliedShot(shot), start, end };
  });
}

function authorSource(durationSeconds, plan, narrationFilename) {
  const end = `${durationSeconds}s`;
  const [, accent, secondary] = plan.adaptation.palette;
  const hookText = readableText(accent);
  const ctaText = readableText(secondary);
  const shots = shotTimeline(plan, durationSeconds);
  const imageAssets = shots.map((_, index) => (
    `  <asset:Image id="shot-${index + 1}" src="./assets/shot-${index + 1}.jpg"/>`
  )).join("\n");
  const visualItems = shots.map((shot, index) => {
    const motion = shot.motion.replaceAll("_", "-");
    return `    <media-track:Item id="visual-${index + 1}" image={shot-${index + 1}} extent={portrait} start="${shot.start}s" end="${shot.end}s" frame={full} appearance={look.media.full} motion={look.motion.${motion}}/>`;
  }).join("\n");
  const placement = { top: "top-copy", center: "center-copy", bottom: "lower-copy" };
  const style = (emphasis) => emphasis === "hook" ? "hook-style" : emphasis === "cta" ? "cta-style" : "card-style";
  const textItems = shots.map((shot, index) => {
    const textStart = Math.min(shot.end - 0.08, shot.start + 0.08).toFixed(3);
    const textEnd = Math.max(Number(textStart) + 0.04, shot.end - 0.04).toFixed(3);
    return `    <typo:Area id="copy-${index + 1}" placement={${placement[shot.copyPlacement]}} style={${style(shot.emphasis)}} motion={pop} start="${textStart}s" end="${textEnd}s">${xml(shot.copy)}</typo:Area>`;
  }).join("\n");
  return `<?svml using="@hypit/markup@1"?>
<svml>
  <import as="asset" from="@hypit/media@1"/>
  <import as="pipeline" from="@hypit/media-pipeline@1"/>
  <import as="time" from="@hypit/timeline-author@1"/>
  <import as="space" from="@hypit/spatial@1"/>
  <import as="program" from="@hypit/program-space@1"/>
  <import as="fonts" from="@hypit/fonts-open@1"/>
  <import as="media-track" from="@hypit/media-track@1"/>
  <import as="audio" from="@hypit/audio-track@1"/>
  <import as="typo" from="@hypit/typography-track@1"/>
  <import as="film" from="@hypit/film@1"/>
  <import as="render" from="@hypit/render-hyperframes@1"/>
  <import as="look" source="./look.svs"/>

${imageAssets}
  <asset:Audio id="narration" src="./assets/${xml(narrationFilename)}"/>
  <space:Extent id="portrait" width="720" height="1280"/>

  <space:Canvas id="canvas" width="720" height="1280"/>
  <program:Clock id="clock" frame-rate="60"/>
  <time:Timeline id="program" clock={clock} end="${end}"/>
  <space:Frame id="full" within={canvas} left="0%" top="0%" right="100%" bottom="100%"/>
  <space:Frame id="top-copy" within={canvas} left="3%" top="7%" right="97%" bottom="28%"/>
  <space:Frame id="center-copy" within={canvas} left="3%" top="37%" right="97%" bottom="63%"/>
  <space:Frame id="lower-copy" within={canvas} left="3%" top="72%" right="97%" bottom="94%"/>

  <media-track:Track id="visuals" timeline={program.timeline} canvas={canvas}>
${visualItems}
  </media-track:Track>

  <fonts:Stack id="font" family="inter" weight="800" style="normal" emoji="color">
    <fonts:Fallback family="noto-sans-sc" weight="700" style="normal"/>
  </fonts:Stack>
  <typo:Style id="hook-style" recipe={look.text.hook} font={font}><typo:Fill color="${hookText}"/><typo:Box target="line" continuity="isolated" color="${accent}e8" padding="12 20" radius="18"/><typo:Shadow color="#00000066" x="0" y="7" blur="18"/></typo:Style>
  <typo:Style id="card-style" recipe={look.text.card} font={font}><typo:Fill color="${hookText}"/><typo:Box target="line" continuity="isolated" color="${accent}e8" padding="12 20" radius="18"/></typo:Style>
  <typo:Style id="cta-style" recipe={look.text.cta} font={font}><typo:Fill color="${ctaText}"/><typo:Box target="line" continuity="isolated" color="${secondary}ee" padding="14 22" radius="22"/></typo:Style>
  <typo:Motion id="pop"><typo:ItemKeyframe at="0" scale="0.72" opacity="0"/><typo:ItemKeyframe at="8" scale="1.06" opacity="1"/><typo:ItemKeyframe at="13" scale="1" opacity="1"/></typo:Motion>
  <typo:Track id="copy" timeline={program.timeline}>
${textItems}
  </typo:Track>

  <pipeline:Normalize id="narration-media" source={narration} clock={clock} video="none" audio="default" span-authority="audio"/>
  <audio:Track id="voice" timeline={program.timeline}>
    <audio:Item id="voiceover" source={narration-media.media} during="program" playback="once" gain="1" fade-in="2f" fade-out="8f"/>
  </audio:Track>

  <film:Film id="main" canvas={canvas} timeline={program.timeline} appearance={look.film.vertical}>
    <film:Track source={visuals.visual}/><film:Track source={copy.track}/><film:Track source={voice.audio}/>
  </film:Film>
  <render:Video id="final" composition={main.composition} timeline={program.timeline}/>
</svml>
`;
}

function readableText(hex) {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  const luminance = ((0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2])) / 255;
  return luminance > 0.56 ? "#201725" : "#ffffff";
}

function lookSource(plan) {
  const [background, accent, secondary] = plan.adaptation.palette;
  return `<?svml using="@hypit/svs@1"?>
<sheet version="1">
  film.vertical { background: ${background}; }
  media.full { stack-order: 0; fit: cover; frame-paint: ${background}; clip: frame; }
  motion.punch { sustain: breathe 0.025 2; }
  motion.drift-right { sustain: float 7 2; }
  motion.drift-left { sustain: breathe 0.02 2; }
  motion.slow-zoom { sustain: breathe 0.018 2; }
  motion.reveal { sustain: breathe 0.012 2; }
  text.hook { stack-order: 100; size: 38; weight: 850; line-height: 0.95; tracking: -1; transform: uppercase; align: center; block-align: center; wrap: word; overflow: shrink; minimum-scale: 0.72; padding: 8 12; }
  text.card { stack-order: 101; size: 30; weight: 820; line-height: 1; tracking: 0; transform: uppercase; align: center; block-align: center; wrap: word; overflow: shrink; minimum-scale: 0.72; padding: 8 10; }
  text.cta { stack-order: 102; size: 36; weight: 850; line-height: 0.98; tracking: -0.5; transform: uppercase; align: center; block-align: center; wrap: word; overflow: shrink; minimum-scale: 0.72; padding: 8 10; }
</sheet>
`;
}

async function referenceVisionPlan({ durationSeconds, boundaries, productDigest, referenceDigest }) {
  try {
    const record = JSON.parse(await readFile(planRecordPath, "utf8"));
    if (record.format === REFERENCE_VISION_PLAN_FORMAT
      && record.inputs?.productSha256 === productDigest
      && record.inputs?.referenceSha256 === referenceDigest) {
      return { ...record, plan: validateReferenceVisionPlan(record.plan), reused: true };
    }
  } catch (error) {
    if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  const prepared = await extractReferenceVisionInputs({
    productImagePath: productImage,
    referenceVideoPath: referenceVideo,
    durationSeconds,
    boundaryCandidates: boundaries.candidates,
    directory: join(evidenceRoot, "vision-inputs"),
  });
  const provider = new DeepSeekReferenceVisionProvider({
    baseUrl: process.env.DEEPSEEK_BASE_URL,
    model: process.env.DEEPSEEK_MODEL ?? "deepseek-flash",
  });
  const generated = await provider.generate({
    durationSeconds,
    boundaryTimes: boundaries.candidates.map((item) => item.at),
    productImage: prepared.productImage,
    referenceFrames: prepared.referenceFrames,
  });
  const record = {
    format: REFERENCE_VISION_PLAN_FORMAT,
    createdAt: new Date().toISOString(),
    inputs: { productSha256: productDigest, referenceSha256: referenceDigest },
    sampling: prepared.referenceFrames.map((frame) => frame.at),
    provider: generated.provider,
    model: generated.model,
    usage: generated.usage,
    plan: generated.plan,
  };
  await writeFile(planRecordPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return { ...record, reused: false };
}

await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
await mkdir(outputRoot, { recursive: true, mode: 0o700 });
await mkdir(join(projectRoot, "runs"), { recursive: true, mode: 0o700 });
const imageBytes = await readFile(productImage);
const referenceBytes = await readFile(referenceVideo);
const productDigest = sha256(imageBytes);
const referenceDigest = sha256(referenceBytes);
const image = inspectProductImage(imageBytes, "image/jpeg");
const reference = await hypit(["media", "probe", referenceVideo, "--json"]);
const durationSeconds = Number(Math.min(12.6, Math.max(8, reference.duration)).toFixed(3));
const boundaries = await hypit(["media", "boundaries", referenceVideo, "--rate", "12", "--threshold", "0.20", "--json"]);
const vision = await referenceVisionPlan({ durationSeconds, boundaries, productDigest, referenceDigest });
await prepareImages(image, vision.plan);
const narration = await prepareNarration(durationSeconds, vision.plan.adaptation.narration);
await writeFile(join(projectRoot, "author.svml"), authorSource(durationSeconds, vision.plan, narration.filename), { mode: 0o600 });
await writeFile(join(projectRoot, "look.svs"), lookSource(vision.plan), { mode: 0o600 });
await writeFile(join(projectRoot, "package.json"), `${JSON.stringify({ name: "reference-clone-acceptance", private: true, type: "module" }, null, 2)}\n`, { mode: 0o600 });
await writeFile(join(projectRoot, "runs/build.svrun"), `<?svml using="@hypit/run-markup@1"?>\n<svrun version="1"><author source="../author.svml"/><target output="final.video"/></svrun>\n`, { mode: 0o600 });

const runPath = join(projectRoot, "runs/build.svrun");
await hypit(["runtime", "up", "--workspace", projectRoot, "--runtime", runtimeFile, "--json"], { timeout: 120_000 });
let buildId;
const temporaryFinalVideo = join(outputRoot, `.vision-output-${randomUUID()}.mp4`);
try {
  await hypit(["check", runPath, "--workspace", projectRoot, "--json"], { cwd: projectRoot, timeout: 120_000 });
  const plan = await hypit(["plan", runPath, "--workspace", projectRoot, "--runtime", runtimeFile, "--json"], { cwd: projectRoot, timeout: 120_000 });
  if (plan.ok === false || Number(plan.requestIssueCount ?? 0) > 0) throw new Error("Reference-clone Hypit plan is unresolved");
  const built = await hypit([
    "build", runPath, "--workspace", projectRoot, "--runtime", runtimeFile,
    "--title", "reference-vision-acceptance", "--follow", "--max-wait-ms", "600000", "--json",
  ], { cwd: projectRoot });
  const build = built.build ?? built;
  buildId = build.id;
  if (typeof buildId !== "string" || build.work?.outcome !== "complete") throw new Error("Reference-clone Hypit Build did not complete");
  await hypit(["get", buildId, "--output", "final.video", "--to", temporaryFinalVideo, "--workspace", projectRoot, "--json"], { cwd: projectRoot, timeout: 300_000 });
  await rename(temporaryFinalVideo, finalVideo);
} finally {
  await rm(temporaryFinalVideo, { force: true });
  await hypit(["runtime", "down", "--workspace", projectRoot, "--runtime", runtimeFile, "--json"], { timeout: 120_000 }).catch(() => {});
}

const file = {
  name: basename(finalVideo),
  absolutePath: finalVideo,
  mediaType: "video/mp4",
  specification: { hookIndex: 1, language: "en-US", aspectRatio: "9:16" },
};
const quote = {
  product: { id: "reference_clone_acceptance", durationSeconds: [durationSeconds, durationSeconds] },
  addOns: { hookVariants: 1, languages: ["en-US"], aspectRatios: ["9:16"], inputSourceManifest: false },
};
const mediaAcceptance = await validateCampaignDeliverables({ files: [file], quote });
const result = {
  format: "seller.reference-clone-acceptance@2",
  completedAt: new Date().toISOString(),
  result: "passed",
  inputs: {
    productImage: { path: productImage, width: image.width, height: image.height, sha256: productDigest },
    referenceVideo: {
      path: referenceVideo,
      sourceUrl: "https://www.tiktok.com/@bilintinamakeup/video/6798977602963918085",
      duration: reference.duration,
      width: reference.width,
      height: reference.height,
      frameRate: reference.frameRate,
      hasAudio: reference.hasAudio,
      boundaryCandidates: boundaries.candidates,
      sha256: referenceDigest,
    },
  },
  adaptation: {
    durationSeconds,
    source: "deepseek-vision",
    model: vision.model,
    planReused: vision.reused,
    samplingSeconds: vision.sampling,
    inputTokens: vision.usage.inputTokens,
    outputTokens: vision.usage.outputTokens,
    product: vision.plan.product,
    reference: vision.plan.reference,
    strategy: vision.plan.adaptation.strategy,
    renderedShots: shotTimeline(vision.plan, durationSeconds),
    originalPeopleOrAudioReused: false,
    copy: narration.script,
  },
  production: {
    provider: "self-hosted-hypit",
    buildId,
    ttsProvider: narration.metadata.provider,
    ttsVoice: narration.metadata.voiceId,
    billableCharacters: narration.metadata.billableCharacters,
    maximumEstimatedTtsCostUsd: Number(((narration.metadata.billableCharacters / 1_000_000) * 16).toFixed(6)),
  },
  output: { path: finalVideo, ...file.validation },
  mediaAcceptance,
};
await writeFile(join(outputRoot, "vision-acceptance-result.json"), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(result, null, 2));
