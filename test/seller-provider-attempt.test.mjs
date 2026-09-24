import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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

test("two workers racing to recover one stale lock cannot overlap supplier calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "seller-stale-lock-"));
  const path = join(root, "copy.attempt.json");
  await writeFile(`${path}.active`, JSON.stringify({ pid: 2147483647, token: "stale-owner" }));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const options = {
    path,
    identity: { format: "seller.copy-attempt@1", orderId: "ord_stale" },
    uncertainCode: "production_copy_submission_uncertain",
    beforeCall: async () => {},
    call: async () => { calls += 1; await gate; return { ok: true }; },
  };
  const first = callSellerProviderTwice(options);
  const second = callSellerProviderTwice(options);
  const results = Promise.allSettled([first, second]);
  try {
    for (let index = 0; index < 200 && calls === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(calls, 1);
  } finally {
    release();
  }
  const settled = await results;
  assert.equal(settled.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(settled.filter((item) => item.status === "rejected").length, 1);
  assert.equal(calls, 1);
});

test("failed finalization after a successful provider response cannot trigger another paid call", async () => {
  const root = await mkdtemp(join(tmpdir(), "seller-finalize-"));
  const path = join(root, "copy.attempt.json");
  let calls = 0;
  const options = {
    path,
    identity: { format: "seller.copy-attempt@1", orderId: "ord_finalize" },
    uncertainCode: "production_copy_submission_uncertain",
    beforeCall: async () => {},
    call: async () => { calls += 1; return { ok: true }; },
    finalize: async () => { throw new Error("disk full while saving output"); },
  };
  await assert.rejects(callSellerProviderTwice(options), /disk full/);
  await assert.rejects(callSellerProviderTwice(options), (error) => error.code === options.uncertainCode);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(await readFile(`${path}.provider-returned.json`, "utf8")).attempt, 1);
});
