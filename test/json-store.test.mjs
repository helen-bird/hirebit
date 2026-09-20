import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { acquireProcessLock, JsonStore } from "../src/json-store.mjs";

test("failed persistence never commits the draft to in-memory state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "json-store-durable-test-"));
  const store = new JsonStore(join(directory, "state.json"), { initialState: { value: 1 } });
  await store.initialize();
  await assert.rejects(store.transaction((draft) => {
    draft.value = 2;
    draft.notJson = 1n;
  }), TypeError);
  assert.deepEqual(store.snapshot(), { value: 1 });
});

test("process lock rejects a concurrent owner and can be reacquired after release", async () => {
  const directory = await mkdtemp(join(tmpdir(), "process-lock-test-"));
  const file = join(directory, "service.lock");
  const first = await acquireProcessLock(file);
  await assert.rejects(acquireProcessLock(file), (error) => error.code === "process_lock_held");
  await first.release();
  const second = await acquireProcessLock(file);
  await second.release();
});
