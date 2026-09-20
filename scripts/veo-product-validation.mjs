import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ffmpegStatic from "ffmpeg-static";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = join(rootDir, ".validation/reference-clone/output/veo");
const initialVideo = join(outputDir, "cotton-swabs-veo-lite.mp4");
const continuationFrame = join(outputDir, "continuation-first-frame.jpg");
const combinedVideo = join(outputDir, "cotton-swabs-veo-12s.mp4");
const finishedVideo = join(outputDir, "cotton-swabs-veo-12s-finished.mp4");
const narrationAudio = join(rootDir, ".validation/reference-clone/hypit-project/assets/narration-22dff384263890e2.wav");
const mode = process.env.VEO_VALIDATION_MODE?.trim() || "initial";
const modes = {
  initial: {
    inputImage: join(rootDir, ".validation/reference-clone/input/product.jpeg"),
    outputVideo: initialVideo,
    receiptFile: join(outputDir, "veo-validation-receipt.json"),
    durationSeconds: 4,
    seed: 20260921,
    prompt: [
      "Create a four-second vertical social-commerce beauty video.",
      "Start from the supplied real product photo and preserve the clear round tub, translucent lid, densely packed light wooden shafts, and white double-ended cotton tips.",
      "Use a quick macro push-in on the cotton tips, then a clean match cut to a newly generated generic adult beauty creator holding one matching wooden cotton swab beside the eye for a precise makeup touch-up.",
      "Warm natural indoor light, handheld creator aesthetic, shallow depth of field, realistic hands, realistic product geometry, no eye contact by the swab, no text, no logos, no watermark.",
    ].join(" "),
  },
  continuation: {
    inputImage: continuationFrame,
    outputVideo: join(outputDir, "cotton-swabs-veo-continuation.mp4"),
    receiptFile: join(outputDir, "veo-continuation-receipt.json"),
    durationSeconds: 8,
    seed: 20260922,
    prompt: [
      "Continue seamlessly from this exact first frame for eight seconds as the second half of a vertical social-commerce beauty video.",
      "Keep the same newly generated adult creator, face, hair, warm natural lighting, framing, hand, and the same light wooden cotton swab with white double-ended tips.",
      "First the creator completes one gentle precise makeup touch-up beside the eyelid without touching the eye, then moves the swab away, slowly rotates it to show both the pointed and rounded cotton tips, and ends with a confident clean product pose while looking toward the camera.",
      "Use subtle handheld movement and shallow depth of field. Preserve realistic finger contact and one continuous swab with stable geometry.",
      "Do not add floating swabs, duplicate hands, product text, logos, captions, or watermarks. Leave the lower third visually clean for a later call to action.",
    ].join(" "),
  },
};

if (!Object.hasOwn(modes, mode)) throw new Error(`Unsupported VEO_VALIDATION_MODE: ${mode}`);
const { inputImage, outputVideo, receiptFile, durationSeconds, seed, prompt } = modes[mode];

const projectId = process.env.GOOGLE_CLOUD_PROJECT?.trim();
if (!projectId) throw new Error("GOOGLE_CLOUD_PROJECT is required");
const location = process.env.GOOGLE_CLOUD_LOCATION?.trim() || "us-central1";
const model = process.env.GOOGLE_VEO_MODEL?.trim() || "veo-3.1-lite-generate-001";
const allowedModels = new Set(["veo-3.1-lite-generate-001"]);
if (!allowedModels.has(model)) {
  throw new Error(`Refusing unapproved Veo model: ${model}`);
}

function accessToken() {
  return execFileSync("gcloud", ["auth", "application-default", "print-access-token"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

async function requestJson(url, token, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text.slice(0, 2_000) };
  }
  if (!response.ok) {
    const error = new Error(`Vertex AI request failed with HTTP ${response.status}`);
    error.details = parsed;
    throw error;
  }
  return parsed;
}

async function writeJsonAtomic(path, value) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function videoBytesFrom(result) {
  const video = result?.response?.videos?.[0] ?? result?.response?.generatedVideos?.[0]?.video;
  const encoded = video?.bytesBase64Encoded ?? video?.videoBytes ?? video?.bytesBase64;
  return typeof encoded === "string" && encoded.length > 0 ? Buffer.from(encoded, "base64") : null;
}

await mkdir(outputDir, { recursive: true, mode: 0o700 });
if (mode === "continuation") {
  execFileSync(ffmpegStatic, [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-sseof", "-0.042", "-i", initialVideo,
    "-frames:v", "1", "-q:v", "2", continuationFrame,
  ]);
}
const image = await readFile(inputImage);
const inputSha256 = createHash("sha256").update(image).digest("hex");
const endpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}`;
const receipt = {
  format: "seller.veo-product-validation@1",
  createdAt: new Date().toISOString(),
  mode,
  projectId,
  location,
  model,
  durationSeconds,
  sampleCount: 1,
  resolution: "720p",
  aspectRatio: "9:16",
  generateAudio: false,
  inputImage: { path: inputImage, sha256: inputSha256, mimeType: "image/jpeg" },
  prompt,
  status: "preparing",
};
await writeJsonAtomic(receiptFile, receipt);

try {
  let token = accessToken();
  const submitted = await requestJson(`${endpoint}:predictLongRunning`, token, {
    instances: [
      {
        prompt,
        image: {
          bytesBase64Encoded: image.toString("base64"),
          mimeType: "image/jpeg",
        },
      },
    ],
    parameters: {
      aspectRatio: "9:16",
      durationSeconds,
      sampleCount: 1,
      resolution: "720p",
      resizeMode: "crop",
      personGeneration: "allow_adult",
      generateAudio: false,
      enhancePrompt: true,
      seed,
    },
  });
  if (!submitted?.name) throw new Error("Vertex AI returned no operation name");

  receipt.operationName = submitted.name;
  receipt.status = "submitted";
  receipt.submittedAt = new Date().toISOString();
  await writeJsonAtomic(receiptFile, receipt);
  console.log(JSON.stringify({ status: receipt.status, operationName: receipt.operationName }));

  const deadline = Date.now() + 12 * 60_000;
  let result;
  while (Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 15_000));
    token = accessToken();
    result = await requestJson(`${endpoint}:fetchPredictOperation`, token, {
      operationName: receipt.operationName,
    });
    if (result?.done) break;
    console.log(JSON.stringify({ status: "running", checkedAt: new Date().toISOString() }));
  }

  if (!result?.done) throw new Error("Veo operation did not finish within 12 minutes");
  if (result.error) {
    const error = new Error("Veo operation failed");
    error.details = result.error;
    throw error;
  }

  const bytes = videoBytesFrom(result);
  if (!bytes || bytes.length < 10_000) {
    const error = new Error("Veo completed without inline video bytes");
    error.details = {
      responseKeys: Object.keys(result?.response ?? {}),
      videos: result?.response?.videos?.map((item) => ({ mimeType: item.mimeType, gcsUri: item.gcsUri })) ?? [],
    };
    throw error;
  }

  const temporaryVideo = `${outputVideo}.tmp`;
  await writeFile(temporaryVideo, bytes, { mode: 0o600 });
  await rename(temporaryVideo, outputVideo);
  receipt.status = "succeeded";
  receipt.completedAt = new Date().toISOString();
  receipt.output = {
    path: outputVideo,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  receipt.filteredCount = result?.response?.raiMediaFilteredCount ?? 0;
  if (mode === "continuation") {
    execFileSync(ffmpegStatic, [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
      "-i", initialVideo, "-i", outputVideo,
      "-filter_complex", "[0:v]setpts=PTS-STARTPTS[v0];[1:v]setpts=PTS-STARTPTS[v1];[v0][v1]concat=n=2:v=1:a=0[v]",
      "-map", "[v]", "-c:v", "libx264", "-preset", "medium", "-crf", "18",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart", combinedVideo,
    ]);
    const combinedBytes = await readFile(combinedVideo);
    receipt.combinedOutput = {
      path: combinedVideo,
      bytes: combinedBytes.length,
      sha256: createHash("sha256").update(combinedBytes).digest("hex"),
      expectedDurationSeconds: 12,
    };
    execFileSync(ffmpegStatic, [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
      "-i", combinedVideo, "-i", narrationAudio,
      "-filter_complex",
      "[0:v]drawbox=x=44:y=1045:w=632:h=205:color=0x201725@0.92:t=fill:enable='between(t,8,12)',drawtext=fontfile='/System/Library/Fonts/Supplemental/Arial Bold.ttf':text='Tap to shop this tub':fontcolor=white:fontsize=38:x=(w-text_w)/2:y=1122:enable='between(t,8,12)'[v];[1:a]atrim=start=0:end=12,asetpts=PTS-STARTPTS,afade=t=out:st=11.4:d=0.6[a]",
      "-map", "[v]", "-map", "[a]", "-t", "12",
      "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", finishedVideo,
    ]);
    const finishedBytes = await readFile(finishedVideo);
    receipt.finishedOutput = {
      path: finishedVideo,
      bytes: finishedBytes.length,
      sha256: createHash("sha256").update(finishedBytes).digest("hex"),
      expectedDurationSeconds: 12,
      voiceover: narrationAudio,
      cta: "Tap to shop this tub",
    };
  }
  await writeJsonAtomic(receiptFile, receipt);
  console.log(JSON.stringify({ status: receipt.status, output: receipt.output, combinedOutput: receipt.combinedOutput, finishedOutput: receipt.finishedOutput }));
} catch (error) {
  receipt.status = receipt.operationName ? "failed_after_submission" : "not_submitted";
  receipt.failedAt = new Date().toISOString();
  receipt.error = {
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
    details: error?.details,
  };
  await writeJsonAtomic(receiptFile, receipt);
  console.error(JSON.stringify({ status: receipt.status, error: receipt.error }, null, 2));
  process.exitCode = 1;
}
