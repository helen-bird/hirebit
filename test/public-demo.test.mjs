import assert from "node:assert/strict";
import test from "node:test";

import { inspectProductImage, publicDemoQuotaStatus, validatePublicDemoDelegation } from "../src/buyer/server.mjs";

test("public Demo allows one safe reference video field and rejects other or unsafe URLs", () => {
  assert.doesNotThrow(() => validatePublicDemoDelegation({
    request: "Create a concise product launch video with a 3000 sats hard cap.",
    context: { platform: "TikTok", referenceVideoUrl: "https://www.tiktok.com/@creator/video/7461234567890123456" },
  }, { maxRequestChars: 1000 }));
  for (const input of [
    { request: "Create a product launch video from https://example.com/product.jpg" },
    { request: "Create a product launch video", context: { nested: { referenceUrl: "HTTP://example.com/a" } } },
    { request: "Create a product launch video", context: { platform: "TikTok", referenceVideoUrl: "http://127.0.0.1/reference.mp4" } },
    { request: "Create a product launch video", context: { platform: "TikTok", referenceVideoUrl: "https://www.youtube.com/shorts/dQw4w9WgXcQ" } },
  ]) {
    assert.throws(
      () => validatePublicDemoDelegation(input, { maxRequestChars: 1000 }),
      (error) => ["public_demo_external_url_disabled", "unsafe_external_url", "reference_video_channel_mismatch"].includes(error.code),
    );
  }
});

test("public Demo enforces a small request boundary before model use", () => {
  assert.throws(
    () => validatePublicDemoDelegation({ request: "short" }, { maxRequestChars: 1000 }),
    (error) => error.code === "invalid_public_demo_request",
  );
  assert.throws(
    () => validatePublicDemoDelegation({ request: "x".repeat(1001) }, { maxRequestChars: 1000 }),
    (error) => error.code === "invalid_public_demo_request",
  );
});

test("public Demo quota counts only non-declined work from the rolling hour", () => {
  const now = Date.parse("2026-09-21T12:00:00.000Z");
  const quota = publicDemoQuotaStatus([
    { state: "completed", createdAt: "2026-09-21T11:30:00.000Z" },
    { state: "clarification_required", createdAt: "2026-09-21T11:45:00.000Z" },
    { state: "declined", createdAt: "2026-09-21T11:50:00.000Z" },
    { state: "completed", createdAt: "2026-09-21T10:59:59.000Z" },
  ], { maxDelegations: 3, now });
  assert.deepEqual(quota, {
    used: 2,
    limit: 3,
    available: 1,
    exhausted: false,
    retryAt: null,
  });
});

test("public Demo quota reports when the oldest hourly slot reopens", () => {
  const now = Date.parse("2026-09-21T12:00:00.000Z");
  const quota = publicDemoQuotaStatus([
    { state: "completed", createdAt: "2026-09-21T11:10:00.000Z" },
    { state: "approval_required", createdAt: "2026-09-21T11:20:00.000Z" },
    { state: "clarification_required", createdAt: "2026-09-21T11:30:00.000Z" },
  ], { maxDelegations: 3, now });
  assert.equal(quota.exhausted, true);
  assert.equal(quota.retryAt, "2026-09-21T12:10:00.000Z");
});

test("product image inspection checks signature, declared type, and safe dimensions", () => {
  const png = Buffer.alloc(32);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(1200, 16);
  png.writeUInt32BE(1200, 20);
  assert.deepEqual(inspectProductImage(png, "image/png"), {
    mediaType: "image/png", extension: "png", width: 1200, height: 1200,
  });
  assert.throws(
    () => inspectProductImage(png, "image/jpeg"),
    (error) => error.code === "product_image_type_mismatch",
  );
  assert.throws(
    () => inspectProductImage(Buffer.alloc(64, 0x41), "image/png"),
    (error) => error.code === "product_image_invalid",
  );
});
