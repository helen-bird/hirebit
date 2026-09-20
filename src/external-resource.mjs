import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { writeFile, mkdir } from "node:fs/promises";
import { request } from "node:https";
import { extname, join } from "node:path";

import { AppError } from "./errors.mjs";
import { assertExternalUrlResolvesPublic } from "./security.mjs";

const ALLOWED_TYPES = ["video/", "image/", "audio/", "application/pdf", "application/octet-stream"];

function safeExtension(url, contentType) {
  const fromPath = extname(new URL(url).pathname).toLowerCase();
  if (/^\.[a-z0-9]{1,8}$/u.test(fromPath)) return fromPath;
  if (contentType.startsWith("video/")) return ".mp4";
  if (contentType.startsWith("image/")) return ".img";
  if (contentType.startsWith("audio/")) return ".audio";
  if (contentType === "application/pdf") return ".pdf";
  return ".bin";
}

async function pinnedTarget(value, label) {
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  await assertExternalUrlResolvesPublic(value, label, async () => addresses);
  const selected = addresses[0];
  return { url, address: selected.address, family: selected.family };
}

function oneRequest(target, { timeoutMs, maxBytes, label }) {
  return new Promise((resolvePromise, reject) => {
    const req = request(target.url, {
      method: "GET",
      headers: { accept: "video/*, image/*, audio/*, application/pdf, application/octet-stream" },
      servername: target.url.hostname.replace(/^\[|\]$/gu, ""),
      lookup: (_hostname, options, callback) => {
        if (options?.all === true) {
          callback(null, [{ address: target.address, family: target.family }]);
        } else {
          callback(null, target.address, target.family);
        }
      },
    }, (response) => {
      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.resume();
        resolvePromise({ redirect: response.headers.location ?? null });
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new AppError("external_resource_http_error", `${label} returned HTTP ${status}`, 502));
        return;
      }
      const contentType = String(response.headers["content-type"] ?? "application/octet-stream").split(";", 1)[0].toLowerCase();
      if (!ALLOWED_TYPES.some((allowed) => allowed.endsWith("/") ? contentType.startsWith(allowed) : contentType === allowed)) {
        response.resume();
        reject(new AppError("external_resource_type_rejected", `${label} returned unsupported content type ${contentType}`, 415));
        return;
      }
      const declared = Number(response.headers["content-length"] ?? 0);
      if (Number.isFinite(declared) && declared > maxBytes) {
        response.resume();
        reject(new AppError("external_resource_too_large", `${label} exceeds the ${maxBytes}-byte limit`, 413));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy(new AppError("external_resource_too_large", `${label} exceeds the ${maxBytes}-byte limit`, 413));
          return;
        }
        chunks.push(chunk);
      });
      response.once("end", () => resolvePromise({ data: Buffer.concat(chunks), contentType }));
      response.once("error", reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new AppError("external_resource_timeout", `${label} timed out`, 504)));
    req.once("error", (error) => reject(error instanceof AppError
      ? error
      : new AppError("external_resource_unavailable", `${label} could not be downloaded safely`, 502, { cause: error.message })));
    req.end();
  });
}

export async function downloadExternalResource(value, {
  directory,
  basename,
  label = "external resource",
  maxBytes = 25 * 1024 * 1024,
  timeoutMs = 30_000,
  maxRedirects = 3,
} = {}) {
  let current = value;
  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const target = await pinnedTarget(current, label);
    const result = await oneRequest(target, { timeoutMs, maxBytes, label });
    if (result.redirect !== undefined) {
      if (result.redirect === null || redirects === maxRedirects) {
        throw new AppError("external_resource_redirect_rejected", `${label} has an invalid or excessive redirect chain`, 502);
      }
      current = new URL(result.redirect, current).href;
      continue;
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const filename = `${basename}${safeExtension(current, result.contentType)}`;
    const path = join(directory, filename);
    await writeFile(path, result.data, { mode: 0o600 });
    return {
      path,
      filename,
      mediaType: result.contentType,
      bytes: result.data.length,
      sha256: createHash("sha256").update(result.data).digest("hex"),
      sourceHost: new URL(current).hostname,
    };
  }
  throw new AppError("external_resource_redirect_rejected", `${label} has an excessive redirect chain`, 502);
}
