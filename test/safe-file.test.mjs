import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import test from "node:test";

import { resolveRegularFile, streamRegularFile } from "../src/safe-file.mjs";

test("safe file streaming transfers FileHandle ownership without a double close", async () => {
  const directory = await mkdtemp(join(tmpdir(), "safe-file-stream-"));
  try {
    const path = join(directory, "asset.css");
    await writeFile(path, "body { color: orange; }\n", "utf8");
    const selected = await resolveRegularFile(directory, "asset.css");
    const response = new PassThrough();
    const chunks = [];
    response.on("data", (chunk) => chunks.push(chunk));
    streamRegularFile(response, selected);
    await once(response, "end");
    assert.equal(Buffer.concat(chunks).toString("utf8"), "body { color: orange; }\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
