import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ManagedProcess, retryDelay, makeLogger, probe, remainingAwakeSeconds, xml } from "../scripts/local-ops-lib.mjs";

test("retry backoff is bounded and keep-awake does not renew on restart", () => {
  assert.equal(retryDelay(1), 1000);
  assert.equal(retryDelay(100), 60_000);
  assert.equal(remainingAwakeSeconds("2026-09-29T00:00:00Z", Date.parse("2026-09-28T00:00:00Z")), 86400);
  assert.equal(remainingAwakeSeconds("2026-09-29T00:00:00Z", Date.parse("2026-09-30T00:00:00Z")), 0);
  assert.throws(() => remainingAwakeSeconds("bad"));
  assert.equal(xml("a&b<c>\"'"), "a&amp;b&lt;c&gt;&quot;&apos;");
});

test("health requires the correct service, not just HTTP 200", async () => {
  const response = (body, status = 200) => async () => Response.json(body, { status });
  assert.equal((await probe("https://example.test/health", "buyer", response({ ok: true, service: "buyer" }))).ok, true);
  assert.equal((await probe("https://example.test/health", "buyer", response({ ok: true, service: "seller" }))).ok, false);
  assert.equal((await probe("https://example.test/health", "buyer", response({ ok: true, service: "buyer" }, 503))).ok, false);
  assert.equal((await probe("https://example.test/health", "buyer", async () => new Response("<html>error</html>"))).ok, false);
});

test("logs are redacted, private, and rotated to a bounded set", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hirebit-ops-test-"));
  try {
    const file = join(dir, "services.log");
    const log = makeLogger(file, ["test-private-credential"], 200);
    for (let i = 0; i < 30; i++) log("test", "test-private-credential Bearer hidden-token");
    const names = await readdir(dir);
    assert.ok(names.length <= 4);
    for (const name of names) {
      const value = await readFile(join(dir, name), "utf8");
      assert.ok(!value.includes("test-private-credential"));
      assert.ok(!value.includes("hidden-token"));
      assert.equal((await stat(join(dir, name))).mode & 0o777, 0o600);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("owned process restarts after exit; stop cancels retries", async () => {
  const child = new ManagedProcess("test", process.execPath, ["-e", "process.exit(2)"], { log() {}, delay: () => 20 });
  try {
    child.start();
    const deadline = Date.now() + 5000;
    while (child.starts < 2 && Date.now() < deadline) await sleep(20);
    assert.ok(child.starts >= 2);
    await child.stop();
    const starts = child.starts;
    await sleep(100);
    assert.equal(child.starts, starts);
    assert.equal(child.status().pid, null);
  } finally { await child.stop(); }
});
