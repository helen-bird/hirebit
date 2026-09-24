import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

import { AppError } from "./errors.mjs";

function validToken(value) {
  return typeof value === "string" && value.trim().length >= 32 && value.trim().length <= 512;
}

export function resolvePublicDemoAccessToken({ enabled, paymentMode, value }) {
  if (enabled !== true) return null;
  if (paymentMode !== "demo") {
    throw new AppError("public_demo_payment_mode_invalid", "Public Demo access tokens are allowed only in demo payment mode", 503);
  }
  const token = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9_-]{10,64}$/u.test(token)) {
    throw new AppError(
      "invalid_public_demo_token",
      "PUBLIC_DEMO_ACCESS_TOKEN must contain 10-64 letters, numbers, underscores, or hyphens",
      503,
    );
  }
  return { value: token, source: "public-demo-environment" };
}

export async function loadOrCreateToken({ environmentValue, file }) {
  if (environmentValue !== undefined) {
    if (!validToken(environmentValue)) {
      throw new AppError("invalid_api_token", "Configured API token must contain 32-512 characters", 503);
    }
    return { value: environmentValue.trim(), source: "environment" };
  }
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await chmod(dirname(file), 0o700);
  try {
    const value = (await readFile(file, "utf8")).trim();
    if (!validToken(value)) throw new AppError("invalid_api_token", `API token file is invalid: ${file}`, 503);
    await chmod(file, 0o600);
    return { value, source: file };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const value = randomBytes(32).toString("base64url");
  try {
    await writeFile(file, `${value}\n`, { mode: 0o600, flag: "wx" });
    return { value, source: file };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = (await readFile(file, "utf8")).trim();
    if (!validToken(existing)) throw new AppError("invalid_api_token", `API token file is invalid: ${file}`, 503);
    return { value: existing, source: file };
  }
}

export function secretEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export function bearerToken(request) {
  const value = request.headers.authorization;
  if (typeof value !== "string" || !value.startsWith("Bearer ")) return null;
  return value.slice(7);
}

export function parseCookies(request) {
  const result = {};
  for (const item of String(request.headers.cookie ?? "").split(";")) {
    const index = item.indexOf("=");
    if (index < 1) continue;
    result[item.slice(0, index).trim()] = decodeURIComponent(item.slice(index + 1).trim());
  }
  return result;
}

export function requireBearer(request, expectedToken) {
  if (!secretEqual(bearerToken(request), expectedToken)) {
    throw new AppError("authentication_required", "A valid Bearer token is required", 401);
  }
}

export function assertAllowedHost(request, allowedHostnames) {
  const raw = request.headers.host;
  if (typeof raw !== "string") throw new AppError("invalid_host", "Host header is required", 400);
  let hostname;
  try {
    hostname = new URL(`http://${raw}`).hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  } catch {
    throw new AppError("invalid_host", "Host header is invalid", 400);
  }
  if (!allowedHostnames.has(hostname)) throw new AppError("host_not_allowed", "Host is not allowed", 403);
  return raw;
}

export function assertSameOrigin(request, host, { required = false, expectedOrigin } = {}) {
  const origin = request.headers.origin;
  if (origin === undefined) {
    if (required) throw new AppError("origin_required", "Origin header is required for browser-session writes", 403);
    return;
  }
  let parsedOrigin;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    throw new AppError("origin_not_allowed", "Origin is invalid", 403);
  }
  let allowedOrigin;
  if (expectedOrigin !== undefined) {
    try {
      const configured = new URL(expectedOrigin);
      if (configured.protocol !== "https:" || configured.origin !== expectedOrigin) throw new Error("not an HTTPS origin");
      allowedOrigin = configured.origin;
    } catch {
      throw new AppError("invalid_public_origin", "Configured public origin must be an exact HTTPS origin", 503);
    }
  } else {
    const protocol = request.socket?.encrypted === true ? "https:" : "http:";
    allowedOrigin = new URL(`${protocol}//${host}`).origin;
  }
  if (parsedOrigin.origin !== allowedOrigin) {
    throw new AppError("origin_not_allowed", "Cross-origin requests are not allowed", 403);
  }
}

export function createRateLimiter({ windowMs = 60_000, max = 120, clock = Date.now } = {}) {
  const buckets = new Map();
  return (request, key = request.socket.remoteAddress ?? "unknown") => {
    const now = clock();
    if (buckets.size > 10_000) {
      for (const [bucketKey, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(bucketKey);
      }
    }
    const current = buckets.get(key);
    if (current === undefined || current.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return;
    }
    current.count += 1;
    if (current.count > max) {
      throw new AppError("rate_limited", "Too many requests; retry later", 429);
    }
  };
}

export function safeServiceBaseUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new AppError("invalid_service_url", `${label} must be an absolute URL`, 503);
  }
  if (url.username !== "" || url.password !== "") {
    throw new AppError("invalid_service_url", `${label} must not contain credentials`, 503);
  }
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(url.hostname.toLowerCase().replace(/^\[|\]$/gu, ""));
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new AppError("insecure_service_url", `${label} must use HTTPS unless it is loopback-only`, 503);
  }
  url.hash = "";
  url.search = "";
  return url.href.replace(/\/$/u, "");
}

function forbiddenIpv4(hostname) {
  const parts = hostname.split(".").map(Number);
  return parts[0] === 0 || parts[0] === 10 || parts[0] === 127
    || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 0)
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 198 && [18, 19, 51].includes(parts[1]))
    || (parts[0] === 203 && parts[1] === 0 && parts[2] === 113)
    || parts[0] >= 224;
}

function ipv6Words(hostname) {
  let value = hostname.toLowerCase();
  const ipv4Tail = value.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/u)?.[1];
  if (ipv4Tail !== undefined) {
    const bytes = ipv4Tail.split(".").map(Number);
    if (bytes.length !== 4 || bytes.some((item) => !Number.isInteger(item) || item < 0 || item > 255)) return null;
    value = `${value.slice(0, -(ipv4Tail.length))}${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] === "" ? [] : halves[0].split(":");
  const right = halves.length === 1 || halves[1] === "" ? [] : halves[1].split(":");
  if (halves.length === 1 && left.length !== 8) return null;
  const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (fill < 1 && halves.length === 2) return null;
  const words = [...left, ...Array(fill).fill("0"), ...right].map((item) => Number.parseInt(item, 16));
  if (words.length !== 8 || words.some((item) => !Number.isInteger(item) || item < 0 || item > 0xffff)) return null;
  return words;
}

function forbiddenIp(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  const version = isIP(normalized);
  if (version === 4) return forbiddenIpv4(normalized);
  if (version !== 6) return false;
  const words = ipv6Words(normalized);
  if (words === null) return true;
  const [a, b, c, d, e, f, g, h] = words;
  const embeddedV4 = `${g >> 8}.${g & 0xff}.${h >> 8}.${h & 0xff}`;
  const mappedOrCompatible = a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && (f === 0 || f === 0xffff);
  return words.every((item) => item === 0)
    || (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0 && g === 0 && h === 1)
    || (a & 0xfe00) === 0xfc00
    || (a & 0xffc0) === 0xfe80
    || (a & 0xff00) === 0xff00
    || (a === 0x2001 && b === 0x0db8)
    || mappedOrCompatible && forbiddenIpv4(embeddedV4);
}

export function safeExternalUrl(value, label = "URL") {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new AppError("unsafe_external_url", `${label} must be an absolute HTTPS URL`, 400);
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || !["", "443"].includes(url.port)) {
    throw new AppError("unsafe_external_url", `${label} must use HTTPS without credentials or a custom port`, 400);
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")
    || hostname.endsWith(".internal") || hostname.endsWith(".lan") || hostname.endsWith(".home")) {
    throw new AppError("unsafe_external_url", `${label} must not target a local network name`, 400);
  }
  if (forbiddenIp(hostname)) {
    throw new AppError("unsafe_external_url", `${label} must not target a private or special-use address`, 400);
  }
  url.hash = "";
  return url.href;
}

const SOCIAL_VIDEO_RULES = {
  TikTok: {
    hosts: ["tiktok.com"],
    path: (url) => /^\/@[^/]+\/video\/\d+(?:\/|$)/u.test(url.pathname)
      || (["vm.tiktok.com", "vt.tiktok.com"].includes(url.hostname) && url.pathname.length > 1),
    example: "https://www.tiktok.com/@creator/video/7461234567890123456",
  },
};

function hostMatches(hostname, roots) {
  return roots.some((root) => hostname === root || hostname.endsWith(`.${root}`));
}

export function socialVideoExample(platform) {
  return SOCIAL_VIDEO_RULES[platform]?.example ?? null;
}

export function socialVideoPlatform(value) {
  let normalized;
  try { normalized = safeExternalUrl(value, "Reference video"); } catch { return null; }
  const url = new URL(normalized);
  url.hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  for (const [platform, rule] of Object.entries(SOCIAL_VIDEO_RULES)) {
    if (hostMatches(url.hostname, rule.hosts) && rule.path(url)) return platform;
  }
  return null;
}

export function safeSocialVideoUrl(value, platform, label = "Reference video") {
  const rule = SOCIAL_VIDEO_RULES[platform];
  if (rule === undefined) {
    throw new AppError("unsupported_reference_video_channel", `${label} requires TikTok`, 400);
  }
  const normalized = safeExternalUrl(value, label);
  const url = new URL(normalized);
  url.hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (!hostMatches(url.hostname, rule.hosts) || !rule.path(url)) {
    throw new AppError(
      "reference_video_channel_mismatch",
      `${label} must be a ${platform} video page, for example ${rule.example}`,
      400,
    );
  }
  return url.href;
}

export async function assertExternalUrlResolvesPublic(value, label = "URL", lookupImpl = lookup) {
  const normalized = safeExternalUrl(value, label);
  const hostname = new URL(normalized).hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (isIP(hostname)) return normalized;
  let addresses;
  try {
    addresses = await lookupImpl(hostname, { all: true, verbatim: true });
  } catch {
    throw new AppError("external_url_unresolvable", `${label} could not be resolved safely`, 502);
  }
  if (!Array.isArray(addresses) || addresses.length === 0
    || addresses.some((item) => typeof item?.address !== "string" || forbiddenIp(item.address))) {
    throw new AppError("unsafe_external_url", `${label} resolves to a private or special-use address`, 400);
  }
  return normalized;
}
