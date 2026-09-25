import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { callSellerProviderTwice, withSellerOperationLock } from "../src/seller-provider-attempt.mjs";

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

test("an orphan recovery claim and a second interrupted recovery can be reclaimed", async () => {
  const root = await mkdtemp(join(tmpdir(), "seller-orphan-recovery-"));
  const path = join(root, "copy.attempt.json");
  for (const suffix of [".active", ".active.recovery", ".active.recovery.recovery"]) {
    await writeFile(`${path}${suffix}`, JSON.stringify({ pid: 2147483647, token: suffix }));
  }
  const identity = { format: "seller.copy-attempt@1", orderId: "ord_recovery" };
  await writeFile(path, JSON.stringify({ ...identity, attempt: 1 }));
  const attempts = [];
  const options = {
    path, identity, uncertainCode: "production_copy_submission_uncertain",
    beforeCall: async () => {},
    call: async (attempt) => { attempts.push(attempt); return { ok: true }; },
  };
  assert.deepEqual(await callSellerProviderTwice(options), { ok: true });
  assert.deepEqual(attempts, [2]);
  await assert.rejects(callSellerProviderTwice(options), (error) => error.code === options.uncertainCode);
  assert.deepEqual(attempts, [2]);
  await assert.rejects(readFile(`${path}.active`), { code: "ENOENT" });
  await assert.rejects(readFile(`${path}.active.recovery`), { code: "ENOENT" });
});

test("a live recovery owner and invalid recovery records are never displaced", async () => {
  for (const recovery of [JSON.stringify({ pid: process.pid, token: "live-recovery" }), "", "null", JSON.stringify({ pid: 2147483647, token: "" })]) {
    const root = await mkdtemp(join(tmpdir(), "seller-protected-recovery-"));
    const path = join(root, "copy.attempt.json");
    const active = JSON.stringify({ pid: 2147483647, token: "dead-operation" });
    await writeFile(`${path}.active`, active);
    await writeFile(`${path}.active.recovery`, recovery);
    let calls = 0;
    await assert.rejects(withSellerOperationLock({ path, uncertainCode: "unsafe_recovery" }, async () => { calls += 1; }),
      (error) => error.code === "unsafe_recovery");
    assert.equal(calls, 0);
    assert.equal(await readFile(`${path}.active`, "utf8"), active);
    assert.equal(await readFile(`${path}.active.recovery`, "utf8"), recovery);
  }
});

test("concurrent reclaimers of orphan recovery claims preserve exclusive supplier ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "seller-racing-recovery-"));
  const path = join(root, "copy.attempt.json");
  for (const suffix of [".active", ".active.recovery"]) {
    await writeFile(`${path}${suffix}`, JSON.stringify({ pid: 2147483647, token: suffix }));
  }
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const options = {
    path, identity: { orderId: "ord_concurrent_recovery" }, uncertainCode: "unsafe_recovery",
    beforeCall: async () => {},
    call: async () => { calls += 1; await gate; return { ok: true }; },
  };
  const results = Promise.allSettled(Array.from({ length: 8 }, () => callSellerProviderTwice(options)));
  try {
    for (let index = 0; index < 200 && calls === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(calls, 1);
    const active = JSON.parse(await readFile(`${path}.active`, "utf8"));
    assert.equal(active.pid, process.pid);
    await assert.rejects(callSellerProviderTwice(options), (error) => error.code === "unsafe_recovery");
    assert.equal(JSON.parse(await readFile(`${path}.active`, "utf8")).token, active.token);
  } finally { release(); }
  const settled = await results;
  assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(calls, 1);
});

test("orphan recovery cannot reset exhausted supplier attempt markers", async () => {
  const root = await mkdtemp(join(tmpdir(), "seller-recovery-cap-"));
  const path = join(root, "copy.attempt.json");
  const identity = { orderId: "ord_exhausted" };
  await writeFile(path, JSON.stringify({ ...identity, attempt: 1 }));
  await writeFile(`${path}.retry-2.json`, JSON.stringify({ ...identity, attempt: 2 }));
  for (const suffix of [".active", ".active.recovery"]) {
    await writeFile(`${path}${suffix}`, JSON.stringify({ pid: 2147483647, token: suffix }));
  }
  let calls = 0;
  await assert.rejects(callSellerProviderTwice({
    path, identity, uncertainCode: "unsafe_recovery", beforeCall: async () => {},
    call: async () => { calls += 1; },
  }), /exhausted its two/);
  assert.equal(calls, 0);
  assert.equal(JSON.parse(await readFile(`${path}.retry-2.json`, "utf8")).attempt, 2);
});

test("supplier EEXIST propagates after releasing ownership instead of entering lock recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "seller-work-eexist-"));
  const path = join(root, "copy.attempt.json");
  const failure = Object.assign(new Error("supplier output already exists"), { code: "EEXIST" });
  let calls = 0;
  await assert.rejects(withSellerOperationLock({ path, uncertainCode: "unsafe_recovery" }, async () => {
    calls += 1;
    throw failure;
  }), (error) => error === failure);
  assert.equal(calls, 1);
  await assert.rejects(readFile(`${path}.active`), { code: "ENOENT" });
});

test("excessive orphan recovery depth fails closed without moving existing claims", async () => {
  const root = await mkdtemp(join(tmpdir(), "seller-recovery-depth-"));
  const path = join(root, "copy.attempt.json");
  for (let depth = 0; depth <= 16; depth += 1) {
    await writeFile(`${path}.active${".recovery".repeat(depth)}`, JSON.stringify({ pid: 2147483647, token: `dead-${depth}` }));
  }
  let calls = 0;
  await assert.rejects(withSellerOperationLock({ path, uncertainCode: "unsafe_recovery" }, async () => { calls += 1; }), /chain is too deep/);
  assert.equal(calls, 0);
  assert.equal(JSON.parse(await readFile(`${path}.active`, "utf8")).token, "dead-0");
});
