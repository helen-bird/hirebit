import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { callSellerProviderTwice } from "../src/seller-provider-attempt.mjs";

test("concurrent workers cannot make duplicate supplier calls for the same Seller operation", async () => {
  const root = await mkdtemp(join(tmpdir(), "seller-attempt-"));
  const path = join(root, "copy.attempt.json");
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const options = {
    path,
    identity: { format: "seller.copy-attempt@1", orderId: "ord_1", commissionSha256: "a".repeat(64) },
    uncertainCode: "production_copy_submission_uncertain",
    beforeCall: async () => {},
    call: async () => { calls += 1; await gate; return { ok: true }; },
  };
  const first = callSellerProviderTwice(options);
  while (calls === 0) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(callSellerProviderTwice(options), (error) => error.code === options.uncertainCode);
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await first, { ok: true });
  assert.equal(JSON.parse(await readFile(path, "utf8")).attempt, 1);
});
