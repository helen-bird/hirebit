import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSellerServer } from "../src/server.mjs";

test("Seller refuses a completed artifact that changed after production", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "seller-artifact-integrity-"));
  const output = join(dataDir, "jobs", "ord_test", "outputs");
  await mkdir(output, { recursive: true });
  const original = Buffer.from("original video bytes");
  await writeFile(join(output, "final.mp4"), original);
  const artifact = {
    name: "final.mp4", bytes: original.length,
    sha256: createHash("sha256").update(original).digest("hex"),
  };
  const server = createSellerServer({
    service: { getOrder() { return { production: { state: "completed", result: { artifacts: [artifact] } } }; } },
    dataDir,
    apiToken: "test-only-seller-token",
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const url = `http://127.0.0.1:${server.address().port}/v1/orders/ord_test/artifacts/final.mp4`;
    const options = { headers: { authorization: "Bearer test-only-seller-token" } };
    const valid = await fetch(url, options);
    assert.equal(valid.status, 200);
    assert.deepEqual(Buffer.from(await valid.arrayBuffer()), original);
    await writeFile(join(output, "final.mp4"), Buffer.from("tampered video bytes"));
    const tampered = await fetch(url, options);
    assert.equal(tampered.status, 503);
    assert.equal((await tampered.json()).error.code, "seller_artifact_integrity_failed");
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});
