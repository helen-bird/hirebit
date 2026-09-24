import { createServer } from "node:http";
import { extname, resolve } from "node:path";

import { AppError, errorPayload } from "./errors.mjs";
import { resolveRegularFile, streamRegularFile, verifyRegularFileDigest } from "./safe-file.mjs";
import { assertAllowedHost, createRateLimiter, requireBearer } from "./security.mjs";

const MIME = {
  ".mp4": "video/mp4",
  ".json": "application/json",
  ".srt": "application/x-subrip",
  ".vtt": "text/vtt",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

function json(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
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

export function createSellerServer({
  service,
  dataDir,
  apiToken,
  allowedHostnames = new Set(["127.0.0.1", "localhost", "::1"]),
}) {
  if (typeof apiToken !== "string") throw new AppError("seller_api_token_missing", "Seller API token is required", 503);
  const limitApi = createRateLimiter({ max: 240 });
  return createServer(async (request, response) => {
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("x-frame-options", "DENY");
    try {
      const url = new URL(request.url, "http://seller.local");
      const method = request.method ?? "GET";
      assertAllowedHost(request, allowedHostnames);
      if (method === "GET" && url.pathname === "/health") {
        json(response, 200, { ok: true, service: "hypit-video-seller" });
        return;
      }
      if (method === "GET" && url.pathname === "/ready") {
        const readiness = await service.readiness();
        json(response, readiness.ready ? 200 : 503, readiness);
        return;
      }
      if (method === "GET" && url.pathname === "/v1/catalog") {
        json(response, 200, await service.catalog());
        return;
      }
      limitApi(request);
      requireBearer(request, apiToken);
      if (method === "POST" && url.pathname === "/v1/quotes") {
        json(response, 201, await service.createQuote(await body(request)));
        return;
      }
      if (method === "POST" && url.pathname === "/v1/orders") {
        const input = await body(request);
        const idempotencyKey = request.headers["idempotency-key"];
        json(response, 201, await service.createOrder({ quoteId: input.quoteId, idempotencyKey }));
        return;
      }
      const demoAuthorizeMatch = url.pathname.match(/^\/v1\/demo\/payments\/([^/]+)\/authorize$/u);
      if (method === "POST" && demoAuthorizeMatch) {
        json(response, 200, await service.authorizeDemoPayment(decodeURIComponent(demoAuthorizeMatch[1])));
        return;
      }
      const orderMatch = url.pathname.match(/^\/v1\/orders\/([^/]+)$/u);
      if (method === "GET" && orderMatch) {
        json(response, 200, service.getOrder(decodeURIComponent(orderMatch[1])));
        return;
      }
      const syncMatch = url.pathname.match(/^\/v1\/orders\/([^/]+)\/sync$/u);
      if (method === "POST" && syncMatch) {
        json(response, 200, await service.syncOrder(decodeURIComponent(syncMatch[1])));
        return;
      }
      const auditMatch = url.pathname.match(/^\/v1\/orders\/([^/]+)\/audit$/u);
      if (method === "GET" && auditMatch) {
        json(response, 200, { events: service.audit(decodeURIComponent(auditMatch[1])) });
        return;
      }
      const retryMatch = url.pathname.match(/^\/v1\/orders\/([^/]+)\/retry-production$/u);
      if (method === "POST" && retryMatch) {
        json(response, 200, await service.retryProduction(decodeURIComponent(retryMatch[1])));
        return;
      }
      const cancelMatch = url.pathname.match(/^\/v1\/orders\/([^/]+)\/request-cancellation$/u);
      if (method === "POST" && cancelMatch) {
        json(response, 200, await service.requestCancellation(decodeURIComponent(cancelMatch[1])));
        return;
      }
      const artifactMatch = url.pathname.match(/^\/v1\/orders\/([^/]+)\/artifacts\/([^/]+)$/u);
      if (method === "GET" && artifactMatch) {
        const orderId = decodeURIComponent(artifactMatch[1]);
        const filename = decodeURIComponent(artifactMatch[2]);
        const order = service.getOrder(orderId);
        const artifact = order.production.result?.artifacts?.find((item) => item.name === filename);
        if (!artifact || order.production.state !== "completed") throw new AppError("artifact_not_found", "Artifact not found", 404);
        const base = resolve(dataDir, "jobs", orderId, "outputs");
        const file = await resolveRegularFile(base, filename, "artifact_not_found");
        if (artifact.sha256 !== undefined || artifact.bytes !== undefined) {
          await verifyRegularFileDigest(file, artifact.sha256, artifact.bytes, "seller_artifact_integrity_failed");
        }
        response.writeHead(200, {
          "content-type": MIME[extname(file.path).toLowerCase()] ?? "application/octet-stream",
          "content-length": file.size,
          "content-disposition": `inline; filename="${filename.replaceAll('"', '')}"`,
          "content-security-policy": "default-src 'none'; sandbox",
        });
        streamRegularFile(response, file);
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
