import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

import ffmpegStatic from "ffmpeg-static";

import { AppError } from "./errors.mjs";
import { probeMedia } from "./media-probe.mjs";

function analyze(path, args, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegStatic, ["-nostdin", "-hide_banner", "-nostats", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-1_000_000); });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new AppError("media_quality_scan_failed", "Could not start media quality analysis", 502, { cause: error.message }));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new AppError("media_quality_scan_failed", "Media quality analysis failed", 502, { stderr: stderr.slice(-4000) }));
        return;
      }
      resolve(stderr);
    });
  });
}

function fileSha256(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}

async function audioQuality(path, file, stream) {
  const log = await analyze(path, ["-loglevel", "info", "-i", path, "-map", "0:a:0", "-af", "volumedetect", "-f", "null", "-"]);
  const match = /mean_volume:\s*(-?inf|-?\d+(?:\.\d+)?)\s*dB/iu.exec(log);
  const meanVolumeDb = match === null || match[1].toLowerCase().includes("inf") ? Number.NEGATIVE_INFINITY : Number(match[1]);
  if (!Number.isFinite(meanVolumeDb) || meanVolumeDb < -55) {
    throw new AppError("deliverable_audio_silent", "Delivered video has no usable narration audio", 502, {
      file: file.name,
      meanVolumeDb: Number.isFinite(meanVolumeDb) ? meanVolumeDb : null,
    });
  }
  return {
    codec: stream.codec_name ?? null,
    channels: Number(stream.channels) || null,
    sampleRate: Number(stream.sample_rate) || null,
    meanVolumeDb,
  };
}

async function visualQuality(path, file, duration, { maxContinuousFreezeSeconds = null } = {}) {
  const log = await analyze(path, [
    "-loglevel", "info", "-i", path,
    "-map", "0:v:0", "-vf", "blackdetect=d=0.5:pix_th=0.10,freezedetect=n=-50dB:d=2",
    "-an", "-f", "null", "-",
  ]);
  const blackSeconds = [...log.matchAll(/black_duration:([0-9]+(?:\.[0-9]+)?)/gu)]
    .reduce((sum, match) => sum + Number(match[1]), 0);
  const freezeDurations = [...log.matchAll(/freeze_duration:\s*([0-9]+(?:\.[0-9]+)?)/gu)]
    .map((match) => Number(match[1]));
  let freezeSeconds = freezeDurations.reduce((sum, value) => sum + value, 0);
  let longestFreezeSeconds = freezeDurations.length === 0 ? 0 : Math.max(...freezeDurations);
  const freezeStarts = [...log.matchAll(/freeze_start:\s*([0-9]+(?:\.[0-9]+)?)/gu)].map((match) => Number(match[1]));
  const freezeEnds = [...log.matchAll(/freeze_end:\s*([0-9]+(?:\.[0-9]+)?)/gu)].map((match) => Number(match[1]));
  const lastStart = freezeStarts.at(-1);
  const lastEnd = freezeEnds.at(-1);
  if (lastStart !== undefined && (lastEnd === undefined || lastStart > lastEnd)) {
    const trailingFreeze = Math.max(0, duration - lastStart);
    freezeSeconds += trailingFreeze;
    longestFreezeSeconds = Math.max(longestFreezeSeconds, trailingFreeze);
  }
  const blackRatio = Math.min(1, blackSeconds / duration);
  const freezeRatio = Math.min(1, freezeSeconds / duration);
  if (blackRatio >= 0.8) {
    throw new AppError("deliverable_video_black", "Delivered video is predominantly black", 502, {
      file: file.name, blackSeconds: Number(blackSeconds.toFixed(3)), duration,
    });
  }
  if (freezeRatio >= 0.85) {
    throw new AppError("deliverable_video_frozen", "Delivered video is predominantly frozen", 502, {
      file: file.name, freezeSeconds: Number(freezeSeconds.toFixed(3)), duration,
    });
  }
  if (Number.isFinite(maxContinuousFreezeSeconds) && maxContinuousFreezeSeconds > 0
    && longestFreezeSeconds > maxContinuousFreezeSeconds) {
    throw new AppError("deliverable_video_static_hold", "Reference-guided video contains an overlong static hold", 502, {
      file: file.name,
      longestFreezeSeconds: Number(longestFreezeSeconds.toFixed(3)),
      maximumSeconds: maxContinuousFreezeSeconds,
    });
  }
  return {
    blackSeconds: Number(blackSeconds.toFixed(3)),
    blackRatio: Number(blackRatio.toFixed(4)),
    freezeSeconds: Number(freezeSeconds.toFixed(3)),
    freezeRatio: Number(freezeRatio.toFixed(4)),
    longestFreezeSeconds: Number(longestFreezeSeconds.toFixed(3)),
  };
}

function ratioValue(value) {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/u.exec(value ?? "");
  if (match === null || Number(match[2]) === 0) return null;
  return Number(match[1]) / Number(match[2]);
}

export async function validateCampaignDeliverables({ files, quote }) {
  const requested = quote.addOns ?? { hookVariants: 1, languages: ["en-US"], aspectRatios: ["9:16"], inputSourceManifest: false };
  const hookVariants = requested.hookVariants ?? 1;
  const languages = requested.languages ?? ["en-US"];
  const aspectRatios = requested.aspectRatios ?? ["9:16"];
  const expectedVideos = hookVariants * languages.length * aspectRatios.length;
  const videos = files.filter((item) => item.mediaType?.startsWith("video/"));
  if (videos.length !== expectedVideos) {
    throw new AppError("deliverable_count_mismatch", "Delivered video count does not match the purchased variants", 502, {
      expectedVideos,
      receivedVideos: videos.length,
    });
  }
  const coverage = new Set();
  const contentDigests = new Map();
  const [minimumDuration, maximumDuration] = quote.product?.durationSeconds ?? [1, 600];
  for (const file of videos) {
    const details = await probeMedia(file.absolutePath);
    const stream = details.streams?.find((item) => item.codec_type === "video");
    const audioStream = details.streams?.find((item) => item.codec_type === "audio");
    const duration = Number(details.format?.duration);
    const specification = file.specification ?? {};
    const specifiedDuration = Number(specification.durationSeconds);
    const expectedDuration = Number.isFinite(specifiedDuration) && specifiedDuration > 0
      ? [specifiedDuration, specifiedDuration]
      : [minimumDuration, maximumDuration];
    if (!stream || !Number.isFinite(duration) || duration < expectedDuration[0] - 1 || duration > expectedDuration[1] + 1) {
      throw new AppError("deliverable_spec_mismatch", "Delivered video duration or stream does not match the purchased package", 502, {
        file: file.name,
        duration: Number.isFinite(duration) ? duration : null,
        expectedDurationSeconds: expectedDuration,
      });
    }
    if (audioStream === undefined) {
      throw new AppError("deliverable_audio_missing", "Delivered video has no audio stream", 502, { file: file.name });
    }
    const aspectRatio = specification.aspectRatio ?? (aspectRatios.length === 1 ? aspectRatios[0] : null);
    const language = specification.language ?? (languages.length === 1 ? languages[0] : null);
    const hookIndex = specification.hookIndex ?? (hookVariants === 1 ? 1 : null);
    if (aspectRatio === null || language === null || !Number.isSafeInteger(hookIndex)
      || !aspectRatios.includes(aspectRatio) || !languages.includes(language)
      || hookIndex < 1 || hookIndex > hookVariants) {
      throw new AppError("deliverable_spec_missing", "Each paid variant must declare its hook, language, and aspect ratio", 502, {
        file: file.name,
      });
    }
    const expectedRatio = ratioValue(aspectRatio);
    const actualRatio = Number(stream.width) / Number(stream.height);
    if (expectedRatio === null || !Number.isFinite(actualRatio) || Math.abs(actualRatio - expectedRatio) / expectedRatio > 0.03) {
      throw new AppError("deliverable_spec_mismatch", "Delivered video dimensions do not match the purchased aspect ratio", 502, {
        file: file.name,
        width: stream.width,
        height: stream.height,
        aspectRatio,
      });
    }
    const key = `${hookIndex}:${language}:${aspectRatio}`;
    if (coverage.has(key)) throw new AppError("deliverable_variant_duplicate", "Delivered variants contain a duplicate specification", 502, { key });
    coverage.add(key);
    const digest = await fileSha256(file.absolutePath);
    if (typeof file.sha256 === "string" && file.sha256 !== digest) {
      throw new AppError("deliverable_digest_mismatch", "Delivered video changed before quality validation", 502, { file: file.name });
    }
    const duplicate = contentDigests.get(digest);
    if (duplicate !== undefined) {
      throw new AppError("deliverable_content_duplicate", "Two purchased variants contain the exact same video file", 502, {
        file: file.name, duplicateOf: duplicate,
      });
    }
    contentDigests.set(digest, file.name);
    const [audio, visual] = await Promise.all([
      audioQuality(file.absolutePath, file, audioStream),
      visualQuality(file.absolutePath, file, duration, {
        maxContinuousFreezeSeconds: Number(specification.maxContinuousFreezeSeconds),
      }),
    ]);
    file.validation = {
      durationSeconds: duration,
      width: stream.width,
      height: stream.height,
      format: details.format?.format_name ?? null,
      sha256: digest,
      audio,
      visual,
      specification: { hookIndex, language, aspectRatio },
    };
  }
  if (requested.inputSourceManifest === true
    && !files.some((item) => item.specification?.kind === "input_source_manifest" && item.mediaType === "application/json")) {
    throw new AppError("input_source_manifest_missing", "The purchased Input Source Manifest was not delivered", 502);
  }
  return {
    expectedVideos,
    validatedVideos: videos.length,
    coverage: [...coverage],
    qualityChecks: [
      "audio_stream", "audibility", "black_frame_ratio", "freeze_ratio",
      "continuous_static_hold", "duplicate_content",
    ],
  };
}
