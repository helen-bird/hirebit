import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";

import { AppError, errorPayload } from "../errors.mjs";
import { resolveRegularFile, streamRegularFile } from "../safe-file.mjs";
import {
  assertAllowedHost,
  assertSameOrigin,
  bearerToken,
  createRateLimiter,
  parseCookies,
  safeSocialVideoUrl,
  secretEqual,
} from "../security.mjs";

const MIME = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

const PUBLIC_DEMO_QUOTA_WINDOW_MS = 60 * 60 * 1000;
const PUBLIC_DEMO_QUOTA_EXCLUDED_STATES = new Set(["declined", "cancelled"]);

export function publicDemoQuotaStatus(delegations, {
  maxDelegations,
  now = Date.now(),
  windowMs = PUBLIC_DEMO_QUOTA_WINDOW_MS,
} = {}) {
  const cutoff = now - windowMs;
  const counted = delegations
    .filter((item) => !PUBLIC_DEMO_QUOTA_EXCLUDED_STATES.has(item?.state))
    .map((item) => Date.parse(item?.createdAt))
    .filter((createdAt) => Number.isFinite(createdAt) && createdAt >= cutoff)
    .sort((left, right) => left - right);
  const used = counted.length;
  return {
    used,
    limit: maxDelegations,
    available: Math.max(0, maxDelegations - used),
    exhausted: used >= maxDelegations,
    retryAt: used >= maxDelegations ? new Date(counted[0] + windowMs).toISOString() : null,
  };
}

function json(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

async function body(request) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 1_000_000) throw new AppError("body_too_large", "Request body exceeds 1 MB", 413);
  }
  if (raw === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new AppError("invalid_json", "Request body is not valid JSON");
  }
}

async function binaryBody(request, maxBytes) {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new AppError("product_image_too_large", `Product image exceeds ${maxBytes} bytes`, 413);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new AppError("product_image_too_large", `Product image exceeds ${maxBytes} bytes`, 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function jpegDimensions(data) {
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 4 <= data.length) {
    if (data[offset] !== 0xff) { offset += 1; continue; }
    while (data[offset] === 0xff) offset += 1;
    const marker = data[offset];
    offset += 1;
    if (marker === 0xd8 || marker === 0x01) continue;
    if (marker === 0xd9 || marker === 0xda || offset + 2 > data.length) break;
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length) break;
    if (startOfFrame.has(marker)) {
      if (length < 7) break;
      return { width: data.readUInt16BE(offset + 5), height: data.readUInt16BE(offset + 3) };
    }
    offset += length;
  }
  throw new AppError("product_image_invalid", "JPEG dimensions could not be verified", 415);
}

export function inspectProductImage(data, declaredType) {
  if (!Buffer.isBuffer(data) || data.length < 32) {
    throw new AppError("product_image_invalid", "Product image is empty or truncated", 415);
  }
  let image;
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    if (data.subarray(12, 16).toString("ascii") !== "IHDR") {
      throw new AppError("product_image_invalid", "PNG header is invalid", 415);
    }
    image = { mediaType: "image/png", extension: "png", width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  } else if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    image = { mediaType: "image/jpeg", extension: "jpg", ...jpegDimensions(data) };
  } else {
    throw new AppError("product_image_invalid", "Only genuine JPG and PNG images are accepted", 415);
  }
  if (declaredType !== image.mediaType) {
    throw new AppError("product_image_type_mismatch", "Declared image type does not match the file", 415);
  }
  if (image.width < 64 || image.height < 64 || image.width > 8192 || image.height > 8192
    || image.width * image.height > 33_554_432) {
    throw new AppError("product_image_dimensions_rejected", "Product image dimensions must be 64-8192 px and no more than 33.5 megapixels", 415);
  }
  return image;
}

function containsExternalUrl(value) {
  if (typeof value === "string") return /https?:\/\//iu.test(value);
  if (Array.isArray(value)) return value.some(containsExternalUrl);
  if (value !== null && typeof value === "object") return Object.values(value).some(containsExternalUrl);
  return false;
}

function rejectPublicDemoExternalUrls(value) {
  if (containsExternalUrl(value)) {
    throw new AppError(
      "public_demo_external_url_disabled",
      "External URLs are disabled in the public Demo to prevent untrusted downloads and provider abuse",
      403,
    );
  }
}

export function validatePublicDemoDelegation(input, { maxRequestChars = 1000 } = {}) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new AppError("invalid_public_demo_request", "Public Demo input must be an object");
  }
  if (typeof input.request !== "string" || input.request.trim().length < 10 || input.request.length > maxRequestChars) {
    throw new AppError(
      "invalid_public_demo_request",
      `Public Demo requests must contain 10-${maxRequestChars} characters`,
    );
  }
  const context = input.context !== null && typeof input.context === "object" && !Array.isArray(input.context)
    ? { ...input.context }
    : input.context;
  const referenceVideoUrl = context?.referenceVideoUrl;
  if (referenceVideoUrl !== undefined) {
    // The exact social host and path allowlist is the public-Demo trust boundary here.
    // Do not reject Clash/TUN fake-IP DNS answers (198.18.0.0/15); Hypit fetches the
    // allowlisted page through the host network and local DNS pinning would be a false positive.
    safeSocialVideoUrl(referenceVideoUrl, context?.platform, "context.referenceVideoUrl");
  }
  if (context !== null && typeof context === "object" && !Array.isArray(context)) delete context.referenceVideoUrl;
  rejectPublicDemoExternalUrls({ ...input, context });
  return input;
}

async function file(response, path, { contentDisposition } = {}) {
  const selected = await resolveRegularFile(resolve(path, ".."), path.split(/[\\/]/u).at(-1), "not_found");
  response.writeHead(200, {
    "content-type": MIME[extname(selected.path).toLowerCase()] ?? "application/octet-stream",
    "content-length": selected.size,
    ...(contentDisposition ? { "content-disposition": contentDisposition } : {}),
  });
  streamRegularFile(response, selected);
}

export function createBuyerServer({
  service,
  intake,
  dataDir,
  webDir,
  demoProductImagePath = null,
  apiToken,
  allowedHostnames = new Set(["127.0.0.1", "localhost", "::1"]),
  publicDemo = { enabled: false },
}) {
  if (typeof apiToken !== "string") throw new AppError("buyer_api_token_missing", "Buyer API token is required", 503);
  if (publicDemo.enabled === true) {
    try {
      const parsed = new URL(publicDemo.publicOrigin);
      if (parsed.protocol !== "https:" || parsed.origin !== publicDemo.publicOrigin) throw new Error("not an exact HTTPS origin");
    } catch {
      throw new AppError("invalid_public_origin", "Public Demo requires an exact HTTPS public origin", 503);
    }
  }
  const sessions = new Map();
  const sessionLifetimeMs = publicDemo.enabled === true ? 2 * 60 * 60 * 1000 : 8 * 60 * 60 * 1000;
  const limitApi = createRateLimiter({ max: 180 });
  const limitLogin = createRateLimiter({ max: 10 });
  const limitPublicMutation = createRateLimiter({ max: publicDemo.maxMutationsPerMinute ?? 30 });
  const uploadDir = resolve(dataDir, "uploads");
  const maxProductImageBytes = 5 * 1024 * 1024;
  const maxUploads = publicDemo.enabled === true ? Math.max(2, (publicDemo.maxDelegations ?? 3) * 2) : 50;
  let uploadsAcceptedAt = [];

  function authorize(request, method, host) {
    const bearerAuthorized = secretEqual(bearerToken(request), apiToken);
    const suppliedSession = parseCookies(request).buyer_session;
    const session = typeof suppliedSession === "string" ? sessions.get(suppliedSession) : undefined;
    if (session !== undefined && session.expiresAt <= Date.now()) sessions.delete(suppliedSession);
    const sessionAuthorized = session !== undefined && session.expiresAt > Date.now();
    if (!bearerAuthorized && !sessionAuthorized) {
      throw new AppError("authentication_required", "Sign in to the Buyer Console or provide a valid Bearer token", 401);
    }
    if (!bearerAuthorized && method !== "GET" && method !== "HEAD") {
      assertSameOrigin(request, host, {
        required: true,
        ...(publicDemo.enabled === true ? { expectedOrigin: publicDemo.publicOrigin } : {}),
      });
    }
  }

  return createServer(async (request, response) => {
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("x-frame-options", "DENY");
    response.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    if (publicDemo.enabled === true) response.setHeader("strict-transport-security", "max-age=86400; includeSubDomains");
    try {
      const url = new URL(request.url, "http://buyer.local");
      const method = request.method ?? "GET";
      const host = assertAllowedHost(request, allowedHostnames);
      if (method === "GET" && url.pathname === "/") {
        response.writeHead(302, { location: "/console/" });
        response.end();
        return;
      }
      if (method === "GET" && (url.pathname === "/console" || url.pathname === "/console/")) {
        response.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
        response.setHeader("cache-control", "no-store");
        await file(response, resolve(webDir, "index.html"));
        return;
      }
      if (method === "GET" && url.pathname === "/console/demo-product.jpeg" && demoProductImagePath !== null) {
        response.setHeader("content-security-policy", "default-src 'none'; sandbox");
        response.setHeader("cache-control", "public, max-age=3600");
        await file(response, demoProductImagePath);
        return;
      }
      const consoleMatch = url.pathname.match(/^\/console\/([a-zA-Z0-9._-]+)$/u);
      if (method === "GET" && consoleMatch) {
        const asset = resolve(webDir, consoleMatch[1]);
        if (!asset.startsWith(`${resolve(webDir)}${sep}`)) throw new AppError("not_found", "Route not found", 404);
        response.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
        response.setHeader("cache-control", "no-store");
        await file(response, asset);
        return;
      }
      if (method === "GET" && url.pathname === "/health") {
        json(response, 200, { ok: true, service: "autonomous-video-buyer" });
        return;
      }
      const uploadFileMatch = url.pathname.match(/^\/v1\/uploads\/([a-f0-9]{48}\.(?:jpg|png))$/u);
      if (method === "GET" && uploadFileMatch) {
        const selected = await resolveRegularFile(uploadDir, uploadFileMatch[1], "upload_not_found");
        response.writeHead(200, {
          "content-type": MIME[extname(selected.path).toLowerCase()],
          "content-length": selected.size,
          "cache-control": "private, no-store",
          "content-security-policy": "default-src 'none'; sandbox",
        });
        streamRegularFile(response, selected);
        return;
      }
      if (method === "POST" && url.pathname === "/v1/session") {
        limitLogin(request);
        assertSameOrigin(request, host, {
          required: true,
          ...(publicDemo.enabled === true ? { expectedOrigin: publicDemo.publicOrigin } : {}),
        });
        const input = await body(request);
        if (!secretEqual(input.token, apiToken)) {
          throw new AppError("authentication_failed", "Access token is invalid", 401);
        }
        const sessionToken = randomBytes(32).toString("base64url");
        const expiresAt = Date.now() + sessionLifetimeMs;
        sessions.set(sessionToken, { expiresAt });
        const secure = publicDemo.enabled === true || request.socket?.encrypted === true ? "; Secure" : "";
        const maxAge = Math.floor(sessionLifetimeMs / 1000);
        response.setHeader("set-cookie", `buyer_session=${encodeURIComponent(sessionToken)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`);
        json(response, 200, { authenticated: true, expiresAt: new Date(expiresAt).toISOString() });
        return;
      }
      if (method === "DELETE" && url.pathname === "/v1/session") {
        assertSameOrigin(request, host, {
          required: true,
          ...(publicDemo.enabled === true ? { expectedOrigin: publicDemo.publicOrigin } : {}),
        });
        const suppliedSession = parseCookies(request).buyer_session;
        if (typeof suppliedSession === "string") sessions.delete(suppliedSession);
        response.setHeader("set-cookie", "buyer_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
        json(response, 200, { authenticated: false });
        return;
      }
      if (url.pathname === "/ready" || url.pathname.startsWith("/v1/")) {
        limitApi(request);
        authorize(request, method, host);
        if (publicDemo.enabled === true && !["GET", "HEAD"].includes(method)) {
          limitPublicMutation(request, "public-demo-global");
        }
      }
      if (method === "GET" && url.pathname === "/ready") {
        const [buyer, delegationIntake] = await Promise.all([service.readiness(), intake.readiness()]);
        const readiness = {
          ready: buyer.ready && delegationIntake.ready,
          buyer,
          intake: delegationIntake,
          exposure: publicDemo.enabled === true ? {
            mode: "restricted_public_demo",
            paymentMode: "demo_simulated",
            realPaymentsDisabled: true,
            externalUrlsDisabled: true,
            maxDelegations: publicDemo.maxDelegations,
            quotaWindowMinutes: 60,
            quotaExcludedStates: [...PUBLIC_DEMO_QUOTA_EXCLUDED_STATES],
            maxRequestChars: publicDemo.maxRequestChars,
          } : { mode: "local_operator" },
        };
        json(response, readiness.ready ? 200 : 503, readiness);
        return;
      }
      if (method === "POST" && url.pathname === "/v1/uploads/product-image") {
        const uploadCutoff = Date.now() - PUBLIC_DEMO_QUOTA_WINDOW_MS;
        uploadsAcceptedAt = uploadsAcceptedAt.filter((acceptedAt) => acceptedAt >= uploadCutoff);
        if (uploadsAcceptedAt.length >= maxUploads) {
          throw new AppError("product_image_upload_limit", "The hourly product-image upload limit has been reached", 429);
        }
        const declaredType = String(request.headers["content-type"] ?? "").split(";", 1)[0].toLowerCase();
        const data = await binaryBody(request, maxProductImageBytes);
        const image = inspectProductImage(data, declaredType);
        const id = `${randomBytes(24).toString("hex")}.${image.extension}`;
        await mkdir(uploadDir, { recursive: true, mode: 0o700 });
        await writeFile(resolve(uploadDir, id), data, { mode: 0o600, flag: "wx" });
        uploadsAcceptedAt.push(Date.now());
        json(response, 201, { id, mediaType: image.mediaType, bytes: data.length, width: image.width, height: image.height });
        return;
      }
      if (method === "POST" && url.pathname === "/v1/delegations") {
        const input = await body(request);
        if (publicDemo.enabled === true) {
          validatePublicDemoDelegation(input, { maxRequestChars: publicDemo.maxRequestChars });
          const quota = publicDemoQuotaStatus(intake.listDelegations(100), {
            maxDelegations: publicDemo.maxDelegations,
          });
          if (quota.exhausted) {
            throw new AppError(
              "public_demo_quota_exhausted",
              `The hourly Demo limit has been reached. A slot reopens after ${quota.retryAt}`,
              429,
              quota,
            );
          }
        }
        if (typeof input.context?.referenceUploadId === "string") {
          const selected = await resolveRegularFile(uploadDir, input.context.referenceUploadId, "upload_not_found");
          await selected.handle.close();
        }
        json(response, 201, await intake.createDelegation({
          input,
          idempotencyKey: request.headers["idempotency-key"],
        }));
        return;
      }
      if (method === "GET" && url.pathname === "/v1/delegations") {
        const limit = Number(url.searchParams.get("limit") ?? 20);
        json(response, 200, { delegations: intake.listDelegations(Number.isSafeInteger(limit) ? limit : 20) });
        return;
      }
      const delegationMatch = url.pathname.match(/^\/v1\/delegations\/([^/]+)$/u);
      if (method === "GET" && delegationMatch) {
        json(response, 200, intake.getDelegation(decodeURIComponent(delegationMatch[1])));
        return;
      }
      const retryInterpretationMatch = url.pathname.match(/^\/v1\/delegations\/([^/]+)\/retry-interpretation$/u);
      if (method === "POST" && retryInterpretationMatch) {
        json(response, 200, await intake.retryInterpretation(decodeURIComponent(retryInterpretationMatch[1])));
        return;
      }
      const answersMatch = url.pathname.match(/^\/v1\/delegations\/([^/]+)\/answers$/u);
      if (method === "POST" && answersMatch) {
        const input = await body(request);
        if (publicDemo.enabled === true) rejectPublicDemoExternalUrls(input);
        json(response, 200, await intake.answerQuestions(
          decodeURIComponent(answersMatch[1]),
          input,
        ));
        return;
      }
      const confirmMandateMatch = url.pathname.match(/^\/v1\/delegations\/([^/]+)\/confirm$/u);
      if (method === "POST" && confirmMandateMatch) {
        json(response, 200, await intake.confirmMandate(
          decodeURIComponent(confirmMandateMatch[1]),
          await body(request),
        ));
        return;
      }
      const confirmPurchaseMatch = url.pathname.match(/^\/v1\/delegations\/([^/]+)\/confirm-purchase$/u);
      if (method === "POST" && confirmPurchaseMatch) {
        json(response, 200, await intake.confirmPurchase(decodeURIComponent(confirmPurchaseMatch[1])));
        return;
      }
      const syncDelegationMatch = url.pathname.match(/^\/v1\/delegations\/([^/]+)\/sync$/u);
      if (method === "POST" && syncDelegationMatch) {
        json(response, 200, await intake.syncDelegation(decodeURIComponent(syncDelegationMatch[1])));
        return;
      }
      const cancelDelegationMatch = url.pathname.match(/^\/v1\/delegations\/([^/]+)\/cancel$/u);
      if (method === "POST" && cancelDelegationMatch) {
        json(response, 200, await intake.cancelDelegation(decodeURIComponent(cancelDelegationMatch[1])));
        return;
      }
      const retryFulfillmentMatch = url.pathname.match(/^\/v1\/delegations\/([^/]+)\/retry-fulfillment$/u);
      if (method === "POST" && retryFulfillmentMatch) {
        json(response, 200, await intake.retryFulfillment(decodeURIComponent(retryFulfillmentMatch[1])));
        return;
      }
      const resolutionMatch = url.pathname.match(/^\/v1\/delegations\/([^/]+)\/request-resolution$/u);
      if (method === "POST" && resolutionMatch) {
        const input = await body(request);
        if (publicDemo.enabled === true) rejectPublicDemoExternalUrls(input);
        json(response, 200, await intake.requestResolution(
          decodeURIComponent(resolutionMatch[1]),
          input,
        ));
        return;
      }
      const delegationAuditMatch = url.pathname.match(/^\/v1\/delegations\/([^/]+)\/audit$/u);
      if (method === "GET" && delegationAuditMatch) {
        json(response, 200, { events: intake.audit(decodeURIComponent(delegationAuditMatch[1])) });
        return;
      }
      if (method === "POST" && url.pathname === "/v1/campaigns") {
        if (publicDemo.enabled === true) {
          throw new AppError("public_demo_route_disabled", "Direct Campaign creation is disabled in the public Demo", 403);
        }
        const input = await body(request);
        json(response, 201, await service.createCampaign({
          input,
          idempotencyKey: request.headers["idempotency-key"],
        }));
        return;
      }
      const packageMatch = url.pathname.match(/^\/v1\/campaigns\/([^/]+)\/package$/u);
      if (method === "GET" && packageMatch) {
        const campaign = service.getCampaign(decodeURIComponent(packageMatch[1]));
        if (campaign.package?.state !== "completed") throw new AppError("package_not_ready", "Campaign package is not ready", 409);
        json(response, 200, campaign.package);
        return;
      }
      const packageFileMatch = url.pathname.match(/^\/v1\/campaigns\/([^/]+)\/package\/files\/(.+)$/u);
      if (method === "GET" && packageFileMatch) {
        const campaignId = decodeURIComponent(packageFileMatch[1]);
        const relative = packageFileMatch[2].split("/").map(decodeURIComponent).join("/");
        const campaign = service.getCampaign(campaignId);
        const allowed = campaign.package?.files?.some((item) => item.path === relative);
        if (!allowed) throw new AppError("package_file_not_found", "Campaign package file not found", 404);
        const base = resolve(dataDir, "campaign-packages", campaignId.replace(/[^a-zA-Z0-9._-]/gu, "-"));
        const selected = await resolveRegularFile(base, relative, "package_file_not_found");
        response.writeHead(200, {
          "content-type": MIME[extname(selected.path).toLowerCase()] ?? "application/octet-stream",
          "content-length": selected.size,
          "content-disposition": `${selected.path.endsWith(".mp4") ? "inline" : "attachment"}; filename="${relative.split("/").at(-1).replaceAll('"', "")}"`,
          "content-security-policy": "default-src 'none'; sandbox",
        });
        streamRegularFile(response, selected);
        return;
      }
      const campaignMatch = url.pathname.match(/^\/v1\/campaigns\/([^/]+)$/u);
      if (method === "GET" && campaignMatch) {
        json(response, 200, service.getCampaign(decodeURIComponent(campaignMatch[1])));
        return;
      }
      const executeMatch = url.pathname.match(/^\/v1\/campaigns\/([^/]+)\/execute$/u);
      if (method === "POST" && executeMatch) {
        json(response, 200, await service.executeCampaign(decodeURIComponent(executeMatch[1])));
        return;
      }
      const syncMatch = url.pathname.match(/^\/v1\/campaigns\/([^/]+)\/sync$/u);
      if (method === "POST" && syncMatch) {
        json(response, 200, await service.syncCampaign(decodeURIComponent(syncMatch[1])));
        return;
      }
      const resumeMatch = url.pathname.match(/^\/v1\/campaigns\/([^/]+)\/resume$/u);
      if (method === "POST" && resumeMatch) {
        json(response, 200, await service.resumeCampaign(decodeURIComponent(resumeMatch[1])));
        return;
      }
      const auditMatch = url.pathname.match(/^\/v1\/campaigns\/([^/]+)\/audit$/u);
      if (method === "GET" && auditMatch) {
        json(response, 200, { events: service.audit(decodeURIComponent(auditMatch[1])) });
        return;
      }
      throw new AppError("not_found", "Route not found", 404);
    } catch (error) {
      const payload = errorPayload(error);
      if (payload.status === 500) console.error(error);
      json(response, payload.status, payload.body);
    }
  });
}
