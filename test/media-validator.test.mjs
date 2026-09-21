import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import ffmpegStatic from "ffmpeg-static";

import { validateCampaignDeliverables } from "../src/media-validator.mjs";

const execFileAsync = promisify(execFile);

function quote({ hookVariants = 1 } = {}) {
  return {
    product: { durationSeconds: [2, 4] },
    addOns: { hookVariants, languages: ["en"], aspectRatios: ["9:16"], inputSourceManifest: false },
  };
}

async function render(kind) {
  const directory = await mkdtemp(join(tmpdir(), "media-quality-"));
  const path = join(directory, `${kind}.mp4`);
  const visual = kind === "black" ? "color=c=black:size=320x568:rate=24:duration=3"
    : kind === "frozen" ? "color=c=blue:size=320x568:rate=24:duration=3"
      : kind === "static-tail" ? "testsrc2=size=320x568:rate=24:duration=1,tpad=stop_mode=clone:stop_duration=2"
      : "testsrc2=size=320x568:rate=24:duration=3";
  const args = ["-nostdin", "-y", "-f", "lavfi", "-i", visual];
  if (kind !== "no-audio") {
    args.push("-f", "lavfi", "-i", kind === "silent"
      ? "anullsrc=channel_layout=mono:sample_rate=48000"
      : "sine=frequency=600:sample_rate=48000:duration=3");
  }
  args.push("-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p");
  if (kind !== "no-audio") args.push("-c:a", "aac");
  args.push(path);
  await execFileAsync(ffmpegStatic, args, { maxBuffer: 2 * 1024 * 1024 });
  return path;
}

function file(path, hookIndex = 1) {
  return {
    name: `h${hookIndex}.mp4`,
    absolutePath: path,
    mediaType: "video/mp4",
    specification: { hookIndex, language: "en", aspectRatio: "9:16" },
  };
}

test("media validator records audio and visual quality evidence", async () => {
  const path = await render("valid");
  const input = file(path);
  const result = await validateCampaignDeliverables({ files: [input], quote: quote() });
  assert.equal(result.validatedVideos, 1);
  assert.ok(result.qualityChecks.includes("audibility"));
  assert.ok(input.validation.audio.meanVolumeDb > -55);
  assert.ok(input.validation.visual.blackRatio < 0.8);
  assert.ok(input.validation.visual.freezeRatio < 0.85);
  assert.match(input.validation.sha256, /^[a-f0-9]{64}$/u);
});

test("media validator rejects missing and silent audio", async () => {
  const noAudio = await render("no-audio");
  await assert.rejects(
    validateCampaignDeliverables({ files: [file(noAudio)], quote: quote() }),
    (error) => error.code === "deliverable_audio_missing",
  );
  const silent = await render("silent");
  await assert.rejects(
    validateCampaignDeliverables({ files: [file(silent)], quote: quote() }),
    (error) => error.code === "deliverable_audio_silent",
  );
});

test("media validator rejects predominantly black or frozen video", async () => {
  const black = await render("black");
  await assert.rejects(
    validateCampaignDeliverables({ files: [file(black)], quote: quote() }),
    (error) => error.code === "deliverable_video_black",
  );
  const frozen = await render("frozen");
  await assert.rejects(
    validateCampaignDeliverables({ files: [file(frozen)], quote: quote() }),
    (error) => error.code === "deliverable_video_frozen",
  );
});

test("reference-guided delivery rejects a continuous static hold over its stricter limit", async () => {
  const path = await render("static-tail");
  const input = file(path);
  input.specification.maxContinuousFreezeSeconds = 1.5;
  await assert.rejects(
    validateCampaignDeliverables({ files: [input], quote: quote() }),
    (error) => error.code === "deliverable_video_static_hold",
  );
});

test("media validator rejects exact duplicate files sold as different hooks", async () => {
  const path = await render("valid");
  await assert.rejects(
    validateCampaignDeliverables({
      files: [file(path, 1), file(path, 2), file(path, 3)],
      quote: quote({ hookVariants: 3 }),
    }),
    (error) => error.code === "deliverable_content_duplicate" && error.details.duplicateOf === "h1.mp4",
  );
});
