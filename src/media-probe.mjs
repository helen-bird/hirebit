import { spawn } from "node:child_process";

import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

import { AppError } from "./errors.mjs";

const TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 1_000_000;

function run(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let finished = false;
    const settle = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-MAX_OUTPUT); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-MAX_OUTPUT); });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle(new AppError("media_probe_failed", "Media inspection timed out", 502));
    }, timeoutMs);
    child.once("error", (error) => settle(error));
    child.once("close", (code) => settle(null, { code, stdout, stderr }));
  });
}

function incompatibleArchitecture(error) {
  return error?.errno === -86 || error?.code === "ENOEXEC";
}

function parseFfmpegMetadata(stderr) {
  // Only inspect the input header. Output streams may use different codecs and
  // dimensions after transcoding, and must never stand in for source metadata.
  const input = stderr.split(/^Stream mapping:|^Output #/mu, 1)[0];
  const format = /^Input #0,\s*(.+?),\s*from /mu.exec(input)?.[1] ?? null;
  const durationMatch = /\bDuration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/u.exec(input);
  const duration = durationMatch === null ? NaN
    : Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3]);
  const streams = [];
  for (const line of input.split("\n")) {
    const match = /^\s*Stream #0:(\d+)(?:\[[^\]]+\])?(?:\([^)]*\))?:\s*(Video|Audio):\s*([^\s,(]+)/u.exec(line);
    if (match === null) continue;
    const stream = { index: Number(match[1]), codec_type: match[2].toLowerCase(), codec_name: match[3] };
    if (stream.codec_type === "video") {
      const dimensions = /,\s*(\d{2,5})x(\d{2,5})(?:\s|,)/u.exec(line);
      if (dimensions !== null) {
        stream.width = Number(dimensions[1]);
        stream.height = Number(dimensions[2]);
      }
    } else {
      const sampleRate = /\b(\d+)\s*Hz\b/u.exec(line);
      if (sampleRate !== null) stream.sample_rate = sampleRate[1];
      const channels = /\b(\d+)\s+channels\b/u.exec(line);
      if (channels !== null) stream.channels = Number(channels[1]);
      else if (/\bmono\b/u.test(line)) stream.channels = 1;
      else if (/\bstereo\b/u.test(line)) stream.channels = 2;
    }
    streams.push(stream);
  }
  // Still images legitimately have no container duration. Callers that need a
  // duration validate it themselves; image dimension checks need only streams.
  if (format === null || streams.length === 0
    || streams.some((stream) => stream.codec_type === "video"
      && (!Number.isSafeInteger(stream.width) || !Number.isSafeInteger(stream.height)))) {
    throw new AppError("media_probe_failed", "Media inspector returned incomplete source metadata", 502);
  }
  return {
    format: { format_name: format, ...(Number.isFinite(duration) && duration > 0 ? { duration: String(duration) } : {}) },
    streams,
  };
}

export async function probeMedia(path, { timeoutMs = TIMEOUT_MS } = {}) {
  let result;
  try {
    result = await run(ffprobeStatic.path, [
      "-v", "error",
      "-show_entries", "format=duration,format_name:stream=index,codec_type,codec_name,width,height,sample_rate,channels",
      "-of", "json", path,
    ], timeoutMs);
  } catch (error) {
    if (!incompatibleArchitecture(error)) {
      throw new AppError("media_probe_failed", "Could not start media inspection", 502, { cause: error.message });
    }
    // Some ffprobe-static installations put an x86_64 Mach-O under the arm64
    // package path. ffmpeg-static is independently packaged and may still be
    // native. Decode the media, then use only the source header as metadata.
    let fallback;
    try {
      fallback = await run(ffmpegStatic, [
        "-nostdin", "-hide_banner", "-nostats", "-loglevel", "info",
        "-i", path, "-map", "0:v?", "-map", "0:a?", "-f", "null", "-",
      ], timeoutMs);
    } catch (fallbackError) {
      throw new AppError("media_probe_failed", "Could not start media inspection", 502, { cause: fallbackError.message });
    }
    if (fallback.code !== 0) {
      throw new AppError("media_invalid", "Media could not be decoded", 502, { stderr: fallback.stderr.slice(-4000) });
    }
    return parseFfmpegMetadata(fallback.stderr);
  }
  if (result.code !== 0) {
    throw new AppError("media_invalid", "Media could not be inspected", 502, { stderr: result.stderr.slice(-4000) });
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new AppError("media_probe_failed", "Media inspector returned invalid data", 502);
  }
}
