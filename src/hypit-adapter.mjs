import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, chmod, copyFile, link, lstat, mkdir, readFile, readdir, stat, statfs, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

import ffmpegStatic from "ffmpeg-static";

import { AppError } from "./errors.mjs";
import { downloadExternalResource } from "./external-resource.mjs";
import { compileCommissionProject, decodeHypitTextJson } from "./hypit-commission-compiler.mjs";
import {
  extractReferenceVisionInputs,
  REFERENCE_VISION_PLAN_FORMAT,
  validateReferenceVisionPlan,
} from "./reference-vision-planner.mjs";
import { resolveRegularFile } from "./safe-file.mjs";
import { assertProductionMaySpend, markProductionCancellation } from "./production-cancellation.mjs";
import { socialVideoPlatform } from "./security.mjs";
import { callSellerProviderTwice } from "./seller-provider-attempt.mjs";

const require = createRequire(import.meta.url);

function defaultMediaBinDir(rootDir) {
  if (process.platform === "darwin" && process.arch === "arm64") {
    try {
      return dirname(require.resolve("@ffprobe-installer/darwin-arm64/package.json"));
    } catch { /* The platform-specific optional package is not installed. */ }
  }
  return join(rootDir, ".tools/media-bin");
}

function safeName(value) {
  return value.replace(/[^a-zA-Z0-9._-]/gu, "-");
}

function inside(path, root) {
  const target = resolve(path);
  const boundary = resolve(root);
  return target === boundary || target.startsWith(`${boundary}/`);
}

function sandboxRule(path) {
  return `(deny file-read* (subpath ${JSON.stringify(path)}))`;
}

function sandboxWriteRule(root, allowedWritePaths) {
  const exceptions = allowedWritePaths.map((path) => `(require-not (subpath ${JSON.stringify(path)}))`).join(" ");
  return `(deny file-write* (require-all (subpath ${JSON.stringify(root)}) ${exceptions}))`;
}

function sandboxReadRule(root, allowedReadPaths) {
  const exceptions = allowedReadPaths.map((path) => `(require-not (subpath ${JSON.stringify(path)}))`).join(" ");
  const withinRoot = `(require-all (subpath ${JSON.stringify(root)}) ${exceptions})`;
  const metadataAncestors = new Set([resolve(root)]);
  for (const allowed of allowedReadPaths) {
    let current = dirname(resolve(allowed));
    while (current !== resolve(root) && inside(current, root)) {
      metadataAncestors.add(current);
      current = dirname(current);
    }
  }
  const metadataExceptions = [...metadataAncestors]
    .map((path) => `(require-not (literal ${JSON.stringify(path)}))`).join(" ");
  // Node resolves its absolute entry point by lstat-ing the home-directory boundary first.
  // Permit metadata only for ancestors of approved paths while continuing to deny both content
  // and metadata for every other descendant. Directory contents remain unreadable.
  return `(deny file-read-data ${withinRoot}) (deny file-read-metadata (require-all (subpath ${JSON.stringify(root)}) ${metadataExceptions} ${exceptions}))`;
}

async function command(program, args, {
  cwd,
  env,
  denyReadPaths = [],
  readRoot,
  allowedReadPaths = [],
  writeRoot,
  allowedWritePaths = [],
  timeoutMs = 3_600_000,
}) {
  return await new Promise((resolvePromise, reject) => {
    const sandboxed = process.platform === "darwin" && (denyReadPaths.length > 0 || readRoot !== undefined);
    const readRule = readRoot === undefined ? "" : sandboxReadRule(readRoot, allowedReadPaths);
    const writeRule = writeRoot === undefined ? "" : sandboxWriteRule(writeRoot, allowedWritePaths);
    const profile = `(version 1) (allow default) ${denyReadPaths.map(sandboxRule).join(" ")} ${readRule} ${writeRule} (deny process-exec (literal "/usr/bin/security"))`;
    const child = spawn(sandboxed ? "/usr/bin/sandbox-exec" : program, sandboxed ? ["-p", profile, program, ...args] : args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const append = (current, chunk) => `${current}${chunk}`.slice(-1_000_000);
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new AppError("hypit_timeout", `Hypit command timed out after ${timeoutMs}ms`, 502));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(new AppError("hypit_spawn_failed", "Could not start Hypit", 502, { cause: error.message }));
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new AppError("hypit_command_failed", `Hypit exited with code ${code}`, 502, {
          stderr: stderr.slice(-4000),
          stdout: stdout.slice(-2000),
        }));
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

const MAX_SOCIAL_REFERENCE_VIDEO_BYTES = 1_000_000_000;
const MAX_REFERENCE_VIDEO_CACHE_BYTES = 10_000_000_000;
const referenceCacheQueues = new Map();

export async function assertReferenceDownloadHeadroom(directory, maxBytes, filesystemStats = statfs) {
  const space = await filesystemStats(directory);
  const availableBytes = Number(space.bavail) * Number(space.bsize);
  // Staging can hold video, audio and muxed output simultaneously; preserve
  // enough room for the per-order copy/cache and the rest of the website.
  const requiredBytes = maxBytes * 4 + 1_000_000_000;
  if (!Number.isFinite(availableBytes) || availableBytes < requiredBytes) {
    throw new AppError("reference_video_disk_full", "Not enough free disk space to download this reference safely", 507);
  }
}

export async function pruneReferenceVideoCache(cacheDirectory, {
  incomingBytes = 0,
  protectedFilename = null,
  maxBytes = MAX_REFERENCE_VIDEO_CACHE_BYTES,
} = {}) {
  if (!Number.isSafeInteger(incomingBytes) || incomingBytes < 0
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || incomingBytes > maxBytes) {
    throw new AppError("reference_cache_limit_invalid", "Reference cache limit is invalid", 503);
  }
  const files = [];
  for (const entry of await readdir(cacheDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.mp4$/u.test(entry.name)) continue;
    let info;
    try { info = await lstat(join(cacheDirectory, entry.name)); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (info.isFile()) files.push({ name: entry.name, bytes: info.size, mtimeMs: info.mtimeMs });
  }
  let total = files.reduce((sum, file) => sum + file.bytes, incomingBytes);
  for (const file of files.sort((left, right) => left.mtimeMs - right.mtimeMs)) {
    if (total <= maxBytes) break;
    if (file.name === protectedFilename) continue;
    try { await unlink(join(cacheDirectory, file.name)); total -= file.bytes; }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      total -= file.bytes;
    }
  }
  if (total > maxBytes) throw new AppError("reference_cache_full", "Reference cache cannot fit this video", 507);
  return total;
}

async function hashFile(path, maxBytes) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      throw new AppError("external_resource_too_large", `Reference video exceeds the ${maxBytes}-byte limit`, 413);
    }
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest("hex") };
}

async function cacheReferenceVideo(path, cacheDirectory, cacheFilename) {
  const predecessor = referenceCacheQueues.get(cacheDirectory) ?? Promise.resolve();
  const work = predecessor.catch(() => {}).then(async () => {
    const source = await stat(path);
    await pruneReferenceVideoCache(cacheDirectory, {
      incomingBytes: source.size,
      protectedFilename: cacheFilename,
    });
    const tempCache = join(cacheDirectory, `${cacheFilename}.${randomUUID()}.tmp`);
    try {
      await copyFile(path, tempCache, constants.COPYFILE_EXCL);
      await chmod(tempCache, 0o600);
      await link(tempCache, join(cacheDirectory, cacheFilename)).catch((error) => {
        if (error?.code !== "EEXIST") throw error;
      });
    } finally {
      await unlink(tempCache).catch(() => {});
    }
  });
  referenceCacheQueues.set(cacheDirectory, work);
  try { await work; } finally {
    if (referenceCacheQueues.get(cacheDirectory) === work) referenceCacheQueues.delete(cacheDirectory);
  }
}

export async function downloadSocialReferenceVideo(value, {
  directory,
  basename = "evidence",
  hypitBin,
  stateHome,
  protectedPaths = [],
  maxBytes = MAX_SOCIAL_REFERENCE_VIDEO_BYTES,
  timeoutMs = 300_000,
  commandRunner = command,
  mediaBinDir = null,
} = {}) {
  const platform = socialVideoPlatform(value);
  if (platform === null) {
    throw new AppError("reference_video_url_unsupported", "Reference video is not a supported TikTok, Instagram, or YouTube page", 422);
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new AppError("reference_video_limit_invalid", "Reference video size limit is invalid", 503);
  }
  maxBytes = Math.min(maxBytes, MAX_SOCIAL_REFERENCE_VIDEO_BYTES);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(stateHome, { recursive: true, mode: 0o700 });
  await assertReferenceDownloadHeadroom(directory, maxBytes);
  const path = join(directory, `${basename}.mp4`);
  const cacheDirectory = join(stateHome, "reference-cache");
  const cacheFilename = `${createHash("sha256").update(value).digest("hex")}.mp4`;
  await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  await pruneReferenceVideoCache(cacheDirectory, { protectedFilename: cacheFilename });
  try {
    const cached = await resolveRegularFile(cacheDirectory, cacheFilename, "reference_video_cache_miss");
    try {
      if (cached.size < 1 || cached.size > maxBytes) {
        throw new AppError("reference_video_cache_invalid", "Cached reference video is not usable", 502);
      }
      await pipeline(
        cached.handle.createReadStream({ start: 0, autoClose: false }),
        createWriteStream(path, { flags: "wx", mode: 0o600 }),
      );
      const digest = await hashFile(path, maxBytes);
      return {
        path,
        filename: `${basename}.mp4`,
        mediaType: "video/mp4",
        ...digest,
        sourceHost: new URL(value).hostname,
        sourcePlatform: platform,
        fetchedBy: "hypit-reference-cache",
      };
    } catch (error) {
      await unlink(path).catch(() => {});
      throw error;
    } finally {
      await cached.handle.close().catch(() => {});
    }
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "reference_video_cache_miss") throw error;
  }
  const projectRoot = resolve(dirname(resolve(hypitBin)), "../..");
  const useDirectNodeLauncher = commandRunner === command;
  const hypitProgram = useDirectNodeLauncher ? process.execPath : hypitBin;
  const hypitPrefix = useDirectNodeLauncher ? [join(dirname(resolve(hypitBin)), "bin", "hypit.mjs")] : [];
  const environment = {
    HOME: directory,
    TMPDIR: directory,
    HYPIT_STATE_HOME: stateHome,
    HYPIT_FETCH_MAX_BYTES: String(maxBytes),
    PATH: [
      mediaBinDir ?? defaultMediaBinDir(projectRoot),
      join(projectRoot, ".tools/uv"),
      dirname(process.execPath),
      dirname(ffmpegStatic),
      process.env.PATH,
    ].filter(Boolean).join(":"),
    ...(typeof process.env.LANG === "string" ? { LANG: process.env.LANG } : {}),
  };
  try {
    const accessOptions = {
      cwd: directory,
      env: environment,
      denyReadPaths: protectedPaths,
      readRoot: resolve(homedir()),
      allowedReadPaths: [
        directory,
        stateHome,
        dirname(resolve(hypitBin)),
        dirname(process.execPath),
        join(projectRoot, ".tools"),
      ],
      writeRoot: resolve(homedir()),
      allowedWritePaths: [directory, stateHome],
      timeoutMs,
    };
    await commandRunner(hypitProgram, [...hypitPrefix, "media", "prepare-fetch", "--json"], accessOptions);
    await commandRunner(hypitProgram, [...hypitPrefix, "media", "fetch", value, "--to", path, "--json"], {
      ...accessOptions,
    });
    const info = await stat(path);
    if (!info.isFile() || info.size < 1) {
      throw new AppError("reference_video_fetch_invalid", "Hypit did not produce a usable reference video", 502);
    }
    if (info.size > maxBytes) {
      throw new AppError("external_resource_too_large", `Reference video exceeds the ${maxBytes}-byte limit`, 413);
    }
    await chmod(path, 0o600);
    const digest = await hashFile(path, maxBytes);
    await cacheReferenceVideo(path, cacheDirectory, cacheFilename);
    return {
      path,
      filename: `${basename}.mp4`,
      mediaType: "video/mp4",
      ...digest,
      sourceHost: new URL(value).hostname,
      sourcePlatform: platform,
      fetchedBy: "hypit-media-fetch",
    };
  } catch (error) {
    await unlink(path).catch(() => {});
    if (error instanceof AppError) {
      if (error.code === "hypit_command_failed") {
        let cliError;
        try { cliError = JSON.parse(error.details?.stdout ?? ""); } catch { /* The command did not emit a JSON error. */ }
        if (cliError?.format === "hypit.cli-error@1" && cliError.error?.code === "REFERENCE_VIDEO_TOO_LARGE") {
          throw new AppError("external_resource_too_large", `Reference video exceeds the ${maxBytes}-byte limit`, 413);
        }
      }
      if (["hypit_command_failed", "hypit_timeout", "hypit_spawn_failed"].includes(error.code)) {
        throw new AppError(
          "reference_video_fetch_failed",
          "The reference-video source could not be reached; retry the same paid order when the source is available",
          502,
          { causeCode: error.code },
        );
      }
      throw error;
    }
    throw new AppError("reference_video_fetch_failed", "Hypit could not fetch the reference video page", 502, {
      cause: String(error?.message ?? error).slice(-1000),
    });
  }
}

const SAFE_ENV_NAMES = ["LANG", "LC_ALL", "PATH"];
const FORBIDDEN_ENV = new Set([
  "BUYER_API_TOKEN", "BUYER_SELLER_API_TOKEN", "DEEPSEEK_API_KEY", "GOBTCPAY_MERCHANT_API_KEY",
  "MERCHANT_PASSWORD", "SELLER_API_TOKEN",
]);

function workflowEnvironment(workflow, commissionPath, sandboxHome) {
  const requested = Array.isArray(workflow.environment) ? workflow.environment : [];
  const names = new Set([...SAFE_ENV_NAMES, ...requested]);
  const result = {
    HOME: sandboxHome,
    TMPDIR: join(sandboxHome, "tmp"),
    SELLER_COMMISSION_PATH: commissionPath,
  };
  for (const name of names) {
    if (!/^[A-Z_][A-Z0-9_]*$/u.test(name) || FORBIDDEN_ENV.has(name)) continue;
    if (process.env[name] !== undefined) result[name] = process.env[name];
  }
  return result;
}

function parseJson(text, subject) {
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError("hypit_invalid_json", `${subject} did not return valid JSON`, 502, { output: text.slice(-2000) });
  }
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

function trustedUploadFilename(value, trustedOrigin) {
  if (trustedOrigin === null) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.origin !== trustedOrigin || url.search !== "" || url.hash !== "") return null;
  return /^\/v1\/uploads\/([a-f0-9]{48}\.(?:jpg|png))$/u.exec(url.pathname)?.[1] ?? null;
}

async function localizeTrustedUpload(value, {
  sourceDirectory,
  filename,
  directory,
  basename,
  maxBytes,
}) {
  const selected = await resolveRegularFile(sourceDirectory, filename, "upload_not_found");
  let bytes;
  try { bytes = await selected.handle.readFile(); } finally { await selected.handle.close(); }
  if (bytes.length > maxBytes) {
    throw new AppError("external_resource_too_large", `Customer upload exceeds the ${maxBytes}-byte limit`, 413);
  }
  const extension = filename.endsWith(".png") ? ".png" : ".jpg";
  const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if ((extension === ".png" && !png) || (extension === ".jpg" && !jpeg)) {
    throw new AppError("production_asset_type_mismatch", "Customer upload type changed after validation", 415);
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${basename}${extension}`);
  await writeFile(path, bytes, { mode: 0o600 });
  return {
    path,
    filename: `${basename}${extension}`,
    mediaType: extension === ".png" ? "image/png" : "image/jpeg",
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sourceHost: new URL(value).hostname,
    fetchedBy: "shared-buyer-upload",
  };
}

async function readHypitTextJson(path, subject) {
  let envelope;
  try { envelope = JSON.parse(await readFile(join(path, "value.json"), "utf8")); } catch {
    throw new AppError("hypit_json_output_invalid", `${subject} did not export a valid Hypit composite`, 502);
  }
  return decodeHypitTextJson(envelope?.value?.value, subject);
}

async function writeJsonOnce(path, value, subject) {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  if (await exists(path)) {
    if (await readFile(path, "utf8") !== bytes) {
      throw new AppError("hypit_output_conflict", `${subject} already exists with different content`, 502);
    }
    return;
  }
  await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
}

export class HypitAdapter {
  constructor({
    rootDir,
    dataDir,
    workflowFile,
    hypitBin,
    isolationVerified = false,
    protectedPaths = [],
    commandRunner = command,
    inputPreparer = null,
    videoProvider = null,
    referenceVideoFetcher = downloadSocialReferenceVideo,
    referenceVideoStateHome = resolve(dataDir, "hypit-fetch-state"),
    referenceVisionProvider = null,
    referenceAnalysisRunner = command,
    mediaBinDir = null,
    trustedUploadOrigin = null,
    trustedUploadDirectory = null,
    spendAllowed = null,
  }) {
    this.rootDir = rootDir;
    this.dataDir = dataDir;
    this.workflowFile = isAbsolute(workflowFile) ? workflowFile : resolve(rootDir, workflowFile);
    this.hypitBin = isAbsolute(hypitBin) ? hypitBin : resolve(rootDir, hypitBin);
    this.isolationVerified = isolationVerified;
    this.protectedPaths = protectedPaths.map((path) => resolve(path));
    this.commandController = typeof commandRunner === "function" ? null : commandRunner;
    this.commandRunner = typeof commandRunner === "function" ? commandRunner : commandRunner.run.bind(commandRunner);
    this.inputPreparer = inputPreparer;
    this.videoProvider = videoProvider;
    this.spendAllowed = spendAllowed;
    this.referenceVideoFetcher = referenceVideoFetcher;
    this.referenceVideoStateHome = resolve(referenceVideoStateHome);
    this.referenceVisionProvider = referenceVisionProvider;
    this.referenceAnalysisRunner = referenceAnalysisRunner;
    this.mediaBinDir = mediaBinDir === null ? defaultMediaBinDir(rootDir) : resolve(mediaBinDir);
    if ((trustedUploadOrigin === null) !== (trustedUploadDirectory === null)) {
      throw new AppError("trusted_upload_configuration_invalid", "Trusted upload origin and directory must be configured together", 503);
    }
    if (trustedUploadOrigin !== null) {
      const parsed = new URL(trustedUploadOrigin);
      if (parsed.protocol !== "https:" || parsed.origin !== trustedUploadOrigin) {
        throw new AppError("trusted_upload_configuration_invalid", "Trusted upload origin must be an exact HTTPS origin", 503);
      }
    }
    this.trustedUploadOrigin = trustedUploadOrigin;
    this.trustedUploadDirectory = trustedUploadDirectory === null ? null : resolve(trustedUploadDirectory);
  }

  async requestCancellation(orderId) {
    if (typeof orderId !== "string" || !/^[a-zA-Z0-9_-]{1,120}$/u.test(orderId)) {
      throw new AppError("production_cancellation_invalid", "Order ID is invalid", 400);
    }
    await markProductionCancellation(resolve(this.dataDir, "jobs", safeName(orderId)), orderId);
  }

  async readiness() {
    let executable = true;
    try { await access(this.hypitBin, constants.X_OK); } catch { executable = false; }
    const workerIsolation = this.commandController?.isolationStatus === undefined
      ? { configured: true, verified: this.isolationVerified, mode: "host" }
      : await this.commandController.isolationStatus();
    const productionInputs = typeof this.inputPreparer?.readiness === "function"
      ? await this.inputPreparer.readiness()
      : { configured: this.inputPreparer !== null };
    const videoGeneration = typeof this.videoProvider?.readiness === "function"
      ? this.videoProvider.readiness()
      : { configured: false, issue: "Google Veo provider is unavailable" };
    const referenceAdaptation = typeof this.referenceVisionProvider?.readiness === "function"
      ? await this.referenceVisionProvider.readiness()
      : { configured: false, issue: "Reference-video vision provider is unavailable" };
    try {
      const workflows = await this.#workflows();
      const readyProducts = [];
      const workflowIssues = {};
      const workflowEconomics = {};
      for (const [productId, workflow] of Object.entries(workflows)) {
        try {
          if (workflow.readyForSale !== true) throw new Error("readyForSale must be explicitly true");
          if (this.isolationVerified !== true) throw new Error("dedicated worker isolation has not been verified");
          if (workerIsolation.verified !== true) throw new Error(workerIsolation.issue ?? "isolated worker is unavailable");
          if (workflow.productionInputs?.voiceProvider === "macos-say-acceptance") {
            throw new Error("macos-say-acceptance is not approved for paid production");
          }
          if (!Array.isArray(workflow.deliverables) || workflow.deliverables.length === 0) throw new Error("deliverables are required");
          if (workflow.testOnly !== true && typeof workflow.commissionReceiptOutput !== "string") {
            throw new Error("commissionReceiptOutput is required for paid workflows");
          }
          if (!Number.isSafeInteger(workflow.maxProviderCostSats) || workflow.maxProviderCostSats < 0) {
            throw new Error("maxProviderCostSats must be configured");
          }
          if (typeof workflow.providerTermsConfirmedAt !== "string" || !Number.isFinite(Date.parse(workflow.providerTermsConfirmedAt))) {
            throw new Error("providerTermsConfirmedAt must record the reviewed third-party terms");
          }
          await access(resolve(this.rootDir, workflow.projectDir), constants.R_OK);
          if (workflow.compiler === "commission-v1") {
            const assets = workflow.productionAssets ?? {};
            if (typeof assets.product !== "string") {
              throw new Error("commission-v1 requires productionAssets.product");
            }
            if (workflow.productionInputs?.enabled === true && this.inputPreparer === null) {
              throw new Error("production input preparer is not configured");
            }
            if (workflow.productionInputs?.enabled === true && productionInputs.configured !== true) {
              throw new Error(productionInputs.copy?.issue ?? productionInputs.voice?.issue ?? "production input provider is unavailable");
            }
            if (workflow.productionInputs?.enabled === true
              && workflow.productionInputs.voiceProvider !== this.inputPreparer?.voiceProvider?.provider) {
              throw new Error(`configured voice provider does not match workflow: ${workflow.productionInputs.voiceProvider}`);
            }
            if (workflow.productionInputs?.enabled === true
              && this.inputPreparer?.voiceProvider?.commercialUseApproved !== true) {
              throw new Error("configured voice provider has not been approved for paid production");
            }
            if (workflow.videoGeneration?.enabled === true && videoGeneration.configured !== true) {
              throw new Error(videoGeneration.issue ?? "Google Veo provider is unavailable");
            }
            if (workflow.referenceAdaptation?.enabled === true && referenceAdaptation.configured !== true) {
              throw new Error(referenceAdaptation.issue ?? "reference-video vision provider is unavailable");
            }
            if (workflow.productionInputs?.enabled !== true && (!Array.isArray(assets.audio) || assets.audio.length === 0)) {
              throw new Error("commission-v1 requires production inputs or a non-empty productionAssets.audio array");
            }
            for (const path of [assets.product, assets.presenter, assets.look, ...(assets.audio ?? [])].filter(Boolean)) {
              await access(resolve(this.rootDir, path), constants.R_OK);
            }
          } else {
            await access(resolve(this.rootDir, workflow.projectDir, workflow.run), constants.R_OK);
          }
          readyProducts.push(productId);
          workflowEconomics[productId] = { maxProviderCostSats: workflow.maxProviderCostSats };
        } catch (error) {
          workflowIssues[productId] = String(error?.message ?? error);
        }
      }
      return {
        configured: executable && readyProducts.length > 0,
        executable,
        workflowProducts: readyProducts,
        workflowIssues,
        workflowEconomics,
        workerIsolation,
        productionInputs,
        videoGeneration,
        referenceAdaptation,
      };
    } catch (error) {
      return {
        configured: false,
        executable,
        workflowProducts: [],
        issue: error.code ?? "workflow_unavailable",
        workerIsolation,
        productionInputs,
        videoGeneration,
        referenceAdaptation,
      };
    }
  }

  async execute({ order, quote }) {
    const submission = await this.start({ order, quote });
    return await this.resume({ ...submission, order, quote });
  }

  async start({ order, quote }) {
    const context = await this.#context(order, quote, { prepareCommission: true });
    const { workflow, projectDir, runPath, projectScope, common, environment, denyReadPaths, jobDir, runtimeDataDir, runtimePath, commissionPath } = context;
    const buildAttemptPath = join(jobDir, "build.attempt.json");
    const buildReceiptPath = join(jobDir, "build.receipt.json");
    const commissionSha256 = createHash("sha256").update(await readFile(commissionPath)).digest("hex");
    if (await exists(buildReceiptPath)) {
      let receipt;
      try { receipt = JSON.parse(await readFile(buildReceiptPath, "utf8")); } catch {
        throw new AppError("hypit_build_receipt_invalid", "Persisted Hypit Build receipt is invalid", 503);
      }
      if (receipt.format !== "seller.hypit-build-receipt@1" || receipt.orderId !== order.id
        || receipt.commissionSha256 !== commissionSha256 || typeof receipt.buildId !== "string" || !receipt.buildId) {
        throw new AppError("hypit_build_receipt_invalid", "Persisted Hypit Build receipt does not match this order", 503);
      }
      return { buildId: receipt.buildId };
    }
    if (await exists(buildAttemptPath)) {
      let attempt;
      try { attempt = JSON.parse(await readFile(buildAttemptPath, "utf8")); } catch {
        throw new AppError("hypit_build_submission_uncertain", "Hypit Build attempt record is invalid", 503);
      }
      if (attempt.format !== "seller.hypit-build-attempt@1" || attempt.orderId !== order.id
        || attempt.commissionSha256 !== commissionSha256) {
        throw new AppError("hypit_build_submission_uncertain", "Hypit Build attempt does not match this order", 503);
      }
      throw new AppError("hypit_build_submission_uncertain", "Hypit Build may already be running without a durable Build id; do not resubmit", 503);
    }
    await assertProductionMaySpend(jobDir, { orderId: order.id, spendAllowed: this.spendAllowed });
    await this.commandRunner(this.hypitBin, ["check", runPath, ...projectScope, "--json"], {
      cwd: projectDir,
      env: environment,
      denyReadPaths,
      writeRoot: this.rootDir,
      allowedWritePaths: [projectDir, jobDir, runtimeDataDir],
      jobDir,
      runtimePath,
      timeoutMs: 120_000,
    });
    const planResult = await this.commandRunner(this.hypitBin, ["plan", runPath, ...projectScope, ...common, "--json"], {
      cwd: projectDir,
      env: environment,
      denyReadPaths,
      writeRoot: this.rootDir,
      allowedWritePaths: [projectDir, jobDir, runtimeDataDir],
      jobDir,
      runtimePath,
      timeoutMs: 120_000,
    });
    const plan = parseJson(planResult.stdout, "hypit plan");
    if (plan.ok === false || plan.requestIssueCount > 0) {
      throw new AppError("hypit_plan_not_ready", "Hypit plan has unresolved production requirements", 503, { plan });
    }
    await assertProductionMaySpend(jobDir, { orderId: order.id, spendAllowed: this.spendAllowed });
    await writeFile(buildAttemptPath, `${JSON.stringify({
      format: "seller.hypit-build-attempt@1", orderId: order.id, commissionSha256,
      startedAt: new Date().toISOString(),
    }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    const buildResult = await this.commandRunner(this.hypitBin, [
      "build",
      runPath,
      ...projectScope,
      ...common,
      "--title",
      `seller-${order.id}`,
      "--json",
    ], {
      cwd: projectDir,
      env: environment,
      denyReadPaths,
      writeRoot: this.rootDir,
      allowedWritePaths: [projectDir, jobDir, runtimeDataDir],
      jobDir,
      runtimePath,
      timeoutMs: 120_000,
    });
    const build = parseJson(buildResult.stdout, "hypit build");
    const buildId = build?.build?.id;
    if (typeof buildId !== "string" || buildId === "") {
      throw new AppError("hypit_build_submission_failed", "Hypit did not return a durable Build id", 502, { build });
    }
    await writeFile(buildReceiptPath, `${JSON.stringify({
      format: "seller.hypit-build-receipt@1", orderId: order.id, commissionSha256, buildId,
      receivedAt: new Date().toISOString(),
    }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    return { buildId };
  }

  async recoverUnsubmitted({ order, quote }) {
    return await this.start({ order, quote });
  }

  async canRetryBeforeBuild({ order, quote }) {
    const jobDir = resolve(this.dataDir, "jobs", safeName(order.id));
    try {
      if (!(await lstat(jobDir)).isDirectory()) return false;
      const commission = JSON.parse(await readFile(join(jobDir, "commission.json"), "utf8"));
      if (commission?.order?.id !== order.id || commission?.quote?.id !== quote.id
        || commission?.order?.amountSats !== order.amountSats) return false;
      for (const name of ["build.attempt.json", "build.receipt.json"]) {
        try {
          await lstat(join(jobDir, name));
          return false;
        } catch (error) {
          if (error?.code !== "ENOENT") return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  async resume({ buildId, order, quote }) {
    if (typeof buildId !== "string" || buildId === "") {
      throw new AppError("hypit_build_id_missing", "Cannot resume Hypit production without a Build id", 409);
    }
    const context = await this.#context(order, quote, { prepareCommission: false });
    const { workflow, projectDir, outputDir, projectScope, common, environment, denyReadPaths, jobDir, runtimeDataDir, runtimePath } = context;
    let statusResult;
    try {
      statusResult = await this.commandRunner(this.hypitBin, [
        "status",
        buildId,
        ...projectScope,
        ...common,
        "--watch",
        "--max-wait-ms",
        String(workflow.maxWaitMs ?? 3_600_000),
        "--json",
      ], {
        cwd: projectDir,
        env: environment,
        denyReadPaths,
        writeRoot: this.rootDir,
        allowedWritePaths: [projectDir, jobDir, runtimeDataDir],
        jobDir,
        runtimePath,
        timeoutMs: Number(workflow.maxWaitMs ?? 3_600_000) + 30_000,
      });
    } catch (error) {
      if (error.code === "hypit_timeout") {
        throw new AppError("hypit_build_still_running", "Hypit Build is still running; it will be reattached on the next poll", 409);
      }
      throw error;
    }
    const status = parseJson(statusResult.stdout, "hypit status");
    const build = status?.build ?? status;
    if (build?.work?.outcome === undefined || build?.work?.outcome === null) {
      throw new AppError("hypit_build_still_running", "Hypit Build is still running; it will be reattached on the next poll", 409, { build });
    }
    if (build.work.outcome !== "complete") {
      await this.commandController?.cleanup?.({ jobDir });
      throw new AppError("hypit_build_incomplete", "Hypit Build did not complete successfully", 502, { build });
    }
    const artifacts = [];
    for (const item of workflow.deliverables) {
      const filename = safeName(item.filename);
      const destination = join(outputDir, filename);
      if (item.encoding === "hypit-text-base64-json") {
        const exportRoot = join(jobDir, "hypit-exports");
        const exported = join(exportRoot, safeName(item.output));
        await mkdir(exportRoot, { recursive: true, mode: 0o700 });
        if (!await exists(exported)) {
          await this.commandRunner(this.hypitBin, [
            "get", buildId, "--output", item.output, "--to", exported, ...projectScope, "--json",
          ], {
            cwd: projectDir,
            env: environment,
            denyReadPaths,
            writeRoot: this.rootDir,
            allowedWritePaths: [projectDir, jobDir, runtimeDataDir],
            jobDir,
            runtimePath,
            timeoutMs: 300_000,
          });
        }
        await writeJsonOnce(destination, await readHypitTextJson(exported, item.output), item.output);
      } else if (!await exists(destination)) {
        await this.commandRunner(this.hypitBin, [
          "get", buildId, "--output", item.output, "--to", destination, ...projectScope, "--json",
        ], {
          cwd: projectDir,
          env: environment,
          denyReadPaths,
          writeRoot: this.rootDir,
          allowedWritePaths: [projectDir, jobDir, runtimeDataDir],
          jobDir,
          runtimePath,
          timeoutMs: 300_000,
        });
      }
      const exported = await resolveRegularFile(outputDir, filename, "hypit_artifact_invalid");
      let digest;
      try {
        const hash = createHash("sha256");
        for await (const chunk of exported.handle.createReadStream({ start: 0, autoClose: false })) {
          hash.update(chunk);
        }
        digest = hash.digest("hex");
      } finally {
        await exported.handle.close();
      }
      artifacts.push({
        name: filename,
        output: item.output,
        mediaType: item.mediaType ?? "video/mp4",
        specification: item.specification ?? null,
        bytes: exported.size,
        sha256: digest,
      });
    }
    let commissionReceipt = null;
    if (workflow.testOnly !== true) {
      if (workflow.receiptEncoding === "hypit-text-base64-json") {
        const exportRoot = join(jobDir, "hypit-exports");
        const exported = join(exportRoot, safeName(workflow.commissionReceiptOutput));
        await mkdir(exportRoot, { recursive: true, mode: 0o700 });
        if (!await exists(exported)) {
          await this.commandRunner(this.hypitBin, [
            "get", buildId, "--output", workflow.commissionReceiptOutput, "--to", exported, ...projectScope, "--json",
          ], {
            cwd: projectDir,
            env: environment,
            denyReadPaths,
            writeRoot: this.rootDir,
            allowedWritePaths: [projectDir, jobDir, runtimeDataDir],
            jobDir,
            runtimePath,
            timeoutMs: 300_000,
          });
        }
        commissionReceipt = await readHypitTextJson(exported, "commission receipt");
        await writeJsonOnce(join(jobDir, "commission-receipt.json"), commissionReceipt, "commission receipt");
      } else {
        const receiptPath = join(jobDir, "commission-receipt.json");
        if (!await exists(receiptPath)) {
          await this.commandRunner(this.hypitBin, [
            "get", buildId, "--output", workflow.commissionReceiptOutput, "--to", receiptPath, ...projectScope, "--json",
          ], {
            cwd: projectDir,
            env: environment,
            denyReadPaths,
            writeRoot: this.rootDir,
            allowedWritePaths: [projectDir, jobDir, runtimeDataDir],
            jobDir,
            runtimePath,
            timeoutMs: 300_000,
          });
        }
        try { commissionReceipt = JSON.parse(await readFile(receiptPath, "utf8")); } catch {
          throw new AppError("commission_receipt_invalid", "Production did not return a valid commission receipt", 502);
        }
      }
      const commissionSha256 = createHash("sha256").update(await readFile(context.commissionPath)).digest("hex");
      if (commissionReceipt.commissionSha256 !== commissionSha256
        || commissionReceipt.orderId !== order.id
        || commissionReceipt.productId !== quote.product.id
        || (workflow.productionInputsSha256 !== null && workflow.productionInputsSha256 !== undefined
          && commissionReceipt.productionInputs?.manifestSha256 !== workflow.productionInputsSha256)) {
        throw new AppError("commission_receipt_mismatch", "Production result is not bound to the paid commission", 502);
      }
    }
    const result = { provider: "self-hosted-hypit", buildId, artifacts, commissionReceipt };
    await this.commandController?.cleanup?.({ jobDir });
    return result;
  }

  async #context(order, quote, { prepareCommission }) {
    const workflows = await this.#workflows();
    const workflow = workflows[quote.product.id];
    if (workflow === undefined) {
      throw new AppError(
        "hypit_workflow_not_configured",
        `No pre-authored Hypit workflow is configured for ${quote.product.id}`,
        503,
      );
    }
    if (workflow.readyForSale !== true) {
      throw new AppError("hypit_workflow_not_ready_for_sale", `Workflow ${quote.product.id} has not passed production acceptance`, 503);
    }
    if (workflow.productionInputs?.voiceProvider === "macos-say-acceptance") {
      throw new AppError("production_voice_not_approved", "The configured local voice provider is for acceptance only and cannot fulfill paid orders", 503);
    }
    if (workflow.productionInputs?.enabled === true
      && workflow.productionInputs.voiceProvider !== this.inputPreparer?.voiceProvider?.provider) {
      throw new AppError("production_voice_provider_mismatch", "The configured production voice provider does not match the accepted workflow", 503);
    }
    if (workflow.productionInputs?.enabled === true
      && this.inputPreparer?.voiceProvider?.commercialUseApproved !== true) {
      throw new AppError("production_voice_not_approved", "The configured voice provider has not been approved for paid production", 503);
    }
    if (this.isolationVerified !== true) {
      throw new AppError(
        "hypit_worker_isolation_unverified",
        "Paid production is disabled until the dedicated Hypit worker OS-user/container isolation has been verified",
        503,
      );
    }
    const baseProjectDir = resolve(this.rootDir, workflow.projectDir);
    const jobDir = resolve(this.dataDir, "jobs", safeName(order.id));
    const runtimeDataDir = resolve(this.dataDir, workflow.runtimeDataDir ?? "hypit-runtime");
    if (runtimeDataDir !== this.dataDir && !runtimeDataDir.startsWith(`${this.dataDir}/`)) {
      throw new AppError("hypit_runtime_path_invalid", "Workflow runtimeDataDir must stay inside Seller data", 503);
    }
    const outputDir = join(jobDir, "outputs");
    const sandboxHome = join(jobDir, "sandbox-home");
    const inputDir = join(jobDir, "inputs");
    await mkdir(outputDir, { recursive: true, mode: 0o700 });
    await mkdir(join(sandboxHome, "tmp"), { recursive: true, mode: 0o700 });
    await chmod(jobDir, 0o700);
    await chmod(outputDir, 0o700);
    const commissionPath = join(jobDir, "commission.json");
    if (prepareCommission && !await exists(commissionPath)) {
      const localAssets = {};
      const sourceLinks = {};
      for (const [field, value] of Object.entries({
        referenceUrl: quote.brief?.referenceUrl,
        evidenceUrl: quote.brief?.evidenceUrl,
      })) {
        if (typeof value === "string") {
          const basename = field === "referenceUrl" ? "reference" : "evidence";
          const maxBytes = field === "evidenceUrl" && socialVideoPlatform(value) !== null
            ? MAX_SOCIAL_REFERENCE_VIDEO_BYTES
            : Number(workflow.maxExternalAssetBytes ?? 25 * 1024 * 1024);
          const trustedFilename = field === "referenceUrl"
            ? trustedUploadFilename(value, this.trustedUploadOrigin)
            : null;
          let localized;
          try {
            localized = trustedFilename !== null
              ? await localizeTrustedUpload(value, {
                sourceDirectory: this.trustedUploadDirectory,
                filename: trustedFilename,
                directory: inputDir,
                basename,
                maxBytes,
              })
              : field === "evidenceUrl" && socialVideoPlatform(value) !== null
              ? await this.referenceVideoFetcher(value, {
                directory: inputDir,
                basename,
                hypitBin: this.hypitBin,
                stateHome: this.referenceVideoStateHome,
                protectedPaths: this.protectedPaths,
                maxBytes,
                mediaBinDir: this.mediaBinDir,
              })
              : await downloadExternalResource(value, {
                directory: inputDir,
                basename,
                label: `quote.brief.${field}`,
                maxBytes,
              });
          } catch (error) { throw error; }
          if (field === "referenceUrl" && !localized.mediaType?.startsWith("image/")) {
            throw new AppError("reference_image_required", "The optional reference input must be a directly downloadable image", 422);
          }
          if (field === "evidenceUrl" && !localized.mediaType?.startsWith("video/")) {
            throw new AppError("reference_video_required", "The supplied reference must be a downloadable video", 422);
          }
          localAssets[field] = localized;
        }
      }
      const commissionQuote = structuredClone(quote);
      if (commissionQuote.brief !== undefined) {
        delete commissionQuote.brief.referenceUrl;
        delete commissionQuote.brief.evidenceUrl;
        commissionQuote.brief.localAssets = localAssets;
      }
      await writeFile(commissionPath, `${JSON.stringify({ order, quote: commissionQuote, localAssets, sourceLinks }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    } else {
      try { await access(commissionPath, constants.R_OK); } catch {
        throw new AppError("production_commission_missing", "Cannot resume production because its durable commission is missing", 503);
      }
    }

    let effectiveWorkflow = workflow;
    let projectDir = baseProjectDir;
    let runPath = resolve(projectDir, workflow.run);
    let workspace = resolve(this.rootDir, workflow.workspace ?? workflow.projectDir);
    if (workflow.compiler === "commission-v1") {
      await assertProductionMaySpend(jobDir, { orderId: order.id, spendAllowed: this.spendAllowed });
      const referenceAdaptation = await this.#prepareReferenceAdaptation({
        workflow, jobDir, order, quote, commissionPath,
      });
      const productionInputs = workflow.productionInputs?.enabled === true
        ? await this.inputPreparer.prepare({ jobDir, order, quote, commissionPath, referenceAdaptation })
        : null;
      if (productionInputs !== null && productionInputs.voice?.commercialUseApproved !== true) {
        throw new AppError("production_voice_not_approved", "The generated voice inputs are not approved for paid production", 503);
      }
      if (productionInputs !== null && productionInputs.voice?.requirementsSatisfied !== true) {
        throw new AppError("production_voice_requirements_unmet", "The configured voice provider did not satisfy the paid voice requirements", 503);
      }
      let generatedVideo = null;
      const commission = JSON.parse(await readFile(commissionPath, "utf8"));
      const hasCustomerImage = Object.values(commission.localAssets ?? {})
        .some((item) => item?.mediaType?.startsWith("image/"));
      if (referenceAdaptation !== null && workflow.videoGeneration?.enabled !== true) {
        throw new AppError(
          "reference_motion_generation_required",
          "Reference-video production requires the approved generative-motion provider",
          503,
        );
      }
      if (workflow.videoGeneration?.enabled === true && hasCustomerImage) {
        if (this.videoProvider === null) throw new AppError("google_veo_unavailable", "Google Veo provider is unavailable", 503);
        generatedVideo = await this.videoProvider.prepare({
          jobDir,
          order,
          quote,
          commissionPath,
          productionInputs,
          referenceAdaptation,
        });
      }
      if (referenceAdaptation !== null && generatedVideo === null) {
        throw new AppError(
          "reference_motion_generation_required",
          "Reference-video production did not return generated motion; image-only fallback is disabled",
          503,
        );
      }
      const manifest = await compileCommissionProject({
        rootDir: this.rootDir,
        jobDir,
        workflow,
        order,
        quote,
        commissionPath,
        productionInputs,
        generatedVideo,
        referenceAdaptation,
      });
      projectDir = resolve(jobDir, manifest.projectDirectory);
      runPath = resolve(projectDir, manifest.run);
      workspace = projectDir;
      if (projectDir !== jobDir && !projectDir.startsWith(`${jobDir}/`)) {
        throw new AppError("production_manifest_path_invalid", "Compiled project escaped the order directory", 503);
      }
      effectiveWorkflow = {
        ...workflow,
        deliverables: manifest.deliverables,
        commissionReceiptOutput: manifest.commissionReceiptOutput,
        receiptEncoding: manifest.receiptEncoding,
        productionInputsSha256: manifest.productionInputsSha256,
      };
    }

    const runtimePath = workflow.runtime === undefined ? null : resolve(baseProjectDir, workflow.runtime);
    const common = runtimePath === null ? [] : ["--runtime", runtimePath];
    const projectScope = ["--workspace", workspace];
    const environment = workflowEnvironment(effectiveWorkflow, commissionPath, sandboxHome);
    const denyReadPaths = [
      resolve(this.rootDir, ".env"),
      resolve(this.rootDir, ".gobtcpay"),
      resolve(this.rootDir, ".buyer"),
      resolve(this.dataDir, "api-token"),
      resolve(this.dataDir, "merchant-onboarding.json"),
      resolve(this.dataDir, "merchant-secrets.json"),
      resolve(this.dataDir, "merchant-wallet.json"),
      ...this.protectedPaths,
    ];
    if (!Array.isArray(effectiveWorkflow.deliverables) || effectiveWorkflow.deliverables.length === 0) {
      throw new AppError("hypit_no_deliverables", "Hypit workflow defines no deliverables", 503);
    }
    return {
      workflow: effectiveWorkflow,
      projectDir,
      runPath,
      workspace,
      jobDir,
      runtimeDataDir,
      outputDir,
      commissionPath,
      common,
      projectScope,
      environment,
      denyReadPaths,
      runtimePath,
    };
  }

  async #prepareReferenceAdaptation({ workflow, jobDir, order, quote, commissionPath }) {
    const commissionBytes = await readFile(commissionPath);
    const commissionSha256 = createHash("sha256").update(commissionBytes).digest("hex");
    const commission = JSON.parse(commissionBytes);
    const videos = Object.values(commission.localAssets ?? {}).filter((item) => item?.mediaType?.startsWith("video/"));
    if (videos.length === 0) return null;
    if (workflow.referenceAdaptation?.enabled !== true) {
      throw new AppError("reference_adaptation_unsupported", `${quote.product.name} does not support reference-video adaptation`, 409);
    }
    if (this.referenceVisionProvider === null) {
      throw new AppError("reference_vision_unavailable", "Reference-video vision analysis is unavailable", 503);
    }
    const images = Object.values(commission.localAssets ?? {}).filter((item) => item?.mediaType?.startsWith("image/"));
    if (images.length === 0) {
      throw new AppError("reference_product_image_required", "Reference-video adaptation requires a customer product image", 409);
    }
    const video = videos[0];
    const image = images[0];
    if (!inside(video.path, jobDir) || !inside(image.path, jobDir)) {
      throw new AppError("production_asset_path_invalid", "Reference adaptation input escaped the order directory", 503);
    }
    const directory = join(jobDir, "reference-adaptation");
    const recordPath = join(directory, "plan.json");
    const attemptPath = join(directory, "plan.attempt.json");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (await exists(recordPath)) {
      const recordBytes = await readFile(recordPath);
      const record = JSON.parse(recordBytes);
      if (record.format !== REFERENCE_VISION_PLAN_FORMAT || record.orderId !== order.id
        || record.productId !== quote.product.id || record.commissionSha256 !== commissionSha256
        || record.inputs?.productSha256 !== image.sha256 || record.inputs?.referenceSha256 !== video.sha256) {
        throw new AppError("reference_adaptation_manifest_mismatch", "Persisted reference adaptation is not bound to this commission", 503);
      }
      record.plan = validateReferenceVisionPlan(record.plan);
      return { ...record, manifestPath: recordPath, manifestSha256: createHash("sha256").update(recordBytes).digest("hex") };
    }
    const environment = {
      HOME: directory,
      TMPDIR: directory,
      HYPIT_STATE_HOME: this.referenceVideoStateHome,
      PATH: [
        this.mediaBinDir,
        join(this.rootDir, ".tools/uv"),
        dirname(process.execPath),
        dirname(ffmpegStatic),
        process.env.PATH,
      ].filter(Boolean).join(":"),
    };
    const common = {
      cwd: directory,
      env: environment,
      denyReadPaths: this.protectedPaths,
      readRoot: resolve(homedir()),
      allowedReadPaths: [
        directory,
        jobDir,
        this.referenceVideoStateHome,
        dirname(this.hypitBin),
        dirname(process.execPath),
        join(this.rootDir, ".tools"),
        this.mediaBinDir,
      ],
      writeRoot: resolve(homedir()),
      allowedWritePaths: [directory, this.referenceVideoStateHome],
      timeoutMs: 120_000,
    };
    const useDirectNodeLauncher = this.referenceAnalysisRunner === command;
    const hypitProgram = useDirectNodeLauncher ? process.execPath : this.hypitBin;
    const hypitPrefix = useDirectNodeLauncher ? [join(dirname(this.hypitBin), "bin", "hypit.mjs")] : [];
    const probe = parseJson((await this.referenceAnalysisRunner(hypitProgram, [
      ...hypitPrefix, "media", "probe", video.path, "--json",
    ], common)).stdout, "Hypit reference probe");
    const sourceDurationSeconds = Number(probe.duration);
    if (!Number.isFinite(sourceDurationSeconds) || sourceDurationSeconds <= 0) {
      throw new AppError("reference_video_invalid", "Hypit could not determine the reference-video duration", 502);
    }
    const analysisDurationSeconds = Number(Math.min(60, sourceDurationSeconds).toFixed(3));
    const boundaries = parseJson((await this.referenceAnalysisRunner(hypitProgram, [
      ...hypitPrefix, "media", "boundaries", video.path, "--rate", "12", "--threshold", "0.20", "--json",
    ], common)).stdout, "Hypit reference boundaries");
    const prepared = await extractReferenceVisionInputs({
      productImagePath: image.path,
      referenceVideoPath: video.path,
      durationSeconds: analysisDurationSeconds,
      boundaryCandidates: boundaries.candidates ?? [],
      directory: join(directory, "vision-inputs"),
    });
    return await callSellerProviderTwice({
      path: attemptPath,
      identity: {
        format: "seller.reference-analysis-attempt@1", orderId: order.id, commissionSha256,
        productSha256: image.sha256, referenceSha256: video.sha256,
      },
      uncertainCode: "reference_adaptation_submission_uncertain",
      beforeCall: () => assertProductionMaySpend(jobDir, { orderId: order.id, spendAllowed: this.spendAllowed }),
      call: () => this.referenceVisionProvider.generate({
        durationSeconds: analysisDurationSeconds,
        boundaryTimes: (boundaries.candidates ?? []).map((item) => item.at),
        productImage: prepared.productImage,
        referenceFrames: prepared.referenceFrames,
      }),
      finalize: async (generated) => {
        const record = {
          format: REFERENCE_VISION_PLAN_FORMAT,
          orderId: order.id,
          productId: quote.product.id,
          commissionSha256,
          createdAt: new Date().toISOString(),
          inputs: { productSha256: image.sha256, referenceSha256: video.sha256 },
          source: {
            durationSeconds: sourceDurationSeconds,
            width: Number(probe.width) || null,
            height: Number(probe.height) || null,
            frameRate: Number(probe.frameRate) || null,
            boundaryTimes: (boundaries.candidates ?? []).map((item) => Number(item.at)).filter(Number.isFinite),
          },
          sampling: prepared.referenceFrames.map((frame) => frame.at),
          provider: generated.provider,
          model: generated.model,
          usage: generated.usage,
          plan: generated.plan,
        };
        const recordBytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
        await writeFile(recordPath, recordBytes, { mode: 0o600, flag: "wx" });
        return {
          ...record,
          manifestPath: recordPath,
          manifestSha256: createHash("sha256").update(recordBytes).digest("hex"),
        };
      },
    });
  }

  async #workflows() {
    try {
      return JSON.parse(await readFile(this.workflowFile, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new AppError(
          "hypit_workflows_missing",
          `Workflow file not found: ${this.workflowFile}. Copy config/hypit-workflows.example.json and configure a real production.`,
          503,
        );
      }
      throw error;
    }
  }
}
