import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

import ffmpegStatic from "ffmpeg-static";

import { AppError } from "./errors.mjs";
import { probeMedia } from "./media-probe.mjs";
import { REFERENCE_VISION_PLAN_FORMAT, validateReferenceVisionPlan } from "./reference-vision-planner.mjs";
import {
  MAX_PRODUCTION_VARIANTS,
  SUPPORTED_ASPECT_RATIOS,
  isSupportedProductionLanguage,
  productionVariantCount,
} from "./production-contract.mjs";

const FORMAT = "seller.hypit-compiled@3";
const RECEIPT_FORMAT = "seller.commission-receipt@1";
const SOURCE_MANIFEST_FORMAT = "seller.input-source-manifest@1";
const TEXT_JSON_PREFIX = "seller-json-v1:";
const DIMENSIONS = Object.freeze({
  "9:16": { width: 540, height: 960 },
  "1:1": { width: 720, height: 720 },
  "16:9": { width: 960, height: 540 },
});
const DURATIONS = Object.freeze({
  creator_pitch: 16,
  proof_demo: 25,
  ranking_listicle: 20,
  two_person_podcast: 25.5,
});
const MAX_AUDIO_TEMPO_RATE = 1.25;
const AUDIO_TAIL_SECONDS = 0.4;
const MULTI_VOICE_LEAD_SECONDS = 0.4;
const VIDEO_FRAME_RATE = 30;

function snapToVideoFrame(seconds) {
  return Number((Math.round(seconds * VIDEO_FRAME_RATE) / VIDEO_FRAME_RATE).toFixed(6));
}

function productionTimelineSeconds(quote, referenceAdaptation) {
  if (referenceAdaptation !== null) {
    const sourceDuration = Number(referenceAdaptation.source?.durationSeconds);
    if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) {
      throw new AppError("reference_adaptation_manifest_mismatch", "Reference adaptation has no valid source duration", 503);
    }
    // Hypit's timeline author requires the program end to land exactly on a
    // frame. ffprobe commonly reports values such as 12.606s, so copying the
    // container duration verbatim can make an otherwise valid build fail.
    return snapToVideoFrame(Math.min(16, Math.max(8, sourceDuration)));
  }
  return snapToVideoFrame(DURATIONS[quote.product.id]
    ?? Math.max(1, Number(quote.product.durationSeconds?.[0] ?? 20)));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function inside(path, root) {
  const target = resolve(path);
  const boundary = resolve(root);
  return target === boundary || target.startsWith(`${boundary}/`);
}

function identifier(value) {
  const result = String(value).normalize("NFKD").replace(/[^a-zA-Z0-9-]+/gu, "-").replace(/^-+|-+$/gu, "").toLowerCase();
  return result === "" ? "value" : result.slice(0, 80);
}

function filenamePart(value) {
  return identifier(value).replace(/-+/gu, "-");
}

function text(value, fallback, maximum = 100) {
  const normalized = typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
  return (normalized === "" ? fallback : normalized).slice(0, maximum);
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function uniqueStrings(value, fallback, field) {
  const source = value === undefined ? fallback : value;
  if (!Array.isArray(source) || source.length === 0) {
    throw new AppError("commission_invalid", `${field} must be a non-empty array`, 502);
  }
  const values = [...new Set(source.map((item) => typeof item === "string" ? item.trim() : ""))];
  if (values.some((item) => item === "" || item.length > 24)) {
    throw new AppError("commission_invalid", `${field} contains an invalid value`, 502);
  }
  return values;
}

function variantMatrix(quote) {
  const hookVariants = quote.addOns?.hookVariants ?? 1;
  if (![1, 3, 5].includes(hookVariants)) {
    throw new AppError("commission_invalid", "hookVariants must be 1, 3, or 5", 502);
  }
  const languages = uniqueStrings(quote.addOns?.languages, ["en-US"], "languages");
  const invalidLanguage = languages.find((item) => !isSupportedProductionLanguage(item));
  if (invalidLanguage !== undefined) {
    throw new AppError("commission_invalid", `Unsupported production language tag: ${invalidLanguage}`, 502);
  }
  if (new Set(languages.map((item) => item.toLowerCase())).size !== languages.length) {
    throw new AppError("commission_invalid", "Production languages must be unique regardless of case", 502);
  }
  const aspectRatios = uniqueStrings(quote.addOns?.aspectRatios, ["9:16"], "aspectRatios");
  for (const ratio of aspectRatios) {
    if (DIMENSIONS[ratio] === undefined) {
      throw new AppError("production_aspect_ratio_unsupported", `Hypit production does not support aspect ratio ${ratio}`, 409, {
        supported: Object.keys(DIMENSIONS),
      });
    }
  }
  const count = productionVariantCount({ hookVariants, languages, aspectRatios });
  if (count > MAX_PRODUCTION_VARIANTS) {
    throw new AppError("production_variant_limit", `The purchased matrix contains ${count} videos; maximum is ${MAX_PRODUCTION_VARIANTS}`, 409);
  }
  return Array.from({ length: hookVariants }, (_, hookOffset) => languages.flatMap((language) => (
    aspectRatios.map((aspectRatio) => ({ hookIndex: hookOffset + 1, language, aspectRatio }))
  ))).flat();
}

function localizedLabel(language, productId) {
  const family = language.toLowerCase().split("-", 1)[0];
  const names = {
    creator_pitch: { en: "CREATOR PITCH", es: "PRESENTACIÓN CREADORA", zh: "创作者推荐" },
    proof_demo: { en: "PRODUCT SHOWCASE", es: "PRODUCTO EN ACCIÓN", zh: "产品展示" },
    ranking_listicle: { en: "TOP REASONS", es: "RAZONES CLAVE", zh: "核心亮点" },
    two_person_podcast: { en: "TWO VOICES", es: "DOS VOCES", zh: "双人对谈" },
  };
  return names[productId]?.[family] ?? names[productId]?.en ?? "PRODUCT STORY";
}

function copyFor(quote, hookIndex) {
  const brief = quote.brief ?? {};
  const productName = text(brief.productName ?? brief.subject, quote.product?.name ?? "Product", 90);
  const objective = text(brief.objective ?? brief.description, quote.product?.objectives?.[0] ?? "See what changes", 180);
  const suppliedHooks = Array.isArray(brief.hooks) ? brief.hooks : [];
  const hook = text(suppliedHooks[hookIndex - 1] ?? brief.hook, `${productName} · Hook ${hookIndex}`, 90);
  const items = (Array.isArray(brief.items) ? brief.items : [])
    .filter((item) => typeof item === "string" && item.trim() !== "")
    .slice(0, 3)
    .map((item) => text(item, "", 72));
  while (items.length < 3) {
    items.push([
      productName,
      objective,
      text(brief.cta, "See the product in action", 72),
    ][items.length]);
  }
  return { productName, objective, hook, items };
}

function encodedJson(value) {
  return `${TEXT_JSON_PREFIX}${Buffer.from(JSON.stringify(value), "utf8").toString("base64url")}`;
}

export function decodeHypitTextJson(value, subject = "Hypit JSON output") {
  if (typeof value !== "string" || !value.startsWith(TEXT_JSON_PREFIX)) {
    throw new AppError("hypit_json_output_invalid", `${subject} has an invalid encoding`, 502);
  }
  try {
    return JSON.parse(Buffer.from(value.slice(TEXT_JSON_PREFIX.length), "base64url").toString("utf8"));
  } catch {
    throw new AppError("hypit_json_output_invalid", `${subject} is not valid encoded JSON`, 502);
  }
}

function receiptSheet(id, payload) {
  return `<?svml using="@hypit/text/svs@1"?>

<sheet version="1" id="${id}">
  text-template.${id} { separator: paragraph; }
  text-template.${id}.block.payload {
    kind: fixed;
    order: 10;
    text: "${encodedJson(payload)}";
  }
</sheet>
`;
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function copyConfiguredAsset(rootDir, projectDir, path, label) {
  if (typeof path !== "string" || path.trim() === "") {
    throw new AppError("production_asset_missing", `${label} is not configured`, 503);
  }
  const source = resolve(rootDir, path);
  if (!inside(source, rootDir)) throw new AppError("production_asset_path_invalid", `${label} must stay inside the project`, 503);
  const extension = extname(source).toLowerCase() || ".bin";
  const destination = join(projectDir, "assets", `${filenamePart(label)}${extension}`);
  await copyFile(source, destination);
  return { source, destination, relative: `./assets/${basename(destination)}` };
}

async function imageExtent(path) {
  const details = await probeMedia(path);
  const stream = details.streams?.find((item) => item.codec_type === "video" && Number(item.width) > 0 && Number(item.height) > 0);
  if (stream === undefined) throw new AppError("production_asset_invalid", "Production image has no decodable visual stream", 503);
  return { width: Number(stream.width), height: Number(stream.height) };
}

async function audioDurations(assets) {
  return await Promise.all(assets.map(async (asset) => {
    const details = await probeMedia(asset.destination);
    const duration = Number(details.format?.duration);
    return Number.isFinite(duration) && duration > 0 ? duration : 1;
  }));
}

function ffmpeg(args, errorCode, message) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(ffmpegStatic, ["-nostdin", "-hide_banner", "-loglevel", "error", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-20_000); });
    child.once("error", (error) => reject(new AppError(errorCode, message, 503, { cause: error.message })));
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new AppError(errorCode, message, 503, { stderr: stderr.slice(-4000) }));
        return;
      }
      resolvePromise();
    });
  });
}

async function applyTempo(asset, rate) {
  const temporary = `${asset.destination}.tempo-${process.pid}.wav`;
  try {
    await ffmpeg([
      "-y", "-i", asset.destination,
      "-filter:a", `atempo=${rate.toFixed(6)}`,
      "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", "-f", "wav", temporary,
    ], "production_audio_adaptation_failed", "Could not adapt narration to the purchased video duration");
    await rename(temporary, asset.destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function normalizeGeneratedMotion(source, destination) {
  const temporary = `${destination}.normalizing-${process.pid}.mp4`;
  try {
    await ffmpeg([
      "-y", "-i", source,
      "-an",
      "-vf", "fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2",
      "-c:v", "libx264", "-profile:v", "main", "-pix_fmt", "yuv420p",
      "-g", "30", "-keyint_min", "30", "-sc_threshold", "0",
      "-movflags", "+faststart",
      temporary,
    ], "production_video_adaptation_failed", "Could not normalize generated motion for Hypit");
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

function even(value) {
  return Math.max(2, Math.floor(value / 2) * 2);
}

function referenceShotTimeline(plan, durationSeconds) {
  const totalWeight = plan.adaptation.shots.reduce((sum, shot) => sum + shot.durationWeight, 0);
  let cursor = 0;
  return plan.adaptation.shots.map((shot, index) => {
    const start = cursor;
    const end = index === plan.adaptation.shots.length - 1
      ? durationSeconds
      : Number((cursor + ((durationSeconds * shot.durationWeight) / totalWeight)).toFixed(3));
    cursor = end;
    return { ...shot, start, end };
  });
}

function cropForReferenceShot(source, target, shot) {
  const targetRatio = target.width / target.height;
  const sourceRatio = source.width / source.height;
  const fullWidth = sourceRatio > targetRatio ? even(source.height * targetRatio) : even(source.width);
  const fullHeight = sourceRatio > targetRatio ? even(source.height) : even(source.width / targetRatio);
  const scale = Math.min(1.38, Math.max(1, shot.cropScale));
  const width = even(fullWidth / scale);
  const height = even(fullHeight / scale);
  const centerX = Math.max(0.36, Math.min(0.64, shot.focusX)) * source.width;
  const centerY = Math.max(0.42, Math.min(0.68, shot.focusY)) * source.height;
  const x = even(Math.max(0, Math.min(source.width - width, centerX - (width / 2))));
  const y = even(Math.max(0, Math.min(source.height - height, centerY - (height / 2))));
  return { width, height, x, y };
}

async function prepareReferenceShotAssets({ projectDir, productAsset, productExtent, plan, aspectRatios }) {
  const result = new Map();
  for (const aspectRatio of aspectRatios) {
    const dimensions = DIMENSIONS[aspectRatio];
    const assets = [];
    for (const [index, shot] of plan.adaptation.shots.entries()) {
      const crop = cropForReferenceShot(productExtent, dimensions, shot);
      const ratioId = aspectRatio.replace(":", "x");
      const id = `reference-${ratioId}-shot-${index + 1}`;
      const destination = join(projectDir, "assets", `${id}.jpg`);
      await ffmpeg([
        "-y", "-i", productAsset.destination,
        "-vf", `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},scale=${dimensions.width}:${dimensions.height}:flags=lanczos`,
        "-frames:v", "1", "-q:v", "3", destination,
      ], "reference_shot_preparation_failed", "Could not prepare a Hypit reference-adaptation shot");
      assets.push({ id, destination, relative: `./assets/${basename(destination)}`, mediaType: "image/jpeg" });
    }
    result.set(aspectRatio, assets);
  }
  return result;
}

async function fitAudioToTimeline(audioAssets, timelineSeconds) {
  const originalLengths = await audioDurations(audioAssets);
  const leadSeconds = audioAssets.length > 1 ? MULTI_VOICE_LEAD_SECONDS : 0;
  const budgetSeconds = timelineSeconds - leadSeconds - AUDIO_TAIL_SECONDS;
  const originalTotalSeconds = originalLengths.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(budgetSeconds) || budgetSeconds <= 1) {
    throw new AppError("production_audio_budget_invalid", "Video timeline has no usable narration window", 503);
  }
  const requiredRate = originalTotalSeconds / budgetSeconds;
  if (requiredRate > MAX_AUDIO_TEMPO_RATE + 0.0001) {
    throw new AppError("production_audio_too_long", "Narration is too long for the purchased video format", 409, {
      timelineSeconds,
      budgetSeconds: Number(budgetSeconds.toFixed(3)),
      narrationSeconds: Number(originalTotalSeconds.toFixed(3)),
      requiredTempoRate: Number(requiredRate.toFixed(3)),
      maximumTempoRate: MAX_AUDIO_TEMPO_RATE,
    });
  }
  const tempoRate = requiredRate > 1.001 ? requiredRate : 1;
  if (tempoRate > 1) await Promise.all(audioAssets.map((asset) => applyTempo(asset, tempoRate)));
  const fittedLengths = tempoRate > 1 ? await audioDurations(audioAssets) : originalLengths;
  const fittedTotalSeconds = fittedLengths.reduce((sum, value) => sum + value, 0);
  if (fittedTotalSeconds > budgetSeconds + 0.12) {
    throw new AppError("production_audio_adaptation_failed", "Adapted narration still exceeds the video timeline", 503, {
      budgetSeconds: Number(budgetSeconds.toFixed(3)),
      fittedTotalSeconds: Number(fittedTotalSeconds.toFixed(3)),
    });
  }
  const compiledAudio = await Promise.all(audioAssets.map(async (asset, index) => ({
    id: asset.id,
    durationSeconds: Number(fittedLengths[index].toFixed(3)),
    sha256: sha256(await readFile(asset.destination)),
  })));
  return {
    audioLengths: fittedLengths,
    timing: {
      timelineSeconds,
      budgetSeconds: Number(budgetSeconds.toFixed(3)),
      originalTotalSeconds: Number(originalTotalSeconds.toFixed(3)),
      fittedTotalSeconds: Number(fittedTotalSeconds.toFixed(3)),
      tempoRate: Number(tempoRate.toFixed(6)),
      tailPaddingSeconds: Number(Math.max(0, budgetSeconds - fittedTotalSeconds).toFixed(3)),
      compiledAudio,
    },
  };
}

function assetDeclaration(tag, id, asset, mediaType) {
  const explicit = typeof mediaType === "string" ? ` media-type="${xml(mediaType)}"` : "";
  return `  <asset:${tag} id="${id}" src="${xml(asset.relative)}"${explicit}/>`;
}

function authorSource({
  quote, variants, receipt, sourceManifest, productAsset, productExtent, presenterAsset, presenterExtent,
  motionAsset, variantProductions, referenceAdaptation, referenceShotAssets, timelineSeconds,
}) {
  const productId = quote.product.id;
  const duration = timelineSeconds;
  const declaredAudio = [...new Map([...variantProductions.values()].flatMap((production) => (
    production.audioAssets.map((asset) => [asset.id, asset])
  ))).values()];
  const declarations = [
    assetDeclaration("Image", "product", productAsset, productAsset.mediaType),
    ...(presenterAsset === null ? [] : [assetDeclaration("Image", "presenter", presenterAsset, presenterAsset.mediaType)]),
    ...(motionAsset === null ? [] : [assetDeclaration("Video", "product-motion", motionAsset, motionAsset.mediaType)]),
    ...[...(referenceShotAssets?.values() ?? [])].flat().map((asset) => assetDeclaration("Image", asset.id, asset, asset.mediaType)),
    ...declaredAudio.map((asset) => assetDeclaration("Audio", asset.id, asset, asset.mediaType)),
  ].join("\n");
  const components = variants.map((variant) => {
    const key = `h${variant.hookIndex}-${identifier(variant.language)}-${variant.aspectRatio.replace(":", "x")}`;
    const ids = (name) => `${key}-${name}`;
    const dimensions = DIMENSIONS[variant.aspectRatio];
    const production = variantProductions.get(`${variant.hookIndex}:${variant.language.toLowerCase()}`);
    if (production === undefined) throw new AppError("production_input_variant_missing", "Production input variant is missing", 503);
    const { copy, audioAssets, audioLengths } = production;
    const referenceShots = referenceShotAssets === null ? null : referenceShotAssets.get(variant.aspectRatio);
    const referenceTimeline = referenceAdaptation === null ? null : referenceShotTimeline(referenceAdaptation.plan, duration);
    const presenterItem = presenterAsset === null || motionAsset !== null || referenceAdaptation !== null ? "" : `
    <media-track:Item id="${ids("presenter-shot")}" image={presenter} extent={${ids("presenter-size")}}
      during="program" frame={${ids("full")}} appearance={look.media.backdrop} motion={look.motion.backdrop}/>`;
    const motionEnd = motionAsset === null ? 0 : Math.min(duration, motionAsset.durationSeconds);
  const normalizedMotion = motionAsset === null ? "" : `
  <pipeline:Normalize id="${ids("product-motion-media")}" source={product-motion} clock={${ids("clock")}}
    video="primary-moving" audio="none" span-authority="video"/>`;
    const referenceVisualItems = referenceTimeline === null || referenceShots === null ? null : referenceTimeline.map((shot, index) => `
    <media-track:Item id="${ids(`reference-shot-${index + 1}`)}" image={${referenceShots[index].id}} extent={${ids("reference-size")}}
      start="${shot.start}s" end="${shot.end}s" frame={${ids("full")}} appearance={look.media.backdrop} motion={look.motion.${shot.motion.replaceAll("_", "-")}}/>`).join("");
    const visualItems = referenceVisualItems ?? (motionAsset === null ? `${presenterItem}
    <media-track:Item id="${ids("product-shot")}" image={product} extent={${ids("product-size")}}
      during="program" frame={${ids("product-card")}} appearance={look.media.product} motion={look.motion.card}/>` : `
    <media-track:Item id="${ids("generated-motion")}" media={${ids("product-motion-media")}.media}
      start="0s" end="${motionEnd}s" frame={${ids("full")}} appearance={look.media.backdrop}/>${motionEnd < duration ? `
    <media-track:Item id="${ids("product-endcard")}" image={product} extent={${ids("product-size")}}
      start="${motionEnd}s" end="${duration}s" frame={${ids("full")}} appearance={look.media.backdrop} motion={look.motion.backdrop}/>` : ""}`);
    let cursor = 0.4;
    const normalized = audioAssets.map((asset, index) => `  <pipeline:Normalize id="${ids(`voice-${index + 1}-media`)}" source={${asset.id}} clock={${ids("clock")}} video="none" audio="default" span-authority="audio"/>`).join("\n");
    const audioItems = audioAssets.map((_, index) => {
      if (audioAssets.length === 1) {
        return `    <audio:Item id="${ids("voice-item")}" source={${ids("voice-1-media")}.media} during="program" playback="once" gain="1" fade-in="2f" fade-out="6f"/>`;
      }
      const start = cursor;
      const end = Math.min(duration, start + audioLengths[index]);
      cursor = end;
      return `    <audio:Item id="${ids(`voice-item-${index + 1}`)}" source={${ids(`voice-${index + 1}-media`)}.media} start="${start.toFixed(2)}s" end="${end.toFixed(2)}s" playback="once" gain="1" fade-in="2f" fade-out="4f"/>`;
    }).join("\n");
    const itemWindow = duration / 3;
    const referenceCopyValues = [copy.hook, ...copy.items.slice(0, 3), copy.objective, copy.productName];
    const placement = { top: "title-frame", center: "center-frame", bottom: "caption-frame" };
    const referenceTextItems = referenceTimeline === null ? null : referenceTimeline.map((shot, index) => {
      const textStart = Math.min(shot.end - 0.08, shot.start + 0.08).toFixed(3);
      const textEnd = Math.max(Number(textStart) + 0.04, shot.end - 0.04).toFixed(3);
      const style = shot.emphasis === "hook" || shot.emphasis === "cta" ? "title-style" : "caption-style";
      return `    <typo:Area id="${ids(`reference-copy-${index + 1}`)}" placement={${ids(placement[shot.copyPlacement])}} style={${ids(style)}} motion={${ids("arrive")}} start="${textStart}s" end="${textEnd}s">${xml(referenceCopyValues[index] ?? copy.productName)}</typo:Area>`;
    }).join("\n");
    return `
  <space:Canvas id="${ids("canvas")}" width="${dimensions.width}" height="${dimensions.height}"/>
  <program:Clock id="${ids("clock")}" frame-rate="30"/>
  <time:Timeline id="${ids("program")}" clock={${ids("clock")}} end="${duration}s"/>
  <space:Frame id="${ids("full")}" within={${ids("canvas")}} left="0%" top="0%" right="100%" bottom="100%"/>
  <space:Frame id="${ids("product-card")}" within={${ids("canvas")}} left="${presenterAsset === null ? 8 : 58}%" top="${presenterAsset === null ? 30 : 34}%" right="94%" bottom="${presenterAsset === null ? 70 : 66}%"/>
  <space:Frame id="${ids("eyebrow-frame")}" within={${ids("canvas")}} left="6%" top="5%" right="94%" bottom="13%"/>
  <space:Frame id="${ids("title-frame")}" within={${ids("canvas")}} left="6%" top="13%" right="94%" bottom="31%"/>
  <space:Frame id="${ids("center-frame")}" within={${ids("canvas")}} left="6%" top="37%" right="94%" bottom="63%"/>
  <space:Frame id="${ids("caption-frame")}" within={${ids("canvas")}} left="6%" top="74%" right="94%" bottom="94%"/>
  <space:Extent id="${ids("product-size")}" width="${productExtent.width}" height="${productExtent.height}"/>${referenceShotAssets === null ? "" : `
  <space:Extent id="${ids("reference-size")}" width="${dimensions.width}" height="${dimensions.height}"/>`}${presenterAsset === null ? "" : `
  <space:Extent id="${ids("presenter-size")}" width="${presenterExtent.width}" height="${presenterExtent.height}"/>`}
${normalizedMotion}

  <media-track:Track id="${ids("visuals")}" timeline={${ids("program")}.timeline} canvas={${ids("canvas")}}>${visualItems}
  </media-track:Track>

  <fonts:Stack id="${ids("font")}" family="inter" weight="700" style="normal" emoji="color">
    <fonts:Fallback family="noto-sans-sc" weight="700" style="normal"/>
  </fonts:Stack>
  <typo:Style id="${ids("eyebrow-style")}" recipe={look.text.eyebrow} font={${ids("font")}}><typo:Fill color="#8ff1e8"/></typo:Style>
  <typo:Style id="${ids("title-style")}" recipe={look.text.card} font={${ids("font")}}><typo:Fill color="#ffffff"/><typo:Shadow color="#001718cc" x="0" y="5" blur="14"/></typo:Style>
  <typo:Style id="${ids("caption-style")}" recipe={look.text.caption} font={${ids("font")}}><typo:Fill color="#ffffff"/><typo:Box target="line" continuity="isolated" color="#063f43e8" padding="9 14" radius="12"/></typo:Style>
  <typo:Motion id="${ids("arrive")}"><typo:ItemKeyframe at="0" y="22" opacity="0"/><typo:ItemKeyframe at="10" y="0" opacity="1"/></typo:Motion>
  <typo:Track id="${ids("copy")}" timeline={${ids("program")}.timeline}>
${referenceTextItems ?? `    <typo:Area id="${ids("eyebrow")}" placement={${ids("eyebrow-frame")}} style={${ids("eyebrow-style")}} start="0.2s" end="${duration}s">${xml(localizedLabel(variant.language, productId))} · ${xml(variant.language.toUpperCase())} · H${variant.hookIndex}</typo:Area>
    <typo:Area id="${ids("headline")}" placement={${ids("title-frame")}} style={${ids("title-style")}} motion={${ids("arrive")}} start="0.4s" end="${Math.max(4, itemWindow).toFixed(2)}s">${xml(copy.hook)}</typo:Area>
    <typo:Area id="${ids("item-1")}" placement={${ids("caption-frame")}} style={${ids("caption-style")}} motion={${ids("arrive")}} start="${itemWindow.toFixed(2)}s" end="${(itemWindow * 1.67).toFixed(2)}s">${xml(copy.items[0])}</typo:Area>
    <typo:Area id="${ids("item-2")}" placement={${ids("caption-frame")}} style={${ids("caption-style")}} motion={${ids("arrive")}} start="${(itemWindow * 1.67).toFixed(2)}s" end="${(itemWindow * 2.34).toFixed(2)}s">${xml(copy.items[1])}</typo:Area>
    <typo:Area id="${ids("item-3")}" placement={${ids("caption-frame")}} style={${ids("caption-style")}} motion={${ids("arrive")}} start="${(itemWindow * 2.34).toFixed(2)}s" end="${duration}s">${xml(copy.items[2])}</typo:Area>`}
  </typo:Track>

${normalized}
  <audio:Track id="${ids("voices")}" timeline={${ids("program")}.timeline}>
${audioItems}
  </audio:Track>

  <film:Film id="${ids("film")}" canvas={${ids("canvas")}} timeline={${ids("program")}.timeline} appearance={look.film.vertical}>
    <film:Track source={${ids("visuals")}.visual}/><film:Track source={${ids("copy")}.track}/><film:Track source={${ids("voices")}.audio}/>
  </film:Film>
  <render:Video id="video-${key}" composition={${ids("film")}.composition} timeline={${ids("program")}.timeline}/>`;
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
  <import as="text" from="@hypit/text@1"/>
  <import as="look" source="./look.svs"/>
  <import as="receipt-data" source="./receipt.svs"/>
  ${sourceManifest === null ? "" : '<import as="source-data" source="./source-manifest.svs"/>'}

${declarations}
  <text:Render id="commission-receipt" template={receipt-data.receipt}/>
  ${sourceManifest === null ? "" : '<text:Render id="input-source-manifest" template={source-data.source-manifest}/>'}
${components}
</svml>
`;
}

export async function compileCommissionProject({
  rootDir, jobDir, workflow, order, quote, commissionPath,
  productionInputs = null, generatedVideo = null, referenceAdaptation = null,
}) {
  const manifestPath = join(jobDir, "production-manifest.json");
  const commissionBytes = await readFile(commissionPath);
  const commissionSha256 = sha256(commissionBytes);
  if (await exists(manifestPath)) {
    const existing = JSON.parse(await readFile(manifestPath, "utf8"));
    if (existing.format !== FORMAT || existing.orderId !== order.id || existing.productId !== quote.product.id
      || existing.commissionSha256 !== commissionSha256
      || existing.productionInputsSha256 !== (productionInputs?.manifestSha256 ?? null)
      || existing.videoInputSha256 !== (generatedVideo?.output?.sha256 ?? null)
      || existing.referenceAdaptationSha256 !== (referenceAdaptation?.manifestSha256 ?? null)) {
      throw new AppError("production_manifest_mismatch", "Existing compiled production is not bound to this commission", 503);
    }
    if (existing.projectDirectory !== "hypit-project" || existing.run !== "run.svrun"
      || existing.sourceSha256 === null || typeof existing.sourceSha256 !== "object") {
      throw new AppError("production_manifest_invalid", "Compiled production manifest has invalid source metadata", 503);
    }
    const existingProject = join(jobDir, existing.projectDirectory);
    for (const [relative, expected] of Object.entries(existing.sourceSha256)) {
      const path = resolve(existingProject, relative);
      if (!inside(path, existingProject) || sha256(await readFile(path)) !== expected) {
        throw new AppError("production_source_digest_mismatch", "Compiled Hypit source changed after commission compilation", 503, { file: relative });
      }
    }
    return existing;
  }
  let commission;
  try { commission = JSON.parse(commissionBytes); } catch {
    throw new AppError("production_commission_invalid", "Durable production commission is invalid JSON", 503);
  }
  if (commission.order?.id !== order.id || commission.quote?.product?.id !== quote.product.id) {
    throw new AppError("production_commission_mismatch", "Durable commission does not match the paid order", 503);
  }
  if (referenceAdaptation !== null) {
    const evidence = Object.values(commission.localAssets ?? {}).find((item) => item?.mediaType?.startsWith("video/"));
    const productImage = Object.values(commission.localAssets ?? {}).find((item) => item?.mediaType?.startsWith("image/"));
    if (referenceAdaptation.format !== REFERENCE_VISION_PLAN_FORMAT
      || referenceAdaptation.orderId !== order.id || referenceAdaptation.productId !== quote.product.id
      || referenceAdaptation.commissionSha256 !== commissionSha256
      || typeof referenceAdaptation.manifestSha256 !== "string"
      || referenceAdaptation.inputs?.referenceSha256 !== evidence?.sha256
      || referenceAdaptation.inputs?.productSha256 !== productImage?.sha256) {
      throw new AppError("reference_adaptation_manifest_mismatch", "Reference adaptation is not bound to this commission", 503);
    }
    referenceAdaptation.plan = validateReferenceVisionPlan(referenceAdaptation.plan);
  }
  const paidQuote = commission.quote;
  const variants = variantMatrix(paidQuote);
  const projectDir = join(jobDir, "hypit-project");
  await mkdir(join(projectDir, "assets"), { recursive: true, mode: 0o700 });
  const productionAssets = workflow.productionAssets ?? {};
  const configuredProduct = await copyConfiguredAsset(rootDir, projectDir, productionAssets.product, "product");
  let productAsset = { ...configuredProduct, mediaType: null };
  const localImages = Object.values(commission.localAssets ?? {}).filter((item) => item?.mediaType?.startsWith("image/"));
  if (localImages.length > 0) {
    const selected = localImages[0];
    if (!inside(selected.path, jobDir)) throw new AppError("production_asset_path_invalid", "Localized customer asset escaped the order directory", 503);
    const bytes = await readFile(selected.path);
    if (sha256(bytes) !== selected.sha256) throw new AppError("production_asset_digest_mismatch", "Localized customer asset changed after commission creation", 503);
    const extension = extname(selected.filename) || ".img";
    const destination = join(projectDir, "assets", `customer-product${extension}`);
    await copyFile(selected.path, destination);
    productAsset = { source: selected.path, destination, relative: `./assets/${basename(destination)}`, mediaType: selected.mediaType };
  }
  const presenterAsset = typeof productionAssets.presenter === "string"
    ? { ...(await copyConfiguredAsset(rootDir, projectDir, productionAssets.presenter, "presenter")), mediaType: null }
    : null;
  let motionAsset = null;
  if (generatedVideo !== null) {
    if (generatedVideo.format !== "seller.google-veo-input@1" || generatedVideo.orderId !== order.id
      || generatedVideo.productId !== quote.product.id || generatedVideo.commissionSha256 !== commissionSha256
      || typeof generatedVideo.output?.path !== "string" || typeof generatedVideo.output?.sha256 !== "string") {
      throw new AppError("production_video_input_mismatch", "Generated video is not bound to this commission", 503);
    }
    const source = resolve(generatedVideo.output.path);
    if (!inside(source, jobDir)) throw new AppError("production_asset_path_invalid", "Generated video escaped the order directory", 503);
    const bytes = await readFile(source);
    if (sha256(bytes) !== generatedVideo.output.sha256) throw new AppError("production_video_input_digest_mismatch", "Generated video changed before compilation", 503);
    const destination = join(projectDir, "assets", "customer-motion.mp4");
    await normalizeGeneratedMotion(source, destination);
    motionAsset = {
      source,
      destination,
      relative: `./assets/${basename(destination)}`,
      mediaType: generatedVideo.output.mediaType ?? "video/mp4",
      durationSeconds: Number(generatedVideo.output.durationSeconds ?? 8),
      provider: generatedVideo.provider,
      model: generatedVideo.model,
      sha256: generatedVideo.output.sha256,
    };
  }
  const variantProductions = new Map();
  const allAudioAssets = [];
  const timelineSeconds = productionTimelineSeconds(paidQuote, referenceAdaptation);
  if (productionInputs !== null) {
    if (productionInputs.orderId !== order.id || productionInputs.productId !== quote.product.id
      || productionInputs.commissionSha256 !== commissionSha256 || typeof productionInputs.manifestSha256 !== "string") {
      throw new AppError("production_input_manifest_mismatch", "Prepared production inputs are not bound to this commission", 503);
    }
    const inputRoot = resolve(jobDir, "production-inputs");
    for (const item of productionInputs.variants ?? []) {
      const key = `${item.hookIndex}:${String(item.language).toLowerCase()}`;
      if (variantProductions.has(key) || !Array.isArray(item.audio) || item.audio.length === 0) {
        throw new AppError("production_input_manifest_invalid", `Prepared production input ${key} is invalid`, 503);
      }
      const audioAssets = [];
      for (const [index, audio] of item.audio.entries()) {
        const source = resolve(inputRoot, audio.file);
        if (!inside(source, inputRoot)) throw new AppError("production_asset_path_invalid", "Prepared audio escaped the order directory", 503);
        const bytes = await readFile(source);
        if (sha256(bytes) !== audio.sha256) throw new AppError("production_input_digest_mismatch", "Prepared audio changed before compilation", 503, { file: audio.file });
        const extension = extname(source).toLowerCase() || ".wav";
        const id = `voice-h${item.hookIndex}-${identifier(item.language)}-${index + 1}`;
        const destination = join(projectDir, "assets", `${id}${extension}`);
        await copyFile(source, destination);
        const asset = { id, source, destination, relative: `./assets/${basename(destination)}`, mediaType: audio.mediaType ?? "audio/wav" };
        audioAssets.push(asset);
        allAudioAssets.push(asset);
      }
      const fitted = await fitAudioToTimeline(audioAssets, timelineSeconds);
      variantProductions.set(key, {
        copy: {
          productName: text(paidQuote.brief?.productName ?? paidQuote.brief?.subject, paidQuote.product.name ?? "Product", 90),
          objective: text(paidQuote.brief?.objective ?? paidQuote.brief?.description, paidQuote.product.objectives?.[0] ?? "See what changes", 180),
          hook: text(item.headline, "Product story", 100),
          items: item.items.map((value) => text(value, "Product detail", 90)),
        },
        audioAssets,
        ...fitted,
      });
    }
    for (const variant of variants) {
      if (!variantProductions.has(`${variant.hookIndex}:${variant.language.toLowerCase()}`)) {
        throw new AppError("production_input_variant_missing", `Prepared production input is missing h${variant.hookIndex}/${variant.language}`, 503);
      }
    }
  } else {
    const audioPaths = Array.isArray(productionAssets.audio) ? productionAssets.audio : [productionAssets.audio].filter(Boolean);
    if (audioPaths.length === 0) throw new AppError("production_asset_missing", "At least one production voice fixture is required", 503);
    const audioAssets = await Promise.all(audioPaths.map(async (path, index) => ({
      ...(await copyConfiguredAsset(rootDir, projectDir, path, `voice-${index + 1}`)), id: `voice-${index + 1}`, mediaType: null,
    })));
    allAudioAssets.push(...audioAssets);
    const fitted = await fitAudioToTimeline(audioAssets, timelineSeconds);
    for (const variant of variants) {
      variantProductions.set(`${variant.hookIndex}:${variant.language.toLowerCase()}`, {
        copy: copyFor(paidQuote, variant.hookIndex), audioAssets, ...fitted,
      });
    }
  }
  const [productExtent, presenterExtent] = await Promise.all([
    imageExtent(productAsset.destination),
    presenterAsset === null ? Promise.resolve(null) : imageExtent(presenterAsset.destination),
  ]);
  const referenceShotAssets = referenceAdaptation === null || motionAsset !== null ? null : await prepareReferenceShotAssets({
    projectDir,
    productAsset,
    productExtent,
    plan: referenceAdaptation.plan,
    aspectRatios: [...new Set(variants.map((variant) => variant.aspectRatio))],
  });
  const localAssetEvidence = Object.entries(commission.localAssets ?? {}).map(([name, value]) => ({
    name,
    filename: value.filename,
    mediaType: value.mediaType,
    bytes: value.bytes,
    sha256: value.sha256,
    sourceHost: value.sourceHost,
  }));
  const sourceLinkEvidence = Object.entries(commission.sourceLinks ?? {}).map(([name, value]) => ({
    name,
    url: value.url,
    sourceHost: value.sourceHost,
    sourcePlatform: value.sourcePlatform,
    status: value.status,
    fetchErrorCode: value.fetchErrorCode,
  }));
  const outputs = variants.map((variant) => {
    const key = `h${variant.hookIndex}-${identifier(variant.language)}-${variant.aspectRatio.replace(":", "x")}`;
    return {
      output: `video-${key}.video`,
      filename: `${filenamePart(quote.product.id)}-${key}.mp4`,
      mediaType: "video/mp4",
      specification: {
        ...variant,
        durationSeconds: timelineSeconds,
        referenceGuided: referenceAdaptation !== null,
        maxContinuousFreezeSeconds: referenceAdaptation === null ? null : 2,
      },
    };
  });
  const receipt = {
    format: RECEIPT_FORMAT,
    orderId: order.id,
    productId: quote.product.id,
    commissionSha256,
    variantCount: outputs.length,
    variants: outputs.map((item) => ({ output: item.output, ...item.specification })),
    localAssets: localAssetEvidence,
    sourceLinks: sourceLinkEvidence,
    productionInputs: productionInputs === null ? null : {
      format: productionInputs.format,
      manifestSha256: productionInputs.manifestSha256,
      copyProvider: productionInputs.copy?.provider ?? null,
      copyModel: productionInputs.copy?.model ?? null,
      voiceProvider: productionInputs.voice?.provider ?? null,
      commercialUseApproved: productionInputs.voice?.commercialUseApproved === true,
      requirementsSatisfied: productionInputs.voice?.requirementsSatisfied === true,
      billableCharacters: productionInputs.voice?.billableCharacters ?? null,
      creativeRequirements: productionInputs.creativeRequirements,
      variants: productionInputs.variants.map((item) => ({
        hookIndex: item.hookIndex,
        language: item.language,
        headlineSha256: sha256(Buffer.from(item.headline)),
        voiceScriptSha256: sha256(Buffer.from(item.voiceScript)),
        audio: item.audio.map((audio) => ({
          role: audio.role,
          sha256: audio.sha256,
          provider: audio.provider,
          voiceId: audio.voiceId,
          requestedVoice: audio.requestedVoice,
          requirementsApplied: audio.requirementsApplied === true,
          appliedVoice: audio.appliedVoice ?? null,
          billableCharacters: audio.billableCharacters ?? null,
        })),
        timing: variantProductions.get(`${item.hookIndex}:${item.language.toLowerCase()}`).timing,
      })),
    },
    videoGeneration: motionAsset === null ? null : {
      provider: motionAsset.provider,
      model: motionAsset.model,
      sha256: motionAsset.sha256,
      durationSeconds: motionAsset.durationSeconds,
      mediaType: motionAsset.mediaType,
      generationCount: generatedVideo?.generationCount ?? 1,
      segments: (generatedVideo?.segments ?? []).map((item) => ({
        index: item.index,
        sha256: item.sha256,
        durationSeconds: item.durationSeconds,
      })),
    },
    referenceAdaptation: referenceAdaptation === null ? null : {
      provider: referenceAdaptation.provider,
      model: referenceAdaptation.model,
      sourceVideoSha256: referenceAdaptation.inputs.referenceSha256,
      productImageSha256: referenceAdaptation.inputs.productSha256,
      sourceDurationSeconds: referenceAdaptation.source.durationSeconds,
      sourceFrameRate: referenceAdaptation.source.frameRate,
      boundaryTimes: referenceAdaptation.source.boundaryTimes,
      samplingTimes: referenceAdaptation.sampling,
      visualGrammar: referenceAdaptation.plan.reference.visualGrammar,
      subjectFraming: referenceAdaptation.plan.reference.subjectFraming,
      actionSequence: referenceAdaptation.plan.reference.actionSequence,
      pacing: referenceAdaptation.plan.reference.pacing,
      transitionMoment: referenceAdaptation.plan.reference.transitionMoment,
      strategy: referenceAdaptation.plan.adaptation.strategy,
      renderMode: motionAsset === null ? "hypit-image-shots" : (generatedVideo?.generationCount === 2
        ? "veo-two-segment-continuation"
        : "veo-guided-motion"),
      renderedShots: (motionAsset === null ? referenceShotTimeline(referenceAdaptation.plan, timelineSeconds) : []).map((shot) => ({
        start: shot.start,
        end: shot.end,
        motion: shot.motion,
        copyPlacement: shot.copyPlacement,
        emphasis: shot.emphasis,
      })),
    },
  };
  const sourceManifest = paidQuote.addOns?.inputSourceManifest === true ? {
    format: SOURCE_MANIFEST_FORMAT,
    orderId: order.id,
    productId: quote.product.id,
    commissionSha256,
    claims: (Array.isArray(paidQuote.brief?.items) ? paidQuote.brief.items : []).filter((item) => typeof item === "string").slice(0, 20),
    sources: [...localAssetEvidence, ...sourceLinkEvidence],
  } : null;
  const lookSource = resolve(rootDir, productionAssets.look ?? "productions/look.svs");
  if (!inside(lookSource, rootDir)) throw new AppError("production_asset_path_invalid", "Production look must stay inside the project", 503);
  await Promise.all([
    copyFile(lookSource, join(projectDir, "look.svs")),
    writeFile(join(projectDir, "receipt.svs"), receiptSheet("receipt", receipt), { mode: 0o600 }),
    ...(sourceManifest === null ? [] : [writeFile(join(projectDir, "source-manifest.svs"), receiptSheet("source-manifest", sourceManifest), { mode: 0o600 })]),
  ]);
  const author = authorSource({
    quote: paidQuote, variants, receipt, sourceManifest, productAsset, productExtent, presenterAsset,
    presenterExtent, motionAsset, variantProductions, referenceAdaptation, referenceShotAssets, timelineSeconds,
  });
  const targets = [...outputs.map((item) => item.output), "commission-receipt", ...(sourceManifest === null ? [] : ["input-source-manifest"])];
  const run = `<?svml using="@hypit/run-markup@1"?>
<svrun version="1">
  <author source="./author.svml"/>
${targets.map((output) => `  <target output="${output}"/>`).join("\n")}
</svrun>
`;
  const deliverables = [...outputs, ...(sourceManifest === null ? [] : [{
    output: "input-source-manifest",
    filename: `${filenamePart(quote.product.id)}-input-source-manifest.json`,
    mediaType: "application/json",
    encoding: "hypit-text-base64-json",
    specification: { kind: "input_source_manifest" },
  }])];
  await Promise.all([
    writeFile(join(projectDir, "author.svml"), author, { mode: 0o600 }),
    writeFile(join(projectDir, "run.svrun"), run, { mode: 0o600 }),
  ]);
  const sourceFiles = [
    "author.svml",
    "run.svrun",
    "receipt.svs",
    "look.svs",
    ...(sourceManifest === null ? [] : ["source-manifest.svs"]),
    productAsset.relative.replace(/^\.\//u, ""),
    ...(presenterAsset === null ? [] : [presenterAsset.relative.replace(/^\.\//u, "")]),
    ...(motionAsset === null ? [] : [motionAsset.relative.replace(/^\.\//u, "")]),
    ...[...(referenceShotAssets?.values() ?? [])].flat().map((asset) => asset.relative.replace(/^\.\//u, "")),
    ...allAudioAssets.map((asset) => asset.relative.replace(/^\.\//u, "")),
  ];
  const sourceSha256 = Object.fromEntries(await Promise.all(sourceFiles.map(async (relative) => (
    [relative, sha256(await readFile(join(projectDir, relative)))]
  ))));
  const manifest = {
    format: FORMAT,
    orderId: order.id,
    productId: quote.product.id,
    commissionSha256,
    productionInputsSha256: productionInputs?.manifestSha256 ?? null,
    videoInputSha256: generatedVideo?.output?.sha256 ?? null,
    referenceAdaptationSha256: referenceAdaptation?.manifestSha256 ?? null,
    projectDirectory: "hypit-project",
    run: "run.svrun",
    deliverables,
    commissionReceiptOutput: "commission-receipt",
    receiptEncoding: "hypit-text-base64-json",
    variantCount: outputs.length,
    audioTiming: [...variantProductions.entries()].map(([key, value]) => ({ key, ...value.timing })),
    sourceSha256,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return manifest;
}

export const COMMISSION_COMPILER_LIMITS = Object.freeze({
  maxVariants: MAX_PRODUCTION_VARIANTS,
  aspectRatios: SUPPORTED_ASPECT_RATIOS,
});
