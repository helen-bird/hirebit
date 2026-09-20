import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertAllowedHost,
  assertSameOrigin,
  assertExternalUrlResolvesPublic,
  loadOrCreateToken,
  resolvePublicDemoAccessToken,
  requireBearer,
  safeExternalUrl,
  safeSocialVideoUrl,
  secretEqual,
} from "../src/security.mjs";

test("API Bearer authentication uses a constant-time digest comparison", () => {
  const request = { headers: { authorization: `Bearer ${"a".repeat(32)}` } };
  assert.doesNotThrow(() => requireBearer(request, "a".repeat(32)));
  assert.throws(
    () => requireBearer(request, "b".repeat(32)),
    (error) => error.code === "authentication_required" && error.status === 401,
  );
  assert.equal(secretEqual("a".repeat(32), "a".repeat(32)), true);
  assert.equal(secretEqual("a".repeat(32), "b".repeat(32)), false);
});

test("reference video links match the selected social channel", () => {
  assert.equal(
    safeSocialVideoUrl("https://www.tiktok.com/@creator/video/7461234567890123456#share", "TikTok"),
    "https://www.tiktok.com/@creator/video/7461234567890123456",
  );
  assert.equal(
    safeSocialVideoUrl("https://www.instagram.com/reel/DFa1b2C3d4E/", "Instagram Reels"),
    "https://www.instagram.com/reel/DFa1b2C3d4E/",
  );
  assert.equal(
    safeSocialVideoUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ", "YouTube Shorts"),
    "https://www.youtube.com/shorts/dQw4w9WgXcQ",
  );
  assert.throws(
    () => safeSocialVideoUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ", "TikTok"),
    (error) => error.code === "reference_video_channel_mismatch",
  );
  assert.throws(
    () => safeSocialVideoUrl("https://youtube.example/shorts/dQw4w9WgXcQ", "YouTube Shorts"),
    (error) => error.code === "reference_video_channel_mismatch",
  );
});

test("generated API tokens and their directory are owner-only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "api-token-test-"));
  const file = join(directory, "private", "api-token");
  const first = await loadOrCreateToken({ file });
  const second = await loadOrCreateToken({ file });
  assert.equal(first.value, second.value);
  assert.ok(first.value.length >= 32);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, "private"))).mode & 0o777, 0o700);
});

test("short fixed access tokens are isolated to simulated public Demo mode", () => {
  assert.deepEqual(resolvePublicDemoAccessToken({
    enabled: true,
    paymentMode: "demo",
    value: "demo-token-123",
  }), { value: "demo-token-123", source: "public-demo-environment" });
  assert.equal(resolvePublicDemoAccessToken({ enabled: false, paymentMode: "gobtcpay" }), null);
  assert.throws(() => resolvePublicDemoAccessToken({
    enabled: true,
    paymentMode: "gobtcpay",
    value: "demo-token-123",
  }), (error) => error.code === "public_demo_payment_mode_invalid");
  assert.throws(() => resolvePublicDemoAccessToken({
    enabled: true,
    paymentMode: "demo",
    value: "short",
  }), (error) => error.code === "invalid_public_demo_token");
});

test("Host and external URL validation reject rebinding and private-network targets", () => {
  assert.doesNotThrow(() => assertAllowedHost({ headers: { host: "127.0.0.1:8788" } }, new Set(["127.0.0.1"])));
  assert.throws(
    () => assertAllowedHost({ headers: { host: "attacker.example" } }, new Set(["127.0.0.1"])),
    (error) => error.code === "host_not_allowed",
  );
  assert.equal(safeExternalUrl("https://example.com/proof", "proof"), "https://example.com/proof");
  for (const value of [
    "https://127.0.0.1/x",
    "https://169.254.169.254/x",
    "https://[::ffff:127.0.0.1]/x",
    "https://[::ffff:169.254.169.254]/x",
    "https://service.local/x",
    "http://example.com/x",
  ]) {
    assert.throws(() => safeExternalUrl(value, "proof"), (error) => error.code === "unsafe_external_url");
  }
});

test("proxied public writes require the exact configured HTTPS origin", () => {
  const request = {
    headers: { origin: "https://hirebit-demo.example.workers.dev" },
    socket: { encrypted: false },
  };
  assert.doesNotThrow(() => assertSameOrigin(request, "random.trycloudflare.com", {
    required: true,
    expectedOrigin: "https://hirebit-demo.example.workers.dev",
  }));
  assert.throws(
    () => assertSameOrigin({ ...request, headers: { origin: "https://attacker.example" } }, "random.trycloudflare.com", {
      required: true,
      expectedOrigin: "https://hirebit-demo.example.workers.dev",
    }),
    (error) => error.code === "origin_not_allowed",
  );
});

test("external URL DNS validation rejects names that resolve to private addresses", async () => {
  await assert.rejects(
    assertExternalUrlResolvesPublic(
      "https://public-looking.example/file",
      "proof",
      async () => [{ address: "169.254.169.254", family: 4 }],
    ),
    (error) => error.code === "unsafe_external_url",
  );
  assert.equal(await assertExternalUrlResolvesPublic(
    "https://public-looking.example/file",
    "proof",
    async () => [{ address: "93.184.216.34", family: 4 }],
  ), "https://public-looking.example/file");
});
