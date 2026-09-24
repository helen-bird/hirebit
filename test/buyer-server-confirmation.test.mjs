import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { createBuyerServer, pruneExpiredProductUploads } from "../src/buyer/server.mjs";

test("product-image cleanup removes seven-day-old unreferenced uploads only", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "buyer-upload-retention-"));
  const uploadDir = join(dataDir, "uploads");
  await mkdir(uploadDir);
  const expired = `${"a".repeat(48)}.jpg`;
  const protectedUpload = `${"b".repeat(48)}.png`;
  const fresh = `${"c".repeat(48)}.jpg`;
  const unrelated = "notes.txt";
  for (const id of [expired, protectedUpload, fresh, unrelated]) await writeFile(join(uploadDir, id), "data");
  const now = Date.now();
  const oldDate = new Date(now - 8 * 24 * 60 * 60 * 1000);
  for (const id of [expired, protectedUpload, unrelated]) await utimes(join(uploadDir, id), oldDate, oldDate);
  assert.equal(await pruneExpiredProductUploads(uploadDir, {
    protectedIds: new Set([protectedUpload]), now,
  }), 1);
  assert.deepEqual((await readdir(uploadDir)).sort(), [protectedUpload, fresh, unrelated].sort());
});

test("public startup cleanup preserves an image still referenced by an active delegation", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "buyer-upload-active-retention-"));
  const uploadDir = join(dataDir, "uploads");
  await mkdir(uploadDir);
  const active = `${"d".repeat(48)}.jpg`;
  const completed = `${"e".repeat(48)}.jpg`;
  for (const id of [active, completed]) {
    await writeFile(join(uploadDir, id), "data");
    const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(join(uploadDir, id), oldDate, oldDate);
  }
  const intake = { store: { snapshot: () => ({ delegations: {
    active: { state: "clarification_required", input: { context: { referenceUploadId: active } } },
    completed: { state: "completed", input: { context: { referenceUploadId: completed } } },
  } }) } };
  const server = createBuyerServer({
    service: {}, intake, dataDir, webDir: resolve(import.meta.dirname, "../web"),
    apiToken: "test-only-buyer-token",
    publicDemo: { enabled: true, publicOrigin: "https://buyer.example", maxDelegations: 1 },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (!(await readdir(uploadDir)).includes(completed)) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
    assert.deepEqual(await readdir(uploadDir), [active]);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

test("purchase confirmation HTTP route carries the displayed selection digest", async () => {
  const calls = [];
  const server = createBuyerServer({
    service: {},
    intake: {
      async confirmPurchase(id, selectionDigest) {
        calls.push({ id, selectionDigest });
        return { id, state: "awaiting_payment" };
      },
    },
    dataDir: await mkdtemp(join(tmpdir(), "buyer-confirm-http-")),
    webDir: resolve(import.meta.dirname, "../web"),
    apiToken: "test-only-buyer-token",
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const selectionDigest = "a".repeat(64);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/delegations/dlg_test/confirm-purchase`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-only-buyer-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ selectionDigest }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [{ id: "dlg_test", selectionDigest }]);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

test("package HTTP route refuses bytes that differ from the durable manifest", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "buyer-package-http-"));
  const packageDir = join(dataDir, "campaign-packages", "cmp_test", "creatives");
  await mkdir(packageDir, { recursive: true });
  const original = Buffer.from("original-media-bytes");
  const filePath = join(packageDir, "final.mp4");
  await writeFile(filePath, original);
  const fileRecord = {
    path: "creatives/final.mp4", bytes: original.length,
    sha256: createHash("sha256").update(original).digest("hex"),
  };
  const server = createBuyerServer({
    service: { getCampaign() { return { package: { state: "completed", files: [fileRecord] } }; } },
    intake: {}, dataDir, webDir: resolve(import.meta.dirname, "../web"),
    apiToken: "test-only-buyer-token",
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const url = `http://127.0.0.1:${server.address().port}/v1/campaigns/cmp_test/package/files/creatives/final.mp4`;
    const options = { headers: { authorization: "Bearer test-only-buyer-token" } };
    const valid = await fetch(url, options);
    assert.equal(valid.status, 200);
    assert.deepEqual(Buffer.from(await valid.arrayBuffer()), original);
    await writeFile(filePath, Buffer.from("tampered-media-bytes"));
    const tampered = await fetch(url, options);
    assert.equal(tampered.status, 503);
    assert.equal((await tampered.json()).error.code, "package_file_integrity_failed");
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

test("uploaded customer image cannot be fetched without Buyer authorization", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "buyer-upload-http-"));
  const filename = `${"a".repeat(48)}.jpg`;
  await mkdir(join(dataDir, "uploads"));
  await writeFile(join(dataDir, "uploads", filename), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const server = createBuyerServer({
    service: {}, intake: {}, dataDir, webDir: resolve(import.meta.dirname, "../web"),
    apiToken: "test-only-buyer-token",
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const url = `http://127.0.0.1:${server.address().port}/v1/uploads/${filename}`;
    assert.equal((await fetch(url)).status, 401);
    const authorized = await fetch(url, { headers: { authorization: "Bearer test-only-buyer-token" } });
    assert.equal(authorized.status, 200);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

test("public image-upload quota survives restart and concurrent requests", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "buyer-upload-quota-"));
  const png = Buffer.alloc(32);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(128, 16);
  png.writeUInt32BE(128, 20);
  const makeServer = () => createBuyerServer({
    service: {}, intake: {}, dataDir, webDir: resolve(import.meta.dirname, "../web"),
    apiToken: "test-only-buyer-token",
    publicDemo: { enabled: true, publicOrigin: "https://buyer.example", maxDelegations: 1 },
  });
  const post = (server) => fetch(`http://127.0.0.1:${server.address().port}/v1/uploads/product-image`, {
    method: "POST",
    headers: { authorization: "Bearer test-only-buyer-token", "content-type": "image/png" },
    body: png,
  });
  const first = makeServer();
  first.listen(0, "127.0.0.1");
  await once(first, "listening");
  try {
    const results = await Promise.all([post(first), post(first), post(first)]);
    assert.deepEqual(results.map((item) => item.status).sort(), [201, 201, 429]);
  } finally {
    await new Promise((resolveClose) => first.close(resolveClose));
  }
  const second = makeServer();
  second.listen(0, "127.0.0.1");
  await once(second, "listening");
  try {
    assert.equal((await post(second)).status, 429);
  } finally {
    await new Promise((resolveClose) => second.close(resolveClose));
  }
});
